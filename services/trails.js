/**
 * Driver GPS breadcrumb trails. Every position (pushed by the driver app, or sampled from Fleetbase on each tick) is KEPT in
 * driver_locations, tied to the run the driver was on, so the admin can replay any past route. Old points are purged after
 * the `trail_retention_days` setting (0 = keep forever).
 */
import { q } from '../lib/db.js';
import { AppError } from '../lib/util.js';
import { haversineKm } from '../lib/geo.js';

const MIN_GAP_MS = 5000;           // never store two points for one driver closer in time than this
const STILL_KM = 0.005;            // standing still: store one point a minute, not one every 5 s
const STILL_GAP_MS = 60000;
const MAX_POINTS = 20000;

export function createTrails(ctx) {
  const { db, now, settings, fleetbase, logger = console } = ctx;
  const last = new Map();                       // driver_id -> { at: ms, lat, lng }  (in-memory throttle; the table is the record)
  let lastPurge = 0;

  const activeBatch = (driverId) => q.get(db, "SELECT id FROM batches WHERE driver_id = ? AND status IN ('assigned','out') ORDER BY id DESC LIMIT 1", driverId)?.id ?? null;

  /** Store one position. Returns true if it was kept. */
  function record(driverId, lat, lng, { at } = {}) {
    if (!driverId) throw new AppError('A driver is needed');
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new AppError('lat and lng must be real coordinates');
    if (lat === 0 && lng === 0) return false;    // Fleetbase's "no fix yet"
    const t = now().getTime();
    let ts = at ? Date.parse(at) : t;
    if (!Number.isFinite(ts) || ts > t + 60000 || ts < t - 6 * 3600000) ts = t;   // a phone clock that is wrong, or an old queued ping, is stamped now
    let prev = last.get(driverId);
    if (!prev) { const r = q.get(db, 'SELECT lat, lng, at FROM driver_locations WHERE driver_id = ? ORDER BY id DESC LIMIT 1', driverId); if (r) prev = { at: Date.parse(r.at), lat: r.lat, lng: r.lng }; }
    if (prev) {
      const dt = ts - prev.at;
      if (dt >= 0 && dt < MIN_GAP_MS) return false;
      if (dt >= 0 && dt < STILL_GAP_MS && haversineKm(prev, { lat, lng }) < STILL_KM) return false;
    }
    q.run(db, 'INSERT INTO driver_locations(driver_id, batch_id, lat, lng, at) VALUES(?,?,?,?,?)', driverId, activeBatch(driverId), lat, lng, new Date(ts).toISOString());
    last.set(driverId, { at: ts, lat, lng });
    return true;
  }

  /** Called every tick: one Fleetbase call, one stored point per clocked-in driver who has a fix. */
  async function sample() {
    const clocked = q.all(db, 'SELECT DISTINCT driver_id FROM driver_shifts WHERE clock_out_at IS NULL').map((r) => r.driver_id);
    if (!clocked.length) return 0;
    let kept = 0;
    let fb; try { fb = new Map((await fleetbase.drivers()).map((d) => [d.id, d])); } catch (e) { logger.warn?.(`trail sample: Fleetbase unavailable: ${e.message}`); return 0; }
    for (const id of clocked) {
      const c = fb.get(id)?.location?.coordinates;
      if (c && (c[0] || c[1])) { try { if (record(id, c[1], c[0])) kept++; } catch (e) { logger.warn?.(`trail sample ${id}: ${e.message}`); } }
    }
    purge();
    return kept;
  }

  /** Drop points older than the retention setting (at most once an hour). */
  function purge({ force = false } = {}) {
    const days = settings.get('trail_retention_days');
    const t = now().getTime();
    if (!days || (!force && t - lastPurge < 3600000)) return 0;
    lastPurge = t;
    const cutoff = new Date(t - days * 86400000).toISOString();
    return Number(q.run(db, 'DELETE FROM driver_locations WHERE at < ?', cutoff).changes);
  }

  function trail(driverId, { batchId = null, from = null, to = null } = {}) {
    const pts = q.all(db, `SELECT lat, lng, at, batch_id FROM driver_locations WHERE driver_id = ?1 AND (?2 IS NULL OR batch_id = ?2) AND (?3 IS NULL OR at >= ?3) AND (?4 IS NULL OR at < ?4) ORDER BY at, id LIMIT ?5`,
      driverId, batchId, from, to, MAX_POINTS);
    let km = 0;
    for (let i = 1; i < pts.length; i++) km += haversineKm(pts[i - 1], pts[i]);
    const stops = batchId == null ? [] : q.all(db, "SELECT id, number, customer_name, postcode, lat, lng, stop_seq, state, delivered_at FROM orders WHERE batch_id = ? AND lat IS NOT NULL ORDER BY stop_seq", batchId);
    return { driver_id: driverId, batch_id: batchId, points: pts.map(({ lat, lng, at }) => ({ lat, lng, at })), distance_km: Math.round(km * 100) / 100, started_at: pts[0]?.at ?? null, ended_at: pts.at(-1)?.at ?? null, stops, truncated: pts.length >= MAX_POINTS };
  }

  /** A driver's runs (newest first) with how many saved points each has, so the admin can pick one to replay. */
  function runs(driverId, { limit = 50 } = {}) {
    return q.all(db, `SELECT b.id, b.status, b.created_at, b.out_at, b.done_at,
        (SELECT COUNT(*) FROM driver_locations l WHERE l.batch_id = b.id) AS points,
        (SELECT COUNT(*) FROM orders o WHERE o.batch_id = b.id) AS orders
      FROM batches b WHERE b.driver_id = ? AND b.status != 'cancelled' ORDER BY b.id DESC LIMIT ?`, driverId, limit);
  }

  const stats = () => q.get(db, 'SELECT COUNT(*) AS points, MIN(at) AS oldest FROM driver_locations');

  return { record, sample, purge, trail, runs, stats };
}
