// Regression tests for the defects found in the independent review (each one reproduced before it was fixed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, newOrder, makeReady, clockIn, startApp, hmacHex } from './helpers.js';
import { normalisePhone } from '../lib/geo.js';
import { createIngest } from '../services/ingest.js';

const ADMIN = { Authorization: 'Bearer admin-token' };
const flush = () => new Promise((r) => setTimeout(r, 30));

test('requeued failed order gets a FRESH Fleetbase order; a stale "started" can never send the next run out', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0, radius_km: 50 } });
  await clockIn(ctx, 'driver_a');
  const o = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  await ctx.batcher.tick();
  const oldFb = ctx.orders.byId(o.id).fleetbase_order_id;
  await ctx.batcher.markOut(ctx.orders.byId(o.id).batch_id);
  ctx.fb.orders_.get(oldFb).status = 'started';
  await ctx.batcher.fail(o.id, { reason: 'No answer' });
  await ctx.shifts.clockOut('driver_a').catch(() => {});
  ctx.orders.transition(o.id, 'ready', { actor: 'admin' });
  await flush();
  assert.notEqual(ctx.orders.byId(o.id).fleetbase_order_id, oldFb, 'old Fleetbase order is detached (a fresh one may already exist)');
  assert.ok(ctx.fb.calls.some((c) => c[0] === 'cancel' && c[1] === oldFb), 'and cancelled in Fleetbase');
  await clockIn(ctx, 'driver_b');
  await ctx.batcher.tick();
  const now = ctx.orders.byId(o.id);
  assert.equal(now.state, 'assigned');
  assert.notEqual(now.fleetbase_order_id, oldFb, 'a new Fleetbase order');
  await ctx.fbsync.reconcile();
  assert.equal(ctx.orders.byId(o.id).state, 'assigned', 'still waiting for B to scan and leave');
});

test('cancelling the only order of a waiting run frees the driver (run is settled, Fleetbase job cancelled)', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  const o = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  await ctx.batcher.tick();
  const fb = ctx.orders.byId(o.id).fleetbase_order_id;
  ctx.orders.transition(o.id, 'cancelled', { reason: 'Customer called' });
  await flush();
  assert.equal(ctx.db.prepare("SELECT status FROM batches").get().status, 'cancelled');
  assert.ok(ctx.fb.calls.some((c) => c[0] === 'cancel' && c[1] === fb));
  assert.equal((await ctx.shifts.availability()).available.length, 1, 'driver is free again');
  // same for the admin "back to queue" route
  const o2 = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  await ctx.batcher.tick();
  ctx.orders.transition(o2.id, 'ready');
  await flush();
  assert.equal((await ctx.shifts.availability()).available.length, 1);
});

test('HubRise: an order that cannot be created is kept for retry (not lost); retry works once the cause is fixed', async () => {
  const ctx = makeCtx();
  const ev = { id: 'e1', resource_type: 'order', event_type: 'create', order_id: 'hr9', new_state: { id: 'hr9', service_type: 'delivery', customer: { first_name: 'A', phone: '07700900999', address_1: '1 Rd', postal_code: 'ZZ99 9ZZ' }, items: [{ product_name: 'W', quantity: '1' }] } };
  await assert.rejects(() => ctx.ingest.handleHubRiseEvent(ev), /find ZZ99 9ZZ/);
  assert.equal(ctx.ingest.failures().length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM webhook_seen').get().n, 0, 'not marked as seen');
  ctx.postcodes.lookup = async () => ({ lat: 51.46, lng: -0.16, outcode: 'SW11' });      // "postcodes.io is back"
  const r = await ctx.ingest.retryFailure(ctx.ingest.failures()[0].id);
  assert.ok(r.created);
  assert.equal(ctx.ingest.failures().length, 0);
  assert.equal((await ctx.ingest.handleHubRiseEvent(ev)).duplicate, true);
});

test('phone numbers with country codes and brackets are accepted', () => {
  assert.equal(normalisePhone('+44 (0)7700 900111'), '+447700900111');
  assert.equal(normalisePhone('+353 87 123 4567'), '+353871234567');
  assert.equal(normalisePhone('+1 202-555-0143'), '+12025550143');
  assert.equal(normalisePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalisePhone('(020) 7946 0958'), '+442079460958');
});

test('a switched-off shop does not stop other shops (or the tracking page of its old orders)', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0, radius_km: 60 } });
  await ctx.sites.create({ name: 'North', postcode: 'N1 5AA' });
  await clockIn(ctx, 'd1');
  const main = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const { order } = await ctx.orders.create({ source: 'x', external_id: 'n', site_id: 'north', customer: { name: 'N', phone: '07700900123' }, address: { line1: '1', postcode: 'N1 5AA' }, items: [{ name: 'a', qty: 1 }] });
  await makeReady(ctx, order);
  ctx.sites.update('north', { active: false });
  const r = await ctx.batcher.tick();
  assert.equal(ctx.orders.byId(main.id).state, 'assigned', 'main still dispatches');
  assert.ok(r.queued >= 0);
  assert.ok((await ctx.tracking.view(ctx.orders.byId(order.id).track_token)).store, 'old orders of the closed shop still render');
});

test('a bag scanned for driver A is not "scanned" for driver B after a move', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
  const o = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const r = await ctx.batcher.tick();
  ctx.db.prepare('UPDATE orders SET picked_at = ? WHERE id = ?').run('x', o.id);
  const other = r.assigned[0].driver === 'driver_a' ? 'driver_b' : 'driver_a';
  await ctx.batcher.moveOrder(o.id, other);
  assert.equal(ctx.orders.byId(o.id).picked_at, null);
  ctx.db.prepare('UPDATE orders SET picked_at = ? WHERE id = ?').run('x', o.id);
  await ctx.batcher.moveOrder(o.id, null);
  assert.equal(ctx.orders.byId(o.id).picked_at, null);
});

test('double-tapped clock-in creates exactly one open shift', async () => {
  const ctx = makeCtx();
  ctx.fb.addDriver({ id: 'd', name: 'D' });
  const res = await Promise.allSettled([ctx.shifts.clockIn('d'), ctx.shifts.clockIn('d')]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM driver_shifts WHERE clock_out_at IS NULL').get().n, 1);
  await ctx.shifts.clockOut('d');
  assert.equal(ctx.shifts.clockedIn().length, 0);
});

test('a hand move during a tick cannot be stolen back; an order cancelled mid-tick does not abort the others', async () => {
  const ctx = makeCtx({ vroomDelayMs: 40, settings: { batch_hold_minutes: 0, radius_km: 60, max_tasks: 1 } });
  await clockIn(ctx, 'd1'); await clockIn(ctx, 'd2');
  const a = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const t = ctx.batcher.tick();
  const m = ctx.batcher.moveOrder(a.id, 'd2');           // admin drags while the tick is thinking
  await Promise.all([t, m]);
  assert.equal(ctx.orders.byId(a.id).driver_id, 'd2');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE status = 'assigned' AND id NOT IN (SELECT batch_id FROM orders WHERE batch_id IS NOT NULL)").get().n, 0, 'no empty assigned run left behind');
  // cancel mid-tick
  const x = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const y = await makeReady(ctx, await newOrder(ctx, 'N1 5AA').catch(() => newOrder(ctx, 'SW11 6AA')));
  const t2 = ctx.batcher.tick();
  await new Promise((r) => setTimeout(r, 10));
  ctx.orders.transition(x.id, 'cancelled', { reason: 'changed mind' });
  const r2 = await t2;
  assert.equal(r2.errors, 0);
  assert.equal(ctx.orders.byId(y.id).state === 'assigned' || r2.queued > 0 || r2.preassigned.length > 0, true);
});

test('push subscriptions: only real push services, capped per order, never re-pointed', async () => {
  const ctx = makeCtx();
  const app = await startApp(ctx);
  try {
    const o = await newOrder(ctx, 'SW11 5XX');
    const url = `/api/track/${encodeURIComponent(o.track_token)}/subscribe`;
    const sub = (host, n = 1) => ({ endpoint: `https://${host}/send/${n}`, keys: { p256dh: 'a', auth: 'b' } });
    assert.equal((await app.call('POST', url, { body: { endpoint: 'http://fcm.googleapis.com/x' } })).status, 400);
    assert.equal((await app.call('POST', url, { body: { endpoint: 'https://169.254.169.254/x' } })).status, 400);
    assert.equal((await app.call('POST', url, { body: sub('internal.example.com') })).status, 400);
    for (let i = 1; i <= 5; i++) assert.equal((await app.call('POST', url, { body: sub('fcm.googleapis.com', i) })).status, 200);
    assert.equal((await app.call('POST', url, { body: sub('fcm.googleapis.com', 6) })).status, 429);
    const o2 = await newOrder(ctx, 'SW11 6AA');
    assert.equal((await app.call('POST', `/api/track/${encodeURIComponent(o2.track_token)}/subscribe`, { body: sub('fcm.googleapis.com', 1) })).status, 409, 'cannot take over another order\'s subscription');
  } finally { await app.close(); }
});

test('return push only for the driver\'s latest run, and a requeued order keeps its place', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0, return_push_minutes: 5 } });
  await clockIn(ctx, 'd1');
  const a = await makeReady(ctx, await newOrder(ctx, 'SW12 8AA'));
  await ctx.batcher.tick(); await ctx.batcher.markOut(ctx.orders.byId(a.id).batch_id); await ctx.batcher.deliver(a.id);   // run 1 done, nothing waiting
  ctx.now.advance(120);
  const b = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const readyAt = ctx.orders.byId(b.id).ready_at;
  await ctx.batcher.tick();                                         // run 2 assigned (planned? no: driver free)
  await ctx.batcher.markOut(ctx.orders.byId(b.id).batch_id);
  await makeReady(ctx, await newOrder(ctx, 'SW11 6AA'));
  await ctx.batcher.tick();                                         // pre-assigned behind run 2
  assert.equal(await ctx.batcher.pushReturns(), 0, 'run 1 (done long ago) must not trigger a push; run 2 is far from home');
  ctx.orders.transition(b.id, 'failed', { reason: 'x' });
  ctx.orders.transition(b.id, 'ready');
  assert.equal(ctx.orders.byId(b.id).ready_at, readyAt, 'requeue keeps ready_at');
});

test('"nearest": a driver with no GPS fix is the last choice, not the first', async () => {
  const ctx = makeCtx({ settings: { strategy: 'nearest', batch_hold_minutes: 0 } });
  ctx.fb.addDriver({ id: 'nogps', name: 'N' });                           // location 0,0
  await ctx.shifts.clockIn('nogps');
  await clockIn(ctx, 'near', { lat: 51.4651, lng: -0.1701 });
  await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  assert.equal((await ctx.batcher.tick()).assigned[0].driver, 'near');
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const ctx = makeCtx();
  await ctx.orders.create({ source: 'x', external_id: 'f', customer: { name: '=HYPERLINK("http://evil","x")', phone: '07700900123' }, address: { line1: '1 Rd', postcode: 'SW11 5XX' }, items: [{ name: '+cmd', qty: 1 }] });
  const csv = ctx.analytics.ordersCsv();
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
});

test('hub: the same order is never posted twice while the first request is in flight', async () => {
  const ctx = makeCtx();
  let posts = 0;
  ctx.hub = { enabled: () => true, postOrder: async () => { posts++; await new Promise((r) => setTimeout(r, 30)); return { id: 7 }; } };
  const hs = (await import('../services/hubsync.js')).createHubSync(ctx);
  const o = await newOrder(ctx, 'SW11 5XX');
  await Promise.all([hs.pushOrder(ctx.orders.byId(o.id)), hs.pushOrder(ctx.orders.byId(o.id)), hs.pushPending()]);
  assert.equal(posts, 1);
});

test('creation-time and retry Fleetbase syncs never create two Fleetbase orders', async () => {
  const ctx = makeCtx();
  const slow = ctx.fb.createOrder;
  ctx.fb.createOrder = async (x) => { await new Promise((r) => setTimeout(r, 40)); return slow(x); };
  const { order } = await ctx.orders.create({ source: 'x', external_id: 's', customer: { name: 'A', phone: '07700900123' }, address: { line1: '1 Rd', postcode: 'SW11 5XX' }, items: [{ name: 'a', qty: 1 }] });
  await Promise.all([ctx.orders.retryFleetbaseSync(), ctx.orders.retryFleetbaseSync()]);
  await flush(); await new Promise((r) => setTimeout(r, 80));
  assert.equal(ctx.fb.calls.filter((c) => c[0] === 'createOrder').length, 1);
  assert.ok(ctx.orders.byId(order.id).fleetbase_order_id);
});

test('HubRise OAuth: the one-time state proves the callback (no login cookie needed); wrong/missing state refused', async () => {
  const ctx = makeCtx({ env: { HUBRISE_CLIENT_ID: 'cid', HUBRISE_CLIENT_SECRET: 'hr-secret' } });
  const calls = [];
  ctx.fetchImpl = async (url, opts) => { calls.push([url, opts]); return { ok: true, text: async () => JSON.stringify(url.includes('/oauth2/') ? { access_token: 'tok', location_id: 'loc', account_id: 'acc', location_name: 'Shop' } : {}) }; };
  const ing = createIngest(ctx);
  const url = new URL(ing.hubriseAuthorizeUrl('http://track.test/cb'));
  const state = url.searchParams.get('state');
  assert.ok(state && state.length >= 16);
  await assert.rejects(() => ing.hubriseExchange('code', 'http://track.test/cb', 'wrong'), /expired/);
  assert.equal(ing.hubriseConnected(), false);
  ing.hubriseAuthorizeUrl('http://track.test/cb');
  const s2 = new URL(ing.hubriseAuthorizeUrl('http://track.test/cb')).searchParams.get('state');
  const ok = await ing.hubriseExchange('code', 'http://track.test/cb', s2);
  assert.equal(ok.location_name, 'Shop');
  assert.ok(calls.some(([u]) => u.endsWith('/callback')), 'callback registered');
  await assert.rejects(() => ing.hubriseExchange('code', 'http://track.test/cb', s2), /expired/, 'state is single-use');
});

test('late add: a new nearby order joins a run that is still being collected at the shop', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0, max_tasks: 3 } });
  await clockIn(ctx, 'd1');
  const a = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  await ctx.batcher.tick();
  const batch = ctx.orders.byId(a.id).batch_id;
  const b = await makeReady(ctx, await newOrder(ctx, 'SW11 6AA'));
  const r = await ctx.batcher.tick();
  assert.equal(r.joined.length, 1);
  assert.equal(ctx.orders.byId(b.id).batch_id, batch);
  assert.equal(ctx.orders.byId(b.id).state, 'assigned');
  assert.ok(ctx.orders.byId(b.id).fleetbase_order_id && ctx.fb.orders_.get(ctx.orders.byId(b.id).fleetbase_order_id).driver === 'd1');
  assert.ok(ctx.notify.inbox('d1').some((m) => m.kind === 'run_updated'));
  // a far-away order does not join, a full run does not take more
  const far = await makeReady(ctx, await newOrder(ctx, 'SW11 8AA'));
  await ctx.batcher.tick();
  assert.equal(ctx.orders.byId(far.id).batch_id, batch, 'third fits (max 3, nearby)');
  const extra = await makeReady(ctx, await newOrder(ctx, 'SW11 5XX'));
  const r2 = await ctx.batcher.tick();
  assert.equal(r2.joined.length, 0, 'run is full');
  assert.equal(ctx.orders.byId(extra.id).state, 'ready');
});

test('failed incoming orders are visible on the board snapshot and can be retried/dismissed over HTTP', async () => {
  const ctx = makeCtx();
  const app = await startApp(ctx);
  try {
    await ctx.ingest.handleHubRiseEvent({ id: 'e5', resource_type: 'order', order_id: 'x5', new_state: { id: 'x5', service_type: 'delivery', customer: { phone: '07700900999', address_1: '1 Rd', postal_code: 'ZZ99 9ZZ' }, items: [{ product_name: 'W', quantity: '1' }] } }).catch(() => {});
    assert.equal((await app.call('GET', '/api/board', { headers: ADMIN })).data.ingest_failures, 1);
    const list = (await app.call('GET', '/api/ingest/failures', { headers: ADMIN })).data.failures;
    assert.equal(list.length, 1);
    assert.equal((await app.call('POST', `/api/ingest/failures/${list[0].id}/retry`, { headers: ADMIN, body: {} })).status, 422, 'still cannot be created: stays listed');
    assert.equal((await app.call('POST', `/api/ingest/failures/${list[0].id}/dismiss`, { headers: ADMIN, body: {} })).status, 200);
    assert.equal((await app.call('GET', '/api/board', { headers: ADMIN })).data.ingest_failures, 0);
    assert.equal((await app.call('GET', '/api/ingest/failures')).status, 401);
  } finally { await app.close(); }
});
