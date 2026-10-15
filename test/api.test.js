import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeCtx, startApp, clockIn, hmacHex } from './helpers.js';

const ADMIN = { Authorization: 'Bearer admin-token' };
const body = (extra = {}) => ({
  external_id: `ext-${Math.random()}`, customer: { name: 'Sam', phone: '07700 900222', email: 'sam@example.com' },
  address: { line1: '9 High St', postcode: 'sw11 5xx' }, items: [{ name: 'Wings', qty: 2 }], ...extra,
});

async function setup(opts) {
  const ctx = makeCtx(opts);
  const app = await startApp(ctx);
  return { ctx, ...app };
}

test('admin sign-in: wrong password refused, right password gives a cookie, API needs it', async () => {
  const { call, close } = await setup();
  try {
    assert.equal((await call('GET', '/api/settings')).status, 401);
    assert.equal((await call('POST', '/api/login', { body: { password: 'nope' } })).status, 401);
    const ok = await call('POST', '/api/login', { body: { password: 'pw-test' } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('GET', '/api/settings', { cookie })).status, 200);
    assert.equal((await call('GET', '/api/settings', { headers: ADMIN })).status, 200);
    assert.equal((await call('GET', '/api/settings', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally { await close(); }
});

test('own-website ingest needs the key, is idempotent, rejects outside the area, and returns a tracking link', async () => {
  const { call, close } = await setup();
  try {
    const b = body();
    assert.equal((await call('POST', '/api/ingest/own', { body: b })).status, 401);
    const r = await call('POST', '/api/ingest/own', { body: b, headers: { 'X-TAD-Key': 'site-key' } });
    assert.equal(r.status, 201);
    assert.match(r.data.number, /^TAD-\d{8}-001$/);
    assert.match(r.data.tracking_url, /^http:\/\/track\.test\/t\/TAD-/);
    const again = await call('POST', '/api/ingest/own', { body: b, headers: { 'X-TAD-Key': 'site-key' } });
    assert.equal(again.data.duplicate, true);
    const far = await call('POST', '/api/ingest/own', { body: body({ address: { line1: 'x', postcode: 'N1 5AA' } }), headers: { 'X-TAD-Key': 'site-key' } });
    assert.equal(far.status, 422);
    assert.equal(far.data.code, 'outside_area');
    const bad = await call('POST', '/api/ingest/own', { body: body({ address: { line1: 'x', postcode: 'nonsense' } }), headers: { 'X-TAD-Key': 'site-key' } });
    assert.equal(bad.status, 400);
  } finally { await close(); }
});

test('full flow over HTTP: add order -> accept -> ready -> batcher -> driver scans, starts, delivers -> customer tracking', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    await clockIn(ctx, 'driver_a');
    const token = (await call('POST', '/api/drivers/driver_a/token', { headers: ADMIN })).data.token;
    const D = { Authorization: `Bearer ${token}` };

    const created = await call('POST', '/api/orders', { headers: ADMIN, body: { customer: { name: 'Sam', phone: '07700 900222' }, address: { line1: '9 High St', postcode: 'SW11 5XX' }, items: [{ name: 'Wings', qty: 2 }] } });
    assert.equal(created.status, 201);
    const o = created.data.order;
    assert.equal((await call('POST', `/api/orders/${o.id}/transition`, { headers: ADMIN, body: { to: 'accepted' } })).status, 200);
    assert.equal((await call('POST', `/api/orders/${o.id}/transition`, { headers: ADMIN, body: { to: 'ready' } })).status, 200);
    await ctx.batcher.tick();

    const run = await call('GET', '/driver/run', { headers: D });
    assert.equal(run.data.batch.status, 'assigned');
    assert.equal(run.data.orders[0].number, o.number);

    // wrong bag, bad code, right bag
    assert.equal((await call('POST', '/driver/scan', { headers: D, body: { code: 'hello' } })).data.code, 'bad_code');
    assert.equal((await call('POST', '/driver/scan', { headers: D, body: { code: 'TAD|TAD-20250101-999' } })).status, 404);
    const start1 = await call('POST', '/driver/run/start', { headers: D, body: {} });
    assert.equal(start1.status, 409);
    assert.equal(start1.data.code, 'bags_not_scanned');
    const scan = await call('POST', '/driver/scan', { headers: D, body: { code: `TAD|${o.number}` } });
    assert.equal(scan.data.all_scanned, true);
    assert.equal((await call('POST', '/driver/run/start', { headers: D, body: {} })).status, 200);

    const t = await call('GET', `/api/track/${encodeURIComponent(o.track_token)}`);
    assert.equal(t.status, 200);
    assert.equal(t.data.state, 'out');
    assert.equal(t.data.queue_position, 1);
    assert.ok(t.data.eta_minutes >= 1);
    assert.equal(t.data.steps.find((s) => s.current).key, 'out');

    assert.equal((await call('POST', `/driver/orders/${o.id}/delivered`, { headers: D })).status, 200);
    const done = await call('GET', `/api/track/${encodeURIComponent(o.track_token)}`);
    assert.equal(done.data.state, 'delivered');
    assert.equal(done.data.can_rate, true);
    assert.equal((await call('POST', `/api/track/${encodeURIComponent(o.track_token)}/rate`, { body: { rating: 5 } })).data.rating, 5);
    assert.equal((await call('GET', '/api/track/TAD-20250101-001.forged')).status, 404);
  } finally { await close(); }
});

test("another driver's bag is refused at the scan", async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0, max_tasks: 1, radius_km: 50 } });
  try {
    await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
    const ta = (await call('POST', '/api/drivers/driver_a/token', { headers: ADMIN })).data.token;
    const tb = (await call('POST', '/api/drivers/driver_b/token', { headers: ADMIN })).data.token;
    for (const pc of ['SW11 5XX', 'N1 5AA']) {
      const r = await call('POST', '/api/orders', { headers: ADMIN, body: body({ address: { line1: 'x st', postcode: pc } }) });
      await call('POST', `/api/orders/${r.data.order.id}/transition`, { headers: ADMIN, body: { to: 'accepted' } });
      await call('POST', `/api/orders/${r.data.order.id}/transition`, { headers: ADMIN, body: { to: 'ready' } });
    }
    await ctx.batcher.tick();
    const runA = (await call('GET', '/driver/run', { headers: { Authorization: `Bearer ${ta}` } })).data;
    const runB = (await call('GET', '/driver/run', { headers: { Authorization: `Bearer ${tb}` } })).data;
    const wrong = await call('POST', '/driver/scan', { headers: { Authorization: `Bearer ${ta}` }, body: { code: `TAD|${runB.orders[0].number}` } });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.data.code, 'wrong_bag');
    assert.equal((await call('POST', '/driver/scan', { headers: { Authorization: `Bearer ${ta}` }, body: { code: `TAD|${runA.orders[0].number}` } })).status, 200);
    assert.equal((await call('POST', `/driver/orders/${runB.orders[0].id}/delivered`, { headers: { Authorization: `Bearer ${ta}` } })).status, 403);
  } finally { await close(); }
});

test('driver clock in / out over HTTP, with a bad token refused', async () => {
  const { ctx, call, close } = await setup();
  try {
    ctx.fb.addDriver({ id: 'driver_z', name: 'Zed' });
    const tok = (await call('POST', '/api/drivers/driver_z/token', { headers: ADMIN })).data.token;
    const D = { Authorization: `Bearer ${tok}` };
    assert.equal((await call('GET', '/driver/me', { headers: { Authorization: 'Bearer x' } })).status, 401);
    assert.equal((await call('POST', '/driver/clock-in', { headers: D, body: {} })).status, 200);
    assert.equal((await call('POST', '/driver/clock-in', { headers: D, body: {} })).status, 409);
    assert.equal((await call('GET', '/driver/me', { headers: D })).data.clocked_in, true);
    assert.equal(ctx.fb.drivers_.get('driver_z').online, true);
    assert.equal((await call('POST', '/driver/clock-out', { headers: D })).status, 200);
    assert.equal(ctx.fb.drivers_.get('driver_z').online, false);
  } finally { await close(); }
});

test('HubRise callback: bad signature refused, good one creates the order once (retries are ignored)', async () => {
  const { ctx, call, close } = await setup();
  try {
    ctx.ingest = ctx.ingest;  // real
    const ev = { id: 'evt1', resource_type: 'order', event_type: 'create', order_id: 'hr1', new_state: {
      id: 'hr1', service_type: 'delivery', status: 'new', total: '23.50 GBP', customer_notes: 'ring twice',
      customer: { first_name: 'Ann', last_name: 'Lee', phone: '07700900333', address_1: '4 Park Rd', postal_code: 'SW11 6AA' },
      items: [{ product_name: 'Wings', sku_name: 'Hot', quantity: '2', price: '9.00 GBP' }], payments: [{ type: 'online' }] } };
    const raw = JSON.stringify(ev);
    const bad = await call('POST', '/api/ingest/hubrise/callback', { raw, headers: { 'Content-Type': 'application/json', 'X-HubRise-Hmac-SHA256': 'deadbeef' } });
    assert.equal(bad.status, 401);
    const good = await call('POST', '/api/ingest/hubrise/callback', { raw, headers: { 'Content-Type': 'application/json', 'X-HubRise-Hmac-SHA256': hmacHex('hr-secret', raw) } });
    assert.equal(good.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const rows = ctx.orders.list({ states: ['new'] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'hubrise');
    assert.equal(rows[0].total_pence, 2350);
    assert.equal(rows[0].customer_phone, '+447700900333');
    assert.equal(rows[0].items[0].name, 'Wings – Hot');
    await call('POST', '/api/ingest/hubrise/callback', { raw, headers: { 'Content-Type': 'application/json', 'X-HubRise-Hmac-SHA256': hmacHex('hr-secret', raw) } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.orders.list({ states: ['new'] }).length, 1);
    // cancellation update
    const upd = { id: 'evt2', resource_type: 'order', event_type: 'update', order_id: 'hr1', new_state: { ...ev.new_state, status: 'cancelled' } };
    const rawU = JSON.stringify(upd);
    await call('POST', '/api/ingest/hubrise/callback', { raw: rawU, headers: { 'Content-Type': 'application/json', 'X-HubRise-Hmac-SHA256': hmacHex('hr-secret', rawU) } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ctx.db.prepare("SELECT state FROM orders WHERE external_id='hr1'").get().state, 'cancelled');
  } finally { await close(); }
});

test('direct platform adapters are inert until switched on', async () => {
  const { call, close } = await setup();
  try {
    for (const p of ['ubereats', 'deliveroo', 'justeat']) {
      const r = await call('POST', `/api/ingest/${p}/webhook`, { raw: '{}', headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 404, p);
      assert.equal(r.data.code, 'not_enabled');
    }
  } finally { await close(); }
});

test('an enabled platform adapter verifies the signature and creates an order', async () => {
  const { ctx, call, close } = await setup({ env: { DELIVEROO_ENABLED: 'true', DELIVEROO_WEBHOOK_SECRET: 'dv-secret' } });
  try {
    const ev = { event: 'order.new', body: { order: { id: 'dv-1', delivery: { address: { address1: '2 Elm Rd', post_code: 'SW11 8AA' } }, customer: { first_name: 'Jo', contact_number: '07700900444' }, items: [{ name: 'Burger', quantity: 1 }] } } };
    const raw = JSON.stringify(ev);
    assert.equal((await call('POST', '/api/ingest/deliveroo/webhook', { raw, headers: { 'X-Signature': 'bad' } })).status, 401);
    const ok = await call('POST', '/api/ingest/deliveroo/webhook', { raw, headers: { 'X-Signature': hmacHex('dv-secret', raw) } });
    assert.equal(ok.status, 200);
    assert.equal(ctx.orders.list({ states: ['new'] })[0].source, 'deliveroo');
  } finally { await close(); }
});

test('hub webhook: signed "ready" from the kitchen pass moves our order to Ready; stale or forged calls refused', async () => {
  const { ctx, call, close } = await setup();
  try {
    const { order } = await ctx.orders.create({ source: 'own-site', external_id: 'h1', customer: { name: 'A', phone: '07700900555' }, address: { line1: '1 Rd', postcode: 'SW11 5XX' }, items: [{ name: 'W', qty: 1 }] });
    ctx.db.prepare("UPDATE orders SET hub_order_id = '77' WHERE id = ?").run(order.id);
    const payload = JSON.stringify({ entity: 'kitchen_order', entity_id: 77, field: 'status', new: 'ready' });
    const ts = String(Math.floor(ctx.now().getTime() / 1000));
    const sig = `sha256=${hmacHex('hub-secret', `${ts}.${payload}`)}`;
    assert.equal((await call('POST', '/api/hub/webhook', { raw: payload, headers: { 'x-tad-timestamp': ts, 'x-tad-signature': 'sha256=00' } })).status, 401);
    assert.equal((await call('POST', '/api/hub/webhook', { raw: payload, headers: { 'x-tad-timestamp': String(Number(ts) - 3600), 'x-tad-signature': `sha256=${hmacHex('hub-secret', `${Number(ts) - 3600}.${payload}`)}` } })).status, 401, 'old timestamp');
    const ok = await call('POST', '/api/hub/webhook', { raw: payload, headers: { 'x-tad-timestamp': ts, 'x-tad-signature': sig } });
    assert.equal(ok.data.changed, true);
    assert.equal(ctx.orders.byId(order.id).state, 'ready');
  } finally { await close(); }
});

test('board snapshot has SLA flags, late orders go red; shop close removes failed orders', async () => {
  const { ctx, call, close } = await setup({ settings: { late_after_minutes: 30, warn_after_minutes: 20 } });
  try {
    const r = await call('POST', '/api/orders', { headers: ADMIN, body: body() });
    const id = r.data.order.id;
    await call('POST', `/api/orders/${id}/transition`, { headers: ADMIN, body: { to: 'accepted' } });
    let b = (await call('GET', '/api/board', { headers: ADMIN })).data;
    assert.equal(b.orders[0].sla, 'ok');
    ctx.now.advance(22);
    b = (await call('GET', '/api/board', { headers: ADMIN })).data;
    assert.equal(b.orders[0].sla, 'warn');
    ctx.now.advance(10);
    b = (await call('GET', '/api/board', { headers: ADMIN })).data;
    assert.equal(b.orders[0].sla, 'late');
    // failed -> shop closes -> removed
    await clockIn(ctx, 'driver_a');
    await call('POST', `/api/orders/${id}/transition`, { headers: ADMIN, body: { to: 'ready' } });
    ctx.settings.set({ batch_hold_minutes: 0 });
    await ctx.batcher.tick();
    await ctx.batcher.markOut(ctx.orders.byId(id).batch_id);
    assert.equal((await call('POST', `/api/orders/${id}/transition`, { headers: ADMIN, body: { to: 'failed' } })).status, 400, 'reason needed');
    await call('POST', `/api/orders/${id}/transition`, { headers: ADMIN, body: { to: 'failed', reason: 'No answer' } });
    const closed = await call('POST', '/api/shop/close', { headers: ADMIN });
    assert.equal(closed.data.removed.length, 1);
    assert.equal(ctx.orders.byId(id).state, 'removed');
    assert.equal(ctx.settings.get('open'), false);
  } finally { await close(); }
});

test('label: number appears as text AND inside the QR payload; print goes to a (fake) network printer', async () => {
  const { ctx, call, close } = await setup();
  const net = await import('node:net');
  const got = [];
  const printer = net.createServer((s) => { s.on('data', (d) => got.push(d)); s.on('end', () => s.end()); });
  await new Promise((r) => printer.listen(0, '127.0.0.1', r));
  try {
    const r = await call('POST', '/api/orders', { headers: ADMIN, body: body() });
    const o = r.data.order;
    const html = await call('GET', `/api/orders/${o.id}/label`, { headers: ADMIN });
    assert.ok(html.data.includes(o.number), 'human readable');
    const svg = await call('GET', `/api/orders/${o.id}/label.svg`, { headers: ADMIN });
    assert.ok(svg.data.startsWith('<?xml') || svg.data.includes('<svg'));
    assert.equal((await call('POST', `/api/orders/${o.id}/print`, { headers: ADMIN })).status, 503, 'no printer configured');
    const res = await ctx.labels.print(ctx.orders.byId(o.id), { host: '127.0.0.1', port: printer.address().port });
    assert.equal(res.printed, o.number);
    await new Promise((r) => setTimeout(r, 100));
    const bytes = Buffer.concat(got);
    assert.ok(bytes.includes(Buffer.from(o.number)), 'number in printed text');
    assert.ok(bytes.includes(Buffer.from(`TAD|${o.number}`)), 'number in QR payload');
  } finally { printer.close(); await close(); }
});

test('customer notifications: accepted / out / delivered reach the inbox and email', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    await clockIn(ctx, 'driver_a');
    const r = await call('POST', '/api/ingest/own', { headers: { 'X-TAD-Key': 'site-key' }, body: body() });
    const o = ctx.orders.byNumber(r.data.number);
    ctx.orders.transition(o.id, 'accepted'); ctx.orders.transition(o.id, 'ready');
    await ctx.batcher.tick();
    await ctx.batcher.markOut(ctx.orders.byId(o.id).batch_id);
    await ctx.batcher.deliver(o.id);
    await new Promise((r2) => setTimeout(r2, 50));
    const inbox = await call('GET', `/api/track/${encodeURIComponent(o.track_token)}/inbox`);
    assert.deepEqual(inbox.data.messages.map((m) => m.kind).sort(), ['accepted', 'delivered', 'out']);
    assert.equal(ctx.emails.length, 3);
    assert.match(ctx.emails[0].text, /http:\/\/track\.test\/t\//);
  } finally { await close(); }
});

test('address search: address book first, then postcode lookup', async () => {
  const { call, close } = await setup();
  try {
    await call('POST', '/api/orders', { headers: ADMIN, body: body({ external_id: undefined }) });
    const byPhone = await call('GET', '/api/address/search?phone=07700%20900222', { headers: ADMIN });
    assert.equal(byPhone.data.results[0].from, 'address_book');
    assert.equal(byPhone.data.results[0].postcode, 'SW11 5XX');
    const byPc = await call('GET', '/api/address/search?q=SW12%208AA', { headers: ADMIN });
    assert.ok(byPc.data.results.some((r) => r.from === 'postcode' && r.lat));
    // second order from same phone+postcode bumps uses instead of duplicating
    await call('POST', '/api/orders', { headers: ADMIN, body: body({ external_id: undefined }) });
    const again = await call('GET', '/api/address/search?phone=07700900222', { headers: ADMIN });
    assert.equal(again.data.results.length, 1);
    assert.equal(again.data.results[0].uses, 2);
  } finally { await close(); }
});

test('analytics: end of day, driver performance (no money), demand, audit', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    await clockIn(ctx, 'driver_a');
    const r = await call('POST', '/api/orders', { headers: ADMIN, body: body() });
    const id = r.data.order.id;
    ctx.orders.transition(id, 'accepted'); ctx.orders.transition(id, 'ready');
    await ctx.batcher.tick();
    await ctx.batcher.markOut(ctx.orders.byId(id).batch_id);
    ctx.now.advance(12);
    await ctx.batcher.deliver(id);
    const day = ctx.now().toISOString().slice(0, 10);
    const eod = (await call('GET', `/api/analytics/end-of-day?day=${day}`, { headers: ADMIN })).data;
    assert.equal(eod.delivered, 1);
    assert.equal(eod.on_time_pct, 100);
    assert.equal(eod.drivers[0].deliveries, 1);
    assert.equal(eod.drivers[0].avg_pickup_to_drop_min, 12);
    assert.ok(!JSON.stringify(eod).match(/earn|pay|wage|cash/i), 'no money fields');
    const d = (await call('GET', '/api/analytics/demand', { headers: ADMIN })).data;
    assert.equal(d.total, 1);
    assert.equal(d.points.features.length, 1);
    assert.ok(d.by_area.find((a) => a.outcode === 'SW11'));
    const a = (await call('GET', '/api/audit', { headers: ADMIN })).data.events;
    assert.ok(a.some((e) => e.action === 'batch.assigned'));
  } finally { await close(); }
});

test('GDPR erase blanks the person but keeps the order record', async () => {
  const { ctx, call, close } = await setup();
  try {
    const r = await call('POST', '/api/orders', { headers: ADMIN, body: body() });
    const out = await call('POST', '/api/privacy/erase', { headers: ADMIN, body: { phone: '07700 900222' } });
    assert.equal(out.data.orders, 1);
    const o = ctx.orders.byId(r.data.order.id);
    assert.equal(o.customer_phone, null);
    assert.equal(o.customer_name, null);
    assert.equal(o.postcode, 'SW11 5XX');
    assert.equal((await call('GET', '/api/address/search?phone=07700900222', { headers: ADMIN })).data.results.length, 0);
  } finally { await close(); }
});

test('public quote and status for the owner\'s own ordering site', async () => {
  const { ctx, call, close } = await setup({ settings: { fee_bands: [{ up_to_km: 2, fee_pence: 199 }, { up_to_km: 5, fee_pence: 349 }] } });
  try {
    const near = await call('GET', '/api/public/quote?postcode=SW11%205XX');
    assert.equal(near.data.deliverable, true);
    assert.equal(near.data.fee_pence, 199);
    const far = await call('GET', '/api/public/quote?postcode=E1%206AN');
    assert.equal(far.data.deliverable, false);
    assert.equal((await call('GET', '/api/public/status')).data.open, true);
    assert.equal(ctx.settings.get('open'), true);
    void crypto;
  } finally { await close(); }
});

test('postcode lookup for the settings page (shop location) and SPA/unknown API routes', async () => {
  const { call, close } = await setup();
  try {
    const r = await call('GET', '/api/geo/postcode?postcode=sw12%208aa', { headers: ADMIN });
    assert.equal(r.data.postcode, 'SW12 8AA');
    assert.ok(r.data.lat);
    assert.equal((await call('GET', '/api/geo/postcode?postcode=zz99%209zz', { headers: ADMIN })).status, 404);
    assert.equal((await call('GET', '/api/geo/postcode?postcode=nonsense', { headers: ADMIN })).status, 400);
    assert.equal((await call('GET', '/api/nope', { headers: ADMIN })).status, 404);
    assert.equal((await call('GET', '/api/geo/postcode?postcode=E1%206AN')).status, 401);
  } finally { await close(); }
});
