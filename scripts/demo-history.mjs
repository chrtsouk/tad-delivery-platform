#!/usr/bin/env node
// Demo server WITH three weeks of fake history, so the Analytics / Calendar / Audit screens have something to show.
// Same as scripts/demo.mjs (in-memory data, fake Fleetbase/VROOM/OSRM/postcodes, password: demo) plus:
//   - ~21 days of delivered / failed / cancelled orders with realistic evening peaks, driver shifts and audit rows
//   - a handful of future pre-orders (so the calendar has events)
// Nothing here talks to a real service. Run:  PORT=4000 node scripts/demo-history.mjs
import { buildContext } from '../lib/context.js';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../server/app.js';
import { q } from '../lib/db.js';
import { fakeFleetbase, fakePostcodes, fakeVroom, fakeOsrm, silent } from '../test/fakes/index.js';
import { POSTCODES } from '../test/helpers.js';
import path from 'node:path';
import os from 'node:os';

const port = Number(process.env.PORT || 4000);
const config = { ...loadConfig({ ADMIN_PASSWORD: 'demo', ADMIN_API_TOKEN: 'demo-token', SESSION_SECRET: 'demo', TRACK_SECRET: 'demo', OWN_SITE_API_KEY: 'demo-key', PUBLIC_URL: `http://localhost:${port}` }), dbPath: ':memory:' };
const fb = fakeFleetbase();
const ctx = buildContext({ config, logger: silent, clients: { fleetbase: fb, postcodes: fakePostcodes(POSTCODES), vroom: fakeVroom(), osrm: fakeOsrm(), hub: { enabled: () => false } }, transport: { sendMail: async () => {} } });
ctx.settings.set({ open: true, radius_km: 60, max_tasks: 3, batch_hold_minutes: 3, late_after_minutes: 35, warn_after_minutes: 25, fee_bands: [{ up_to_km: 3, fee_pence: 199 }, { up_to_km: 8, fee_pence: 349 }] });
const DRIVERS = [['driver_dan', 'Dan Rivers', 51.4651, -0.1701], ['driver_maya', 'Maya Okafor', 51.4649, -0.1699], ['driver_leo', 'Leo Marsh', 51.5, -0.12]];
for (const [id, name, lat, lng] of DRIVERS) fb.addDriver({ id, name, lat, lng });

/* ------------------------------------------------------------ history */
let seed = 20260101;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const iso = (ms) => new Date(ms).toISOString();
const AREAS = [
  ['SW11', 51.468, -0.165, 5], ['SW12', 51.452, -0.147, 3], ['SW4', 51.46, -0.14, 3], ['SW18', 51.456, -0.19, 2], ['SW8', 51.478, -0.13, 2], ['SE11', 51.49, -0.11, 1], ['E1', 51.52, -0.07, 1], ['N1', 51.55, -0.1, 1],
];
const AREA_BAG = AREAS.flatMap((a) => Array(a[3]).fill(a));
const SOURCES = ['own-site', 'own-site', 'hubrise', 'ubereats', 'deliveroo', 'justeat'];
const FAIL_REASONS = ['Customer not answering', 'Wrong address', 'Could not find the door', 'Customer refused the order'];
const CANCEL_REASONS = ['Customer changed their mind', 'Item sold out', 'Duplicate order'];
const NAMES = ['Priya', 'Tom', 'Ellie', 'Jack', 'Nia', 'Omar', 'Sue', 'Kai', 'Rosa', 'Ben', 'Alicia', 'Marcus'];
const weekdayWeight = [0.7, 0.7, 0.8, 1.0, 1.5, 1.9, 1.3]; // Mon..Sun
const hourWeight = (h) => (h < 11 ? 0 : h < 12 ? 0.2 : h < 17 ? 0.5 : h < 18 ? 1 : h < 22 ? 3 : h < 23 ? 1.5 : h < 24 ? 0.5 : 0);

const nowMs = Date.now();
const day0 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
const insertOrder = (o) => q.run(ctx.db, `INSERT INTO orders(number, source, external_id, fulfilment, state, customer_name, customer_phone, address_line, postcode, outcode, lat, lng, items_json, item_count, total_pence, delivery_fee_pence, paid,
  scheduled_for, created_at, accepted_at, ready_at, assigned_at, out_at, delivered_at, failed_at, cancelled_at, driver_id, fail_reason, rating) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
o.number, o.source, o.external_id, 'delivery', o.state, o.name, o.phone, o.address, o.postcode, o.outcode, o.lat, o.lng, JSON.stringify([{ name: o.item, qty: 1 }]), 1, o.total, 249, o.scheduled_for ?? null,
o.created, o.accepted ?? null, o.ready ?? null, o.assigned ?? null, o.out ?? null, o.delivered ?? null, o.failed ?? null, o.cancelled ?? null, o.driver ?? null, o.fail_reason ?? null, o.rating ?? null);
// the audit rows the real app would have written for this order
const auditFor = (o) => {
  const log = (at, actor, action, detail) => q.run(ctx.db, 'INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', at, actor, action, 'order', o.number, JSON.stringify({ number: o.number, ...detail }));
  log(o.created, 'system', 'order.create', { source: o.source });
  if (o.state === 'delivered') log(o.delivered, `driver:${o.driver}`, 'order.delivered', { from: 'out' });
  if (o.state === 'failed') log(o.failed, `driver:${o.driver}`, 'order.failed', { from: 'out', reason: o.fail_reason });
  if (o.state === 'cancelled') log(o.cancelled, 'admin', 'order.cancelled', { from: 'accepted', reason: o.fail_reason });
};

const addOrder = (o) => { insertOrder(o); auditFor(o); };
let n = 0;
for (let back = 21; back >= 0; back--) {
  const dayStart = day0 - back * 86400000;
  const dow = (new Date(dayStart).getUTCDay() + 6) % 7;
  const target = Math.round((14 + rnd() * 8) * weekdayWeight[dow]);
  // shifts: two or three drivers, evening
  const crew = DRIVERS.filter(([id]) => id !== 'driver_leo' || dow >= 4);
  crew.forEach(([id, name], k) => {
    const inAt = dayStart + (17 + k * 0.5) * 3600000, outAt = dayStart + (23 + rnd() * 0.8) * 3600000;
    if (inAt > nowMs - 3600000) return;
    q.run(ctx.db, 'INSERT INTO driver_shifts(driver_id, driver_name, clock_in_at, clock_out_at, zone) VALUES(?,?,?,?,?)', id, name, iso(inAt), outAt < nowMs ? iso(outAt) : null, k === 0 ? 'SW11' : 'SW12');
    q.run(ctx.db, 'INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', iso(inAt), 'driver', 'shift.clock_in', 'driver', id, JSON.stringify({ zone: k === 0 ? 'SW11' : 'SW12' }));
    if (outAt < nowMs) q.run(ctx.db, 'INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', iso(outAt), 'driver', 'shift.clock_out', 'driver', id, null);
  });
  for (let i = 0; i < target; i++) {
    let h; do { h = Math.floor(rnd() * 24); } while (rnd() * 3 > hourWeight(h));
    const created = dayStart + (h + rnd()) * 3600000;
    if (created > nowMs - 3600000) continue;
    const [outcode, lat0, lng0] = pick(AREA_BAG);
    const lat = lat0 + (rnd() - 0.5) * 0.02, lng = lng0 + (rnd() - 0.5) * 0.03;
    const driver = pick(crew)[0];
    const r = rnd();
    const accepted = created + (1 + rnd() * 3) * 60000, ready = accepted + (9 + rnd() * 8) * 60000, assigned = ready + 60000, out = assigned + (2 + rnd() * 5) * 60000;
    const number = `TAD-HIST-${String(++n).padStart(4, '0')}`;
    const base = { number, source: pick(SOURCES), external_id: `hist-${n}`, name: pick(NAMES), phone: `07700900${String(n % 1000).padStart(3, '0')}`, address: `${1 + (n % 90)} Demo Road`, postcode: `${outcode} ${1 + (n % 9)}XX`, outcode, lat, lng, item: pick(['Wings x2', 'Burger', 'Tenders', 'Mega box', 'Wings']), total: 1500 + Math.floor(rnd() * 2500), created: iso(created) };
    if (r < 0.06) addOrder({ ...base, state: 'cancelled', accepted: iso(accepted), cancelled: iso(accepted + 4 * 60000), fail_reason: pick(CANCEL_REASONS) });
    else if (r < 0.11) addOrder({ ...base, state: 'failed', accepted: iso(accepted), ready: iso(ready), assigned: iso(assigned), out: iso(out), failed: iso(out + (10 + rnd() * 10) * 60000), driver, fail_reason: pick(FAIL_REASONS) });
    else {
      const drop = out + (6 + rnd() * (driver === 'driver_leo' ? 22 : 14)) * 60000;
      addOrder({ ...base, state: 'delivered', accepted: iso(accepted), ready: iso(ready), assigned: iso(assigned), out: iso(out), delivered: iso(drop), driver, rating: rnd() < 0.5 ? 4 + Math.floor(rnd() * 2) : null, scheduled_for: rnd() < 0.12 ? iso(created + 3600000) : null });
    }
  }
}
// some admin audit noise
for (const [daysBack, action, detail] of [[20, 'settings.update', { late_after_minutes: 35 }], [14, 'shop.close', { removed: [] }], [14, 'shop.open', null], [7, 'settings.update', { radius_km: 60 }], [2, 'order.cancelled', { number: 'TAD-HIST-0001', reason: 'Duplicate order' }]]) {
  q.run(ctx.db, 'INSERT INTO audit_log(at,actor,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', iso(day0 - daysBack * 86400000 + 15 * 3600000), 'admin', action, action.startsWith('order') ? 'order' : 'settings', null, detail ? JSON.stringify(detail) : null);
}

/* ------------------------------------------- today's live demo orders */
await ctx.shifts.clockIn('driver_dan'); await ctx.shifts.clockIn('driver_maya');
const spots = [['SW11 5XX', 'Priya', 'Wings x2'], ['SW11 6AA', 'Tom', 'Burger'], ['SW11 8AA', 'Ellie', 'Tenders'], ['SW12 8AA', 'Jack', 'Burger x2'], ['SW4 7XX', 'Nia', 'Wings'], ['E1 6AN', 'Omar', 'Mega box'], ['N1 5AA', 'Sue', 'Tenders x3']];
let i = 0;
for (const [pc, name, item] of spots) {
  const { order } = await ctx.orders.create({ source: i % 3 === 0 ? 'hubrise' : 'own-site', external_id: `demo-${i}`, customer: { name, phone: `0770090010${i}` }, address: { line1: `${10 + i} Demo Road`, postcode: pc }, items: [{ name: item, qty: 1 }], total_pence: 1800 + i * 150 });
  if (i < 6) ctx.orders.transition(order.id, 'accepted');
  if (i < 4) ctx.orders.transition(order.id, 'ready');
  i++;
}
// future pre-orders for the calendar (the next fortnight)
const preSpots = [['SW11 5XX', 'Pre Priya'], ['SW12 8AA', 'Pre Jack'], ['SW4 7XX', 'Pre Nia'], ['SW11 6AA', 'Pre Tom'], ['SW11 8AA', 'Pre Ellie']];
for (const [k, [pc, name]] of preSpots.entries()) {
  const when = new Date(day0 + (k * 2 + 1) * 86400000 + (18 + (k % 3)) * 3600000 + 30 * 60000);
  await ctx.orders.create({ source: 'own-site', external_id: `pre-${k}`, customer: { name, phone: `0770090020${k}` }, address: { line1: `${20 + k} Pre Street`, postcode: pc }, items: [{ name: 'Party box', qty: 2 }], total_pence: 4200, scheduled_for: when.toISOString() });
}
await ctx.batcher.tick();
const app = createApp(ctx, { webDir: path.resolve('web/dist'), uploadDir: path.join(os.tmpdir(), 'tad-test-demo-uploads') });
app.listen(port, () => console.log(`demo-history on http://localhost:${port}  (password: demo)  — ${n} historical orders`));
setInterval(() => ctx.batcher.tick().catch(() => {}), 10000);
