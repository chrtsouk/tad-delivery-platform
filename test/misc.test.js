import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeCtx, newOrder, makeReady, clockIn, startApp } from './helpers.js';
import { createFleetbase, createOsrm, createVroom, createPostcodes, createPhoton, createHub } from '../lib/clients.js';
import { normalisePostcode, normalisePhone, haversineKm } from '../lib/geo.js';
import { sign, verify } from '../lib/tokens.js';

/* ---- helpers: a tiny fake HTTP server that records requests ---- */
async function fakeServer(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = handler(req, body);
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('geo: postcodes and phones are normalised the same way everywhere', () => {
  assert.deepEqual(normalisePostcode('sw11 1ab'), { postcode: 'SW11 1AB', outcode: 'SW11' });
  assert.equal(normalisePostcode('EC1A1BB').outcode, 'EC1A');
  assert.throws(() => normalisePostcode('hello'), /does not look like a UK postcode/);
  assert.equal(normalisePhone('07700 900111'), '+447700900111');
  assert.equal(normalisePhone('+44 7700 900111'), '+447700900111');
  assert.equal(normalisePhone('00447700900111'), '+447700900111');
  assert.equal(normalisePhone(''), null);
  assert.throws(() => normalisePhone('12'), /phone/);
  assert.ok(Math.abs(haversineKm({ lat: 51.5, lng: 0 }, { lat: 51.5, lng: 0.1 }) - 6.9) < 0.3);
});

test('tracking tokens: tampering is detected', () => {
  const t = sign('s', 'TAD-20261015-001');
  assert.equal(verify('s', t), 'TAD-20261015-001');
  assert.equal(verify('s', t.replace('001', '002')), null);
  assert.equal(verify('other', t), null);
  assert.equal(verify('s', 'nodot'), null);
});

test('Fleetbase client sends the API key as a Bearer token and the order as JSON', async () => {
  const s = await fakeServer((req) => (req.url.startsWith('/v1/orders') ? { json: { id: 'order_1' } } : { json: [] }));
  try {
    const fb = createFleetbase({ url: s.url, apiKey: 'flb_live_x' });
    const o = await fb.createOrder({ pickup: 'place_a', dropoff: 'place_b' });
    assert.equal(o.id, 'order_1');
    assert.equal(s.seen[0].headers.authorization, 'Bearer flb_live_x');
    assert.equal(JSON.parse(s.seen[0].body).type, 'transport');
    await fb.assign('order_1', 'driver_9');
    assert.deepEqual(JSON.parse(s.seen[1].body), { driver: 'driver_9' });
    await assert.rejects(() => createFleetbase({ url: s.url, apiKey: '' }).drivers(), /API key is not set/);
  } finally { await s.close(); }
});

test('OSRM, VROOM, postcodes.io and Photon clients speak the real wire formats', async () => {
  const s = await fakeServer((req, body) => {
    if (req.url.startsWith('/route/v1/driving/')) return { json: { code: 'Ok', routes: [{ duration: 321, distance: 4500 }] } };
    if (req.url.startsWith('/table/v1/driving/')) return { json: { durations: [[0, 5], [5, 0]] } };
    if (req.method === 'POST' && req.url === '/') return { json: { code: 0, routes: [{ vehicle: 1, duration: 900, steps: [{ type: 'start', arrival: 0 }, { type: 'job', id: 7, arrival: 300, duration: 300, service: 180 }, { type: 'end', arrival: 900 }] }], unassigned: [{ id: 8 }] } };
    if (req.url.startsWith('/postcodes/SW111AB')) return { json: { status: 200, result: { postcode: 'SW11 1AB', outcode: 'SW11', latitude: 51.46, longitude: -0.17, admin_district: 'Wandsworth', region: 'London' } } };
    if (req.url.startsWith('/postcodes/NOPE')) return { status: 404, json: { status: 404, error: 'Postcode not found' } };
    if (req.url.startsWith('/api?')) return { json: { features: [{ geometry: { coordinates: [-0.17, 51.46] }, properties: { housenumber: '12', street: 'Lavender Hill', city: 'London', postcode: 'SW11 1AB', countrycode: 'GB' } }, { geometry: { coordinates: [2, 48] }, properties: { name: 'Paris', countrycode: 'FR' } }] } };
    return { status: 404 };
  });
  try {
    const osrm = createOsrm({ url: s.url });
    assert.deepEqual(await osrm.route({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }), { seconds: 321, metres: 4500 });
    assert.ok(s.seen[0].url.includes('/route/v1/driving/2,1;4,3'), 'lng,lat order');
    assert.deepEqual(await osrm.table([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]), [[0, 5], [5, 0]]);

    const vroom = createVroom({ url: s.url });
    const sol = await vroom.solve({ vehicles: [{ id: 1, start: { lat: 51, lng: 0 }, capacity: 3, max_tasks: 3 }], jobs: [{ id: 7, loc: { lat: 51.1, lng: 0.1 }, service: 180 }] });
    const sent = JSON.parse(s.seen.find((x) => x.method === 'POST').body);
    assert.deepEqual(sent.vehicles[0].start, [0, 51]);
    assert.deepEqual(sent.jobs[0].location, [0.1, 51.1]);
    assert.deepEqual(sol.routes[0].stops, [{ job: 7, arrival: 300, duration: 300, service: 180 }]);
    assert.deepEqual(sol.unassigned, [8]);

    const pc = createPostcodes({ url: s.url });
    const hit = await pc.lookup('SW11 1AB');
    assert.equal(hit.outcode, 'SW11');
    assert.equal(await pc.lookup('NOPE'), null);

    const ph = createPhoton({ url: s.url });
    const r = await ph.search('12 lavender', { near: { lat: 51.46, lng: -0.17 } });
    assert.equal(r.length, 1, 'non-GB result dropped');
    assert.equal(r[0].label, '12 Lavender Hill, London, SW11 1AB');
  } finally { await s.close(); }
});

test('hub client authenticates with the hub token; hub sync pushes orders and applies ready events', async () => {
  const s = await fakeServer((req) => (req.method === 'POST' ? { json: { ok: true, id: 501 } } : { json: { events: [{ entity: 'kitchen_order', entity_id: 501, field: 'status', new: 'ready' }], next_cursor: 9 } }));
  try {
    const ctx = makeCtx();
    ctx.hub = createHub({ url: s.url, token: 'tad_key' });
    ctx.hubsync = (await import('../services/hubsync.js')).createHubSync(ctx);
    const o = await newOrder(ctx, 'SW11 5XX');
    await ctx.hubsync.pushOrder(ctx.orders.byId(o.id));
    assert.equal(s.seen[0].headers.authorization, 'Bearer tad_key');
    assert.equal(JSON.parse(s.seen[0].body).external_ref, o.number);
    assert.equal(ctx.orders.byId(o.id).hub_order_id, '501');
    ctx.orders.transition(o.id, 'accepted');
    assert.equal(await ctx.hubsync.pollEvents(), 1);
    assert.equal(ctx.orders.byId(o.id).state, 'ready');
    assert.equal(ctx.db.prepare("SELECT data FROM integrations WHERE name='hub_cursor'").get().data, '9');
  } finally { await s.close(); }
});

test('upstream failures surface as readable errors, never crash', async () => {
  const osrm = createOsrm({ url: 'http://127.0.0.1:1' });
  await assert.rejects(() => osrm.route({ lat: 1, lng: 1 }, { lat: 2, lng: 2 }), /Could not reach/);
});

test('service area: owner radius is mirrored to Fleetbase, updated not duplicated', async () => {
  const ctx = makeCtx({ settings: { radius_km: 4 } });
  await ctx.fleetbaseConfig.syncServiceArea();
  ctx.settings.set({ radius_km: 6 });
  await ctx.fleetbaseConfig.syncServiceArea();
  assert.equal(ctx.fb.areas_.size, 1);
  assert.equal([...ctx.fb.areas_.values()][0].radius, 6000);
});

test('settings validate; excluded postcode districts stop orders', async () => {
  const ctx = makeCtx();
  assert.throws(() => ctx.settings.set({ max_tasks: 0 }), /max_tasks/);
  assert.throws(() => ctx.settings.set({ strategy: 'random' }), /strategy/);
  assert.throws(() => ctx.settings.set({ nonsense: 1 }), /Unknown setting/);
  ctx.settings.set({ excluded_outcodes: ['SW4'] });
  await assert.rejects(() => newOrder(ctx, 'SW4 7XX'), /do not deliver to SW4/);
});

test('pre-orders are held until their time, then released into the flow', async () => {
  const ctx = makeCtx({ settings: { prep_minutes: 15, default_eta_minutes: 40 } });
  const when = new Date(ctx.now().getTime() + 3 * 3600000).toISOString();
  const o = await newOrder(ctx, 'SW11 5XX', { scheduled_for: when });
  assert.equal(o.state, 'scheduled');
  assert.equal(ctx.orders.releaseScheduled().length, 0);
  assert.equal(ctx.fb.calls.filter((c) => c[0] === 'createOrder').length, 0, 'not in Fleetbase yet');
  ctx.now.advance(140);
  assert.equal(ctx.orders.releaseScheduled().length, 0);
  ctx.now.advance(10);
  assert.equal(ctx.orders.releaseScheduled().length, 1);
  assert.equal(ctx.orders.byId(o.id).state, 'new');
  await ctx.orders.retryFleetbaseSync();
  assert.ok(ctx.orders.byId(o.id).fleetbase_order_id);
});

test('collection orders never reach Fleetbase or the batcher; they are collected from the counter', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a');
  const { order } = await ctx.orders.create({ source: 'own-site', external_id: 'c1', fulfilment: 'collection', customer: { name: 'Col', phone: '07700900888' }, items: [{ name: 'Wings', qty: 1 }] });
  ctx.orders.transition(order.id, 'accepted'); ctx.orders.transition(order.id, 'ready');
  const r = await ctx.batcher.tick();
  assert.equal(r.assigned.length, 0);
  assert.equal(ctx.fb.calls.filter((c) => c[0] === 'createOrder').length, 0);
  assert.equal(ctx.orders.transition(order.id, 'collected').state, 'collected');
});

test('illegal state changes are refused', async () => {
  const ctx = makeCtx();
  const o = await newOrder(ctx, 'SW11 5XX');
  assert.throws(() => ctx.orders.transition(o.id, 'delivered'), /cannot become/);
  assert.throws(() => ctx.orders.transition(o.id, 'cancelled'), /reason/);
  assert.throws(() => ctx.orders.transition(o.id, 'collected'), /cannot become|Only collection/);
});

test('order numbers are unique and sequential per day', async () => {
  const ctx = makeCtx();
  const a = await newOrder(ctx, 'SW11 5XX'), b = await newOrder(ctx, 'SW11 5XX');
  assert.match(a.number, /-001$/); assert.match(b.number, /-002$/);
  ctx.now.advance(24 * 60);
  assert.match((await newOrder(ctx, 'SW11 5XX')).number, /-001$/);
});

test('driver token: wrong token never matches, reissuing invalidates the old one', async () => {
  const ctx = makeCtx();
  const t1 = ctx.shifts.issueToken('driver_a');
  assert.equal(ctx.shifts.driverFromToken(t1), 'driver_a');
  const t2 = ctx.shifts.issueToken('driver_a');
  assert.equal(ctx.shifts.driverFromToken(t1), null);
  assert.equal(ctx.shifts.driverFromToken(t2), 'driver_a');
  assert.equal(ctx.shifts.driverFromToken('x'), null);
  assert.equal(ctx.shifts.driverFromToken(undefined), null);
});

test('login is rate limited after repeated wrong passwords', async () => {
  const ctx = makeCtx();
  const app = await startApp(ctx);
  try {
    let last;
    for (let i = 0; i < 6; i++) last = await app.call('POST', '/api/login', { body: { password: 'wrong' } });
    assert.equal(last.status, 429);
    assert.equal((await app.call('POST', '/api/login', { body: { password: 'pw-test' } })).status, 429, 'even the right one waits');
  } finally { await app.close(); }
});
