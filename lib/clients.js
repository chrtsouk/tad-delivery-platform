import { fetchJson, AppError } from './util.js';

const lngLat = (p) => [p.lng, p.lat];

/** Fleetbase public API (https://github.com/fleetbase/fleetbase). Bearer = API key. Unmodified Fleetbase, we only call it. */
export function createFleetbase({ url, apiKey }, fetchImpl = fetch) {
  const call = async (path, opts = {}) => {
    if (!apiKey) throw new AppError('Fleetbase API key is not set (FLEETBASE_API_KEY)', 503, 'not_configured');
    return fetchJson(`${url}${path}`, { ...opts, headers: { Authorization: `Bearer ${apiKey}` }, fetchImpl });
  };
  const qs = (o) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)); const s = p.toString(); return s ? `?${s}` : ''; };
  return {
    drivers: (filter = {}) => call(`/v1/drivers${qs({ limit: 200, ...filter })}`),
    driver: (id) => call(`/v1/drivers/${id}`),
    createDriver: (d) => call('/v1/drivers', { method: 'POST', body: d }),
    setOnline: (id) => call(`/v1/drivers/${id}/toggle-online`, { method: 'POST', body: {} }),
    createPlace: (p) => call('/v1/places', { method: 'POST', body: p }),
    createOrder: (o) => call('/v1/orders', { method: 'POST', body: { type: 'transport', dispatch: false, ...o } }),
    order: (id) => call(`/v1/orders/${id}`),
    orders: (filter = {}) => call(`/v1/orders${qs({ limit: 200, ...filter })}`),
    assign: (id, driverId) => call(`/v1/orders/${id}`, { method: 'PUT', body: { driver: driverId } }),
    dispatch: (id) => call(`/v1/orders/${id}/dispatch`, { method: 'POST', body: {} }),
    start: (id) => call(`/v1/orders/${id}/start`, { method: 'POST', body: {} }),
    activity: (id, activity) => call(`/v1/orders/${id}/update-activity`, { method: 'POST', body: { activity } }),
    complete: (id) => call(`/v1/orders/${id}/complete`, { method: 'POST', body: {} }),
    cancel: (id) => call(`/v1/orders/${id}/cancel`, { method: 'DELETE' }),
    eta: (id) => call(`/v1/orders/${id}/eta`),
    serviceAreas: () => call('/v1/service-areas'),
    createServiceArea: (a) => call('/v1/service-areas', { method: 'POST', body: a }),
    updateServiceArea: (id, a) => call(`/v1/service-areas/${id}`, { method: 'PUT', body: a }),
  };
}

/** OSRM HTTP API, called directly (self-hosted Great Britain graph). */
export function createOsrm({ url }, fetchImpl = fetch) {
  const coords = (pts) => pts.map((p) => `${p.lng},${p.lat}`).join(';');
  return {
    async route(from, to) {
      const d = await fetchJson(`${url}/route/v1/driving/${coords([from, to])}?overview=false`, { fetchImpl });
      const r = d?.routes?.[0];
      if (!r) throw new AppError('No route found between those two points', 502, 'no_route');
      return { seconds: r.duration, metres: r.distance };
    },
    /** duration matrix (seconds) between every pair of points */
    async table(pts) {
      const d = await fetchJson(`${url}/table/v1/driving/${coords(pts)}?annotations=duration`, { fetchImpl });
      return d.durations;
    },
  };
}

/** Our own VROOM instance (vroom-express). */
export function createVroom({ url }, fetchImpl = fetch) {
  return {
    /** vehicles: [{id, start:{lat,lng}, end?, capacity, max_tasks}], jobs: [{id, loc:{lat,lng}, service(sec)}] */
    async solve({ vehicles, jobs }) {
      const body = {
        vehicles: vehicles.map((v) => ({ id: v.id, start: lngLat(v.start), end: lngLat(v.end ?? v.start), capacity: [v.capacity], ...(v.max_tasks ? { max_tasks: v.max_tasks } : {}) })),
        jobs: jobs.map((j) => ({ id: j.id, location: lngLat(j.loc), service: Math.round(j.service ?? 0), amount: [1] })),
        options: { g: false },
      };
      const d = await fetchJson(`${url}/`, { method: 'POST', body, timeoutMs: 30000, fetchImpl });
      if (d.code && d.code !== 0) throw new AppError(`VROOM could not solve: ${d.error || d.code}`, 502, 'vroom_error');
      return {
        routes: (d.routes || []).map((r) => ({
          vehicle: r.vehicle,
          duration: r.duration,
          stops: r.steps.filter((s) => s.type === 'job').map((s) => ({ job: s.id, arrival: s.arrival, duration: s.duration, service: s.service })),
        })),
        unassigned: (d.unassigned || []).map((u) => u.id),
      };
    },
  };
}

/** postcodes.io (self-hosted): postcode -> coordinates + district. */
export function createPostcodes({ url }, fetchImpl = fetch) {
  return {
    async lookup(postcode) {
      const d = await fetchJson(`${url}/postcodes/${encodeURIComponent(postcode.replace(/\s+/g, ''))}`, { fetchImpl }).catch((e) => {
        if (/HTTP 404|not found|Invalid/i.test(e.message)) return null;
        throw e;
      });
      const r = d?.result;
      if (!r) return null;
      return { postcode: r.postcode, outcode: r.outcode, lat: r.latitude, lng: r.longitude, admin_district: r.admin_district, region: r.region };
    },
    async autocomplete(partial) {
      const d = await fetchJson(`${url}/postcodes/${encodeURIComponent(partial)}/autocomplete?limit=8`, { fetchImpl });
      return d?.result || [];
    },
  };
}

/** Photon (self-hosted, GB extract): street / house-number autocomplete. */
export function createPhoton({ url }, fetchImpl = fetch) {
  return {
    async search(query, { near, limit = 6 } = {}) {
      const loc = near ? `&lat=${near.lat}&lon=${near.lng}` : '';
      const d = await fetchJson(`${url}/api?q=${encodeURIComponent(query)}&limit=${limit}&lang=en${loc}`, { fetchImpl });
      return (d?.features || []).filter((f) => !f.properties.countrycode || f.properties.countrycode === 'GB').map((f) => {
        const p = f.properties;
        const line1 = [p.housenumber, p.street || p.name].filter(Boolean).join(' ');
        return {
          line1, city: p.city || p.county || p.district || '', postcode: p.postcode || null,
          label: [line1, p.city || p.district, p.postcode].filter(Boolean).join(', '),
          lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        };
      });
    },
  };
}

/** The management app hub (source of truth): orders in, customers, events. */
export function createHub({ url, token }, fetchImpl = fetch) {
  const call = async (path, opts = {}) => {
    if (!url) throw new AppError('The hub is not configured (HUB_URL)', 503, 'not_configured');
    return fetchJson(`${url}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}` }, fetchImpl });
  };
  return {
    enabled: () => Boolean(url),
    orders: (query = '') => call(`/api/v1/orders${query}`),
    customers: (query = '') => call(`/api/v1/customers${query}`),
    events: (since) => call(`/api/v1/events${since ? `?since=${encodeURIComponent(since)}` : ''}`),
    postOrder: (order) => call('/api/v1/orders', { method: 'POST', body: order }),
  };
}
