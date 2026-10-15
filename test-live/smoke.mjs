// LIVE smoke test against the local docker stack (Fleetbase + OSRM + VROOM + postcodes.io). Not part of `npm test`.
// Run: scripts/fleetbase-up.sh && docker compose -f docker/geo/docker-compose.yml up -d && node test-live/smoke.mjs
import assert from 'node:assert/strict';
import { loadEnvFile, loadConfig } from '../lib/config.js';
import { buildContext } from '../lib/context.js';

loadEnvFile();
const config = { ...loadConfig(), dbPath: ':memory:' };
const ctx = buildContext({ config, transport: { sendMail: async () => {} } });
ctx.settings.set({ open: true, batch_hold_minutes: 0, radius_km: 30, store: { name: 'Texas After Dark', lat: 51.4616, lng: -0.1708, postcode: 'SW11 1AB', address: 'Shop', phone: '' } });

const step = (m) => console.log(`✔ ${m}`);
const drivers = await ctx.fleetbase.drivers();
let d = drivers.find((x) => x.name === 'Smoke Driver') ?? await ctx.fleetbase.createDriver({ name: 'Smoke Driver', phone: '+447700900777', email: 'smoke@example.com', status: 'active' });
step(`Fleetbase reachable, driver ${d.id}`);
await ctx.fleetbase.driver(d.id).then(async (x) => { if (x.online) await ctx.fleetbase.setOnline(d.id); });
await ctx.shifts.clockIn(d.id, { zone: 'SW' });
assert.equal((await ctx.fleetbase.driver(d.id)).online, true);
step('clock-in set the driver online in Fleetbase');

const hit = await ctx.postcodes.lookup('SW1A 1AA');
assert.ok(hit?.lat, 'postcodes.io answered');
step(`postcodes.io: SW1A 1AA -> ${hit.lat},${hit.lng}`);

ctx.settings.set({ store: { ...ctx.settings.get('store'), lat: hit.lat, lng: hit.lng } });
const mk = async (pc, n) => (await ctx.orders.create({ source: 'smoke', external_id: `smoke-${Date.now()}-${n}`, customer: { name: `Smoke ${n}`, phone: `0770090099${n}` }, address: { line1: `${n} Test Street`, postcode: pc }, items: [{ name: 'Wings', qty: 1 }] })).order;
const a = await mk('SW1A 2AA', 1), b = await mk('SW1H 9AJ', 2);
for (const o of [a, b]) { ctx.orders.transition(o.id, 'accepted'); ctx.orders.transition(o.id, 'ready'); }
await ctx.orders.retryFleetbaseSync();
assert.ok(ctx.orders.byId(a.id).fleetbase_order_id, 'order exists in Fleetbase');
step('orders mirrored into Fleetbase');

const r = await ctx.batcher.tick();
assert.equal(r.assigned.length, 1);
assert.equal(r.engine, 'vroom', 'real VROOM was used');
step(`batcher (real VROOM+OSRM) built 1 run of ${r.assigned[0].orders.length} for ${r.assigned[0].driver}`);
const fb = await ctx.fleetbase.order(ctx.orders.byId(a.id).fleetbase_order_id);
assert.equal(fb.status, 'dispatched');
step('Fleetbase order is dispatched');

await ctx.batcher.markOut(ctx.orders.byId(a.id).batch_id);
const eta = await ctx.osrm.route(hit, { lat: 51.5014, lng: -0.1419 });
assert.ok(eta.seconds > 0);
step(`OSRM route ${Math.round(eta.seconds)}s`);
for (const o of [a, b]) await ctx.batcher.deliver(o.id);
const done = await ctx.fleetbase.order(ctx.orders.byId(a.id).fleetbase_order_id);
console.log('Fleetbase final status:', done.status);
await ctx.shifts.clockOut(d.id);
step('delivered, clocked out');
console.log('LIVE SMOKE OK');
