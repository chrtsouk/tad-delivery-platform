import { haversineKm } from '../../lib/geo.js';
import { nnSequence } from '../../lib/route.js';

/** In-memory stand-in for the Fleetbase API client (same method names as lib/clients.js createFleetbase). */
export function fakeFleetbase() {
  const f = { drivers_: new Map(), orders_: new Map(), places_: new Map(), calls: [], failOn: new Set(), n: 0 };
  const id = (p) => `${p}_${++f.n}`;
  const rec = (name, ...a) => { f.calls.push([name, ...a]); if (f.failOn.has(name)) throw new Error(`fake ${name} failure`); };
  Object.assign(f, {
    addDriver(d) { const x = { id: d.id, name: d.name ?? d.id, online: d.online ?? false, location: { type: 'Point', coordinates: [d.lng ?? 0, d.lat ?? 0] } }; f.drivers_.set(x.id, x); return x; },
    async drivers() { rec('drivers'); return [...f.drivers_.values()]; },
    async driver(i) { rec('driver', i); const d = f.drivers_.get(i); if (!d) throw new Error('404 not found'); return d; },
    async setOnline(i) { rec('setOnline', i); const d = f.drivers_.get(i); d.online = !d.online; return d; },
    async createPlace(p) { rec('createPlace', p); const x = { id: id('place'), ...p }; f.places_.set(x.id, x); return x; },
    async createOrder(o) { rec('createOrder', o); const x = { id: id('order'), tracking_number: { tracking_number: `TEX${f.n}` }, status: 'created', ...o }; f.orders_.set(x.id, x); return x; },
    async order(i) { return f.orders_.get(i); },
    async assign(i, d) { rec('assign', i, d); f.orders_.get(i).driver = d; return {}; },
    async dispatch(i) { rec('dispatch', i); f.orders_.get(i).status = 'dispatched'; return {}; },
    async start(i) { rec('start', i); f.orders_.get(i).status = 'started'; return {}; },
    async complete(i) { rec('complete', i); f.orders_.get(i).status = 'completed'; return {}; },
    async cancel(i) { rec('cancel', i); return {}; },
    async activity() { return {}; },
    async eta() { return {}; },
    async serviceAreas() { return []; },
    async createServiceArea(a) { rec('createServiceArea', a); return { id: id('sa'), ...a }; },
  });
  return f;
}

/** Postcode table -> coordinates. */
export function fakePostcodes(table = {}) {
  return {
    async lookup(pc) { const k = pc.replace(/\s+/g, '').toUpperCase(); const hit = table[k]; return hit ? { postcode: pc, outcode: k.slice(0, -3), ...hit } : null; },
    async autocomplete() { return []; },
  };
}

/** VROOM stand-in: greedy nearest-neighbour split into vehicles' capacity, with arrival times from straight-line speed (30 km/h). */
export function fakeVroom({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async solve({ vehicles, jobs }) {
      calls.push({ vehicles, jobs });
      if (fail) throw new Error('VROOM down');
      const cap = vehicles[0].capacity, start = vehicles[0].start;
      const left = jobs.map((j) => ({ ...j, ...j.loc }));
      const routes = [];
      for (const v of vehicles) {
        if (!left.length) break;
        const seed = left.sort((a, b) => haversineKm(start, a) - haversineKm(start, b))[0];
        const near = left.filter((j) => j !== seed).sort((a, b) => haversineKm(seed, a) - haversineKm(seed, b)).slice(0, cap - 1);
        const seq = nnSequence(start, [seed, ...near]);
        let t = 0, prev = start;
        const stops = seq.map((j) => { t += (haversineKm(prev, j) / 30) * 3600; const st = { job: j.id, arrival: Math.round(t), service: j.service }; t += j.service; prev = j; return st; });
        routes.push({ vehicle: v.id, duration: t, stops });
        for (const j of seq) left.splice(left.indexOf(j), 1);
      }
      return { routes, unassigned: left.map((j) => j.id) };
    },
  };
}

export function fakeOsrm({ fail = false } = {}) {
  return {
    async route(a, b) { if (fail) throw new Error('OSRM down'); return { seconds: (haversineKm(a, b) / 30) * 3600, metres: haversineKm(a, b) * 1000 }; },
    async table(pts) { if (fail) throw new Error('OSRM down'); return pts.map((a) => pts.map((b) => (haversineKm(a, b) / 30) * 3600)); },
  };
}

export const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

/** A clock you can move. */
export function fakeClock(start = '2026-10-15T18:00:00.000Z') {
  let t = Date.parse(start);
  const now = () => new Date(t);
  now.advance = (min) => { t += min * 60000; };
  now.set = (iso) => { t = Date.parse(iso); };
  return now;
}
