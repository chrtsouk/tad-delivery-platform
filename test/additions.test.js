import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, startApp, clockIn, newOrder, makeReady } from './helpers.js';

const ADMIN = { Authorization: 'Bearer admin-token' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
async function setup(opts) { const ctx = makeCtx(opts); const app = await startApp(ctx); return { ctx, ...app }; }
const manual = (extra = {}) => ({ customer: { name: 'Sam', phone: '07700 900222' }, address: { line1: '9 High St', postcode: 'SW11 5XX' }, items: [{ name: 'Wings', qty: 2 }], ...extra });
const driverHeaders = async (ctx, call, id) => ({ Authorization: `Bearer ${(await call('POST', `/api/drivers/${id}/token`, { headers: ADMIN })).data.token}` });

/* ------------------------------------------------------------------ 1. GPS trails */
test('trails: pings are kept per run, throttled, queued batches accepted, bad coordinates refused', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    await clockIn(ctx, 'driver_a');
    const D = await driverHeaders(ctx, call, 'driver_a');
    const o = await makeReady(ctx, await newOrder(ctx, 'SW115XX'));
    await ctx.batcher.tick();
    const batch = ctx.orders.byId(o.id).batch_id;
    assert.ok(batch);

    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 51.465, lng: -0.17 } })).data.kept, 1);
    ctx.now.advance(0.02);                                                       // 1.2 s later: too soon
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 51.4651, lng: -0.1701 } })).data.kept, 0);
    ctx.now.advance(0.2);
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 51.466, lng: -0.168 } })).data.kept, 1);
    // standing still: the same spot a few seconds on is not stored again
    ctx.now.advance(0.2);
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 51.466, lng: -0.168 } })).data.kept, 0);
    // offline phone sends its queue; points older than now are stamped as given
    const t0 = ctx.now().getTime();
    const q = [1, 2, 3].map((i) => ({ lat: 51.47 + i * 0.001, lng: -0.16, at: new Date(t0 - (4 - i) * 30000).toISOString() }));
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { points: q } })).data.kept, 3);
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 'x', lng: 1 } })).status, 400);
    assert.equal((await call('POST', '/driver/location', { headers: D, body: { lat: 95, lng: 1 } })).status, 400);
    assert.equal((await call('POST', '/driver/location', { headers: {}, body: { lat: 1, lng: 1 } })).status, 401);

    const runs = (await call('GET', '/api/drivers/driver_a/runs', { headers: ADMIN })).data;
    assert.equal(runs.runs[0].id, batch);
    assert.equal(runs.runs[0].points, 5);
    const tr = (await call('GET', `/api/drivers/driver_a/trail?batch_id=${batch}`, { headers: ADMIN })).data;
    assert.equal(tr.points.length, 5);
    assert.ok(tr.points.every((p, i, a) => i === 0 || a[i - 1].at <= p.at), 'oldest first');
    assert.ok(tr.distance_km > 0);
    assert.equal(tr.stops[0].number, o.number);
    assert.equal((await call('GET', '/api/drivers/driver_a/trail', { headers: {} })).status, 401);
  } finally { await close(); }
});

test('trails: sampled from Fleetbase on a tick, kept after the run ends, and purged by the retention setting', async () => {
  const ctx = makeCtx({ settings: { batch_hold_minutes: 0 } });
  await clockIn(ctx, 'driver_a', { lat: 51.465, lng: -0.17 });
  assert.equal(await ctx.trails.sample(), 1);
  ctx.fb.drivers_.get('driver_a').location.coordinates = [-0.15, 51.47];
  ctx.now.advance(1);
  assert.equal(await ctx.trails.sample(), 1);
  assert.equal(ctx.trails.trail('driver_a').points.length, 2);
  assert.equal(ctx.trails.trail('driver_a').points[0].lat, 51.465);
  // a driver with no fix (0,0) stores nothing
  ctx.fb.drivers_.get('driver_a').location.coordinates = [0, 0]; ctx.now.advance(1);
  assert.equal(await ctx.trails.sample(), 0);

  ctx.settings.set({ trail_retention_days: 30 });
  ctx.now.advance(60 * 24 * 40);                                                   // 40 days on
  assert.equal(ctx.trails.purge({ force: true }), 2);
  assert.equal(ctx.trails.trail('driver_a').points.length, 0);

  ctx.fb.drivers_.get('driver_a').location.coordinates = [-0.15, 51.47];
  await ctx.trails.sample();
  ctx.settings.set({ trail_retention_days: 0 });                                   // keep forever
  ctx.now.advance(60 * 24 * 4000);
  assert.equal(ctx.trails.purge({ force: true }), 0);
  assert.equal(ctx.trails.trail('driver_a').points.length, 1);
  assert.throws(() => ctx.settings.set({ trail_retention_days: -1 }), /trail_retention_days/);
  assert.throws(() => ctx.settings.set({ trail_retention_days: 1.5 }), /trail_retention_days/);
});

/* ------------------------------------------------------------------ 2. custom fields */
test('custom fields: set in Settings, stored on the order, required only on the admin form, shown to the driver when asked', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    assert.equal((await call('PUT', '/api/settings', { headers: ADMIN, body: { custom_fields: [{ label: 'Gate code', type: 'text', required: true, show_on_driver: true }, { label: 'Spice level', type: 'choice', choices: ['Mild', 'Hot'], show_on_driver: true }, { label: 'Party size', type: 'number' }, { label: 'Leave at door', type: 'checkbox', show_on_driver: true }, { label: 'Internal ref', type: 'text' }] } })).status, 200);
    const fields = ctx.settings.get('custom_fields');
    assert.deepEqual(fields.map((f) => f.key), ['gate_code', 'spice_level', 'party_size', 'leave_at_door', 'internal_ref']);
    // keys survive a label edit
    ctx.settings.set({ custom_fields: fields.map((f) => (f.key === 'gate_code' ? { ...f, label: 'Entry code' } : f)) });
    assert.equal(ctx.settings.get('custom_fields')[0].key, 'gate_code');

    const missing = await call('POST', '/api/orders', { headers: ADMIN, body: manual() });
    assert.equal(missing.status, 422); assert.match(missing.data.error, /Entry code is needed/);
    const badChoice = await call('POST', '/api/orders', { headers: ADMIN, body: manual({ custom: { gate_code: '1234', spice_level: 'Nuclear' } }) });
    assert.equal(badChoice.status, 422);
    assert.equal((await call('POST', '/api/orders', { headers: ADMIN, body: manual({ custom: { gate_code: '1234', party_size: 'lots' } }) })).status, 422);

    const ok = await call('POST', '/api/orders', { headers: ADMIN, body: manual({ custom: { gate_code: '1234', spice_level: 'Hot', party_size: '4', leave_at_door: true, internal_ref: 'ZZ', unknown: 'dropped' } }) });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.data.order.custom, { gate_code: '1234', spice_level: 'Hot', party_size: 4, leave_at_door: true, internal_ref: 'ZZ' });
    const detail = (await call('GET', `/api/orders/${ok.data.order.id}`, { headers: ADMIN })).data;
    assert.deepEqual(detail.custom.map((c) => `${c.label}=${c.value}`), ['Entry code=1234', 'Spice level=Hot', 'Party size=4', 'Leave at door=Yes', 'Internal ref=ZZ']);
    const board = (await call('GET', '/api/board', { headers: ADMIN })).data;
    assert.equal(board.orders.find((o) => o.id === ok.data.order.id).custom_view.length, 5);

    // an order from another channel does not have to answer a required field
    const site = await call('POST', '/api/ingest/own', { headers: { 'X-TAD-Key': 'site-key' }, body: { external_id: 'w1', customer: { name: 'W', phone: '07700 900333' }, address: { line1: '1 Rd', postcode: 'SW11 5XX' }, items: [{ name: 'Wings', qty: 1 }] } });
    assert.equal(site.status, 201);

    // the driver only sees fields marked show-on-driver
    await clockIn(ctx, 'driver_a');
    const D = await driverHeaders(ctx, call, 'driver_a');
    await makeReady(ctx, ctx.orders.byId(ok.data.order.id));
    await ctx.batcher.tick();
    const run = (await call('GET', '/driver/run', { headers: D })).data;
    assert.deepEqual(run.orders[0].custom, [{ label: 'Entry code', value: '1234' }, { label: 'Spice level', value: 'Hot' }, { label: 'Leave at door', value: 'Yes' }]);
    // the same data travels to Fleetbase with the order
    assert.ok(ctx.fb.calls.find((c) => c[0] === 'createOrder')[1].meta.custom.some((c) => c.label === 'Gate code' || c.label === 'Entry code'));
    // removing a field hides its answers but nothing breaks
    ctx.settings.set({ custom_fields: [] });
    assert.deepEqual(ctx.orders.customView(ctx.orders.byId(ok.data.order.id)), []);

    for (const bad of [[{ label: '', type: 'text' }], [{ label: 'A', type: 'weird' }], [{ label: 'A', type: 'choice', choices: ['one'] }], [{ label: 'A', type: 'checkbox', required: true }], [{ label: 'A', type: 'text' }, { label: 'a', type: 'text' }]]) {
      assert.equal((await call('PUT', '/api/settings', { headers: ADMIN, body: { custom_fields: bad } })).status, 400);
    }
  } finally { await close(); }
});

/* ------------------------------------------------------------------ 3. flags and blocks */
test('flags: a blocked phone or address refuses a new order (admin may override), a flagged one only warns, cleared ones are free again', async () => {
  const { ctx, call, close } = await setup();
  try {
    const add = (b) => call('POST', '/api/flags', { headers: ADMIN, body: b });
    assert.equal((await add({ kind: 'phone', phone: '07700 900222', level: 'blocked' })).status, 400);               // a reason is needed
    const f1 = await add({ kind: 'phone', phone: '+44 (0)7700 900222', level: 'blocked', reason: 'Abusive to drivers' });
    assert.equal(f1.status, 201);
    assert.equal((await add({ kind: 'address', line1: '5 Bad Lane', postcode: 'sw11 5xx', level: 'flagged', reason: 'Dog at the gate' })).status, 201);

    assert.equal((await call('GET', '/api/flags/check?phone=07700900222', { headers: ADMIN })).data.level, 'blocked');
    assert.equal((await call('GET', '/api/flags/check?line1=5%20bad%20lane,&postcode=SW115XX', { headers: ADMIN })).data.level, 'flagged');
    assert.equal((await call('GET', '/api/flags/check?phone=07700900999', { headers: ADMIN })).data.level, null);

    const blocked = await call('POST', '/api/orders', { headers: ADMIN, body: manual() });
    assert.equal(blocked.status, 409); assert.equal(blocked.data.code, 'customer_blocked'); assert.match(blocked.data.error, /Abusive to drivers/);
    assert.equal(ctx.orders.list({ states: ['new'] }).length, 0);
    // our own website cannot override
    const site = await call('POST', '/api/ingest/own', { headers: { 'X-TAD-Key': 'site-key' }, body: { external_id: 'e1', override_block: true, customer: { phone: '07700 900222' }, address: { line1: '9 High St', postcode: 'SW11 5XX' }, items: [{ name: 'Wings', qty: 1 }] } });
    assert.equal(site.status, 409);
    // the admin can override a manual order; it is recorded
    const over = await call('POST', '/api/orders', { headers: ADMIN, body: manual({ override_block: true }) });
    assert.equal(over.status, 201); assert.equal(over.data.warnings[0].override, true);
    assert.ok((await call('GET', '/api/audit', { headers: ADMIN })).data.events.some((e) => e.action === 'order.block_overridden'));
    // a different phone at a blocked ADDRESS is blocked too; at a merely flagged address it only warns
    await add({ kind: 'address', line1: '9 High St', postcode: 'SW11 5XX', level: 'blocked', reason: 'Fake orders' });
    assert.equal((await call('POST', '/api/orders', { headers: ADMIN, body: manual({ customer: { name: 'Other', phone: '07700 900777' } }) })).status, 409);
    const warn = await call('POST', '/api/orders', { headers: ADMIN, body: manual({ customer: { name: 'Neighbour', phone: '07700 900888' }, address: { line1: '5 Bad Lane', postcode: 'SW11 5XX' } }) });
    assert.equal(warn.status, 201); assert.equal(warn.data.warnings[0].level, 'flagged');

    // an order that arrives already paid on another platform is taken, but the board shouts
    const hr = await ctx.orders.create({ source: 'ubereats', external_id: 'u1', customer: { name: 'U', phone: '07700 900222' }, address: { line1: '1 Rd', postcode: 'SW11 5XX' }, items: [{ name: 'Wings', qty: 1 }] });
    assert.equal(hr.warnings[0].level, 'blocked');
    const board = (await call('GET', '/api/board', { headers: ADMIN })).data;
    assert.equal(board.orders.find((o) => o.id === hr.order.id).flag.level, 'blocked');
    assert.equal(board.orders.find((o) => o.id === warn.data.order.id).flag.level, 'flagged');
    assert.equal(board.orders.find((o) => o.id === over.data.order.id).flag.level, 'blocked');

    // list, update in place, clear
    assert.equal((await call('GET', '/api/flags', { headers: ADMIN })).data.flags.length, 3);
    const again = await add({ kind: 'phone', phone: '07700900222', level: 'flagged', reason: 'Now only a warning' });
    assert.equal(again.data.flag.id, f1.data.flag.id);
    assert.equal((await call('POST', `/api/orders`, { headers: ADMIN, body: manual({ external_id: 'again', address: { line1: '12 Quiet Rd', postcode: 'SW11 5XX' } }) })).status, 201);
    assert.equal((await call('POST', `/api/flags/${f1.data.flag.id}/clear`, { headers: ADMIN })).data.flag.cleared_at != null, true);
    assert.equal((await call('GET', '/api/flags', { headers: ADMIN })).data.flags.length, 2);
    assert.equal((await call('GET', '/api/flags?all=1', { headers: ADMIN })).data.flags.length, 3);
    assert.equal((await call('POST', '/api/flags/9999/clear', { headers: ADMIN })).status, 404);
    assert.equal((await call('GET', '/api/flags', { headers: {} })).status, 401);
    // erasing a person also removes their phone flag
    ctx.hubsync.erasePerson({ phone: '07700 900222' });
    assert.ok(ctx.flags.list({ includeCleared: true }).filter((f) => f.kind === 'phone').every((f) => f.label === '(erased)'));
  } finally { await close(); }
});

/* ------------------------------------------------------------------ 4. incidents */
test('incidents: admin and driver log them with type, note and photo; audit log, filters, resolve, CSV', async () => {
  const { ctx, call, close } = await setup({ settings: { batch_hold_minutes: 0 } });
  try {
    await clockIn(ctx, 'driver_a'); await clockIn(ctx, 'driver_b');
    const Da = await driverHeaders(ctx, call, 'driver_a'), Db = await driverHeaders(ctx, call, 'driver_b');
    const o = await makeReady(ctx, await newOrder(ctx, 'SW115XX'));
    await ctx.batcher.tick();
    const mine = ctx.orders.byId(o.id).driver_id;
    const [Dm, Dother] = mine === 'driver_a' ? [Da, Db] : [Db, Da];

    const r = await call('POST', '/driver/incidents', { headers: Dm, body: { order_id: o.id, type: 'customer_conduct', note: '=cmd() shouted at me', photo: PNG } });
    assert.equal(r.status, 201);
    assert.equal(r.data.incident.order_number, o.number); assert.equal(r.data.incident.driver_id, mine); assert.match(r.data.incident.photo, /^incident-.*\.png$/);
    assert.equal((await call('POST', '/driver/incidents', { headers: Dother, body: { order_id: o.id, type: 'other', note: 'x' } })).status, 403);   // not their order
    assert.equal((await call('POST', '/driver/incidents', { headers: Dm, body: { type: 'vehicle', note: 'Flat tyre' } })).status, 201);               // about themselves
    assert.equal((await call('POST', '/driver/incidents', { headers: Dm, body: { type: 'nope', note: 'x' } })).status, 400);
    assert.equal((await call('POST', '/driver/incidents', { headers: Dm, body: { type: 'other', note: '   ' } })).status, 400);
    assert.equal((await call('POST', '/driver/incidents', { headers: Dm, body: { type: 'other', note: 'x', photo: 'data:text/html;base64,AAAA' } })).status, 400);

    const adm = await call('POST', '/api/incidents', { headers: ADMIN, body: { order_id: o.id, type: 'order_problem', note: 'Customer says wings were cold' } });
    assert.equal(adm.status, 201); assert.equal(adm.data.incident.reporter, 'admin');
    assert.equal((await call('POST', '/api/incidents', { headers: ADMIN, body: { type: 'other', note: 'about nothing' } })).status, 400);        // needs an order or a driver
    assert.equal((await call('POST', '/api/incidents', { headers: ADMIN, body: { order_id: 9999, type: 'other', note: 'x' } })).status, 404);
    assert.equal((await call('POST', '/api/incidents', { headers: ADMIN, body: { driver_id: 'driver_b', type: 'safety', note: 'Unsafe street' } })).status, 201);

    const all = (await call('GET', '/api/incidents', { headers: ADMIN })).data;
    assert.equal(all.incidents.length, 4); assert.ok(all.types.accident);
    assert.equal((await call('GET', `/api/incidents?order_id=${o.id}`, { headers: ADMIN })).data.incidents.length, 2);
    assert.equal((await call('GET', '/api/incidents?type=vehicle', { headers: ADMIN })).data.incidents.length, 1);
    assert.equal((await call('GET', '/api/board', { headers: ADMIN })).data.incidents_open, 4);

    const id = r.data.incident.id;
    assert.equal((await call('POST', `/api/incidents/${id}/resolve`, { headers: ADMIN, body: { note: 'Called the customer' } })).data.incident.status, 'resolved');
    assert.equal((await call('GET', '/api/incidents?status=open', { headers: ADMIN })).data.incidents.length, 3);

    const audit = (await call('GET', '/api/audit', { headers: ADMIN })).data.events;
    assert.equal(audit.filter((e) => e.action === 'incident.create').length, 4);
    assert.ok(audit.some((e) => e.action === 'incident.resolve'));
    assert.ok(ctx.orders.timeline(o.id).some((e) => e.type === 'incident'));

    const csv = await call('GET', '/api/incidents.csv', { headers: ADMIN });
    assert.equal(csv.status, 200);
    assert.match(csv.data.split('\n')[0], /^id,at,reported_by,type,order,driver,note/);
    assert.equal(csv.data.trim().split('\n').length, 5);
    assert.ok(csv.data.includes("'=cmd()"), 'formula neutralised');
    assert.equal((await call('GET', '/api/incidents.csv', { headers: {} })).status, 401);
  } finally { await close(); }
});
