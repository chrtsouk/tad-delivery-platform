#!/usr/bin/env node
// Demo server: the REAL app with in-memory data and fake Fleetbase/VROOM/OSRM/postcodes, seeded with orders and drivers.
// For building and looking at the web UI without Docker. Admin password: demo   Own-site key: demo-key
//   node scripts/demo.mjs            -> http://localhost:4001   (web dev server proxies to it: PORT=4001)
import { buildContext } from '../lib/context.js';
import { loadConfig } from '../lib/config.js';
import { createApp } from '../server/app.js';
import { fakeFleetbase, fakePostcodes, fakeVroom, fakeOsrm, silent } from '../test/fakes/index.js';
import { POSTCODES } from '../test/helpers.js';
import path from 'node:path';
import os from 'node:os';

const port = Number(process.env.PORT || 4001);
const config = { ...loadConfig({ ADMIN_PASSWORD: 'demo', ADMIN_API_TOKEN: 'demo-token', SESSION_SECRET: 'demo', TRACK_SECRET: 'demo', OWN_SITE_API_KEY: 'demo-key', PUBLIC_URL: `http://localhost:${port}` }), dbPath: ':memory:' };
const fb = fakeFleetbase();
const ctx = buildContext({ config, logger: silent, clients: { fleetbase: fb, postcodes: fakePostcodes(POSTCODES), vroom: fakeVroom(), osrm: fakeOsrm(), hub: { enabled: () => false } }, transport: { sendMail: async () => {} } });
ctx.settings.set({ open: true, radius_km: 60, max_tasks: 3, batch_hold_minutes: 3, late_after_minutes: 35, warn_after_minutes: 25, fee_bands: [{ up_to_km: 3, fee_pence: 199 }, { up_to_km: 8, fee_pence: 349 }] });
for (const [id, name, lat, lng] of [['driver_dan', 'Dan Rivers', 51.4651, -0.1701], ['driver_maya', 'Maya Okafor', 51.4649, -0.1699], ['driver_leo', 'Leo Marsh', 51.5, -0.12]]) fb.addDriver({ id, name, lat, lng });
await ctx.shifts.clockIn('driver_dan'); await ctx.shifts.clockIn('driver_maya');

const spots = [['SW11 5XX', 'Priya', 'Wings x2'], ['SW11 6AA', 'Tom', 'Burger'], ['SW11 8AA', 'Ellie', 'Tenders'], ['SW12 8AA', 'Jack', 'Burger x2'], ['SW4 7XX', 'Nia', 'Wings'], ['E1 6AN', 'Omar', 'Mega box'], ['N1 5AA', 'Sue', 'Tenders x3']];
let i = 0;
for (const [pc, name, item] of spots) {
  const { order } = await ctx.orders.create({ source: i % 3 === 0 ? 'hubrise' : 'own-site', external_id: `demo-${i}`, customer: { name, phone: `0770090010${i}` }, address: { line1: `${10 + i} Demo Road`, postcode: pc }, items: [{ name: item, qty: 1 }], total_pence: 1800 + i * 150 });
  if (i < 6) ctx.orders.transition(order.id, 'accepted');
  if (i < 4) ctx.orders.transition(order.id, 'ready');
  i++;
}
await ctx.batcher.tick();
const app = createApp(ctx, { webDir: path.resolve(".tmp-test/dist-track"), uploadDir: path.join(os.tmpdir(), 'tad-test-demo-uploads') });
app.listen(port, () => console.log(`demo on http://localhost:${port}  (password: demo)`));
setInterval(() => ctx.batcher.tick().catch(() => {}), 10000);
