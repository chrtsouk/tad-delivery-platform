import { loadConfig } from '../lib/config.js';
import { buildContext } from '../lib/context.js';
import { fakeFleetbase, fakePostcodes, fakeVroom, fakeOsrm, fakeClock, silent } from './fakes/index.js';

export const POSTCODES = {
  SW111AB: { lat: 51.465, lng: -0.17 },    // the shop
  SW128AA: { lat: 51.452, lng: -0.147 },
  SW128AB: { lat: 51.4522, lng: -0.1472 },
  SW47XX: { lat: 51.46, lng: -0.14 },
  SW115XX: { lat: 51.47, lng: -0.16 },
  SW116AA: { lat: 51.471, lng: -0.161 },
  SW118AA: { lat: 51.469, lng: -0.158 },
  E16AN: { lat: 51.52, lng: -0.07 },
  N15AA: { lat: 51.55, lng: -0.1 },
};

/** Everything in memory (SQLite ':memory:'), fake Fleetbase / VROOM / OSRM / postcodes, a clock you can move. No files, no temp dirs. */
export function makeCtx({ vroomFail = false, osrmFail = false, settings = {}, env = {} } = {}) {
  const config = loadConfig({ TRACK_SECRET: 'test-secret', PUBLIC_URL: 'http://track.test', ...env });
  const fb = fakeFleetbase();
  const now = fakeClock();
  const emails = [];
  const pushes = [];
  const ctx = buildContext({
    config: { ...config, dbPath: ':memory:' }, now, logger: silent,
    clients: { fleetbase: fb, postcodes: fakePostcodes(POSTCODES), vroom: fakeVroom({ fail: vroomFail }), osrm: fakeOsrm({ fail: osrmFail }), hub: { enabled: () => false } },
    transport: { sendMail: async (m) => { emails.push(m); } },
  });
  ctx.settings.set({ open: true, ...settings });
  return Object.assign(ctx, { fb, emails, pushes });
}

export const addr = (line1, postcode) => ({ line1, postcode });
export async function newOrder(ctx, postcode, extra = {}) {
  const { order } = await ctx.orders.create({
    source: 'own-site', external_id: `x-${Math.random().toString(36).slice(2)}`,
    customer: { name: 'Cust', phone: '07700 900111', email: extra.email },
    address: addr('1 Test Road', postcode), items: [{ name: 'Wings', qty: 1 }], ...extra,
  });
  return order;
}
export async function makeReady(ctx, order) {
  ctx.orders.transition(order.id, 'accepted'); ctx.orders.transition(order.id, 'ready');
  return ctx.orders.byId(order.id);
}
export async function clockIn(ctx, id, { lat = 51.465, lng = -0.17 } = {}) {
  if (!ctx.fb.drivers_.has(id)) ctx.fb.addDriver({ id, name: id, online: false, lat, lng });
  return ctx.shifts.clockIn(id);
}
