/** driver_shifts: clock in / clock out / zone, and the "available now" query joined to Fleetbase's driver online status. */
import { q } from '../lib/db.js';
import { AppError } from '../lib/util.js';
import { randomToken, sha256, safeEqual } from '../lib/tokens.js';

export function createShifts(ctx) {
  const { db, now, fleetbase, audit, logger = console } = ctx;
  const iso = () => now().toISOString();

  const open = (driverId) => q.get(db, 'SELECT * FROM driver_shifts WHERE driver_id = ? AND clock_out_at IS NULL ORDER BY id DESC LIMIT 1', driverId);

  async function fbDriver(driverId) {
    try { return await fleetbase.driver(driverId); } catch (e) { if (/404|not found/i.test(e.message)) throw new AppError('That driver is not in Fleetbase', 404, 'unknown_driver'); throw e; }
  }

  async function ensureOnline(driverId, wanted) {
    try {
      const d = await fleetbase.driver(driverId);
      if (Boolean(d.online) !== wanted) await fleetbase.setOnline(driverId);
    } catch (e) { logger.warn?.(`Could not set ${driverId} ${wanted ? 'online' : 'offline'} in Fleetbase: ${e.message}`); }
  }

  async function clockIn(driverId, { zone = null, actor = 'driver' } = {}) {
    if (open(driverId)) throw new AppError('You are already clocked in', 409, 'already_in');
    const d = await fbDriver(driverId);
    q.run(db, 'INSERT INTO driver_shifts(driver_id, driver_name, clock_in_at, zone) VALUES(?,?,?,?)', driverId, d.name ?? null, iso(), zone);
    await ensureOnline(driverId, true);
    audit.log(actor, 'shift.clock_in', 'driver', driverId, { zone });
    ctx.bus.emit('shift', { driverId, clockedIn: true });
    return open(driverId);
  }

  async function clockOut(driverId, { actor = 'driver' } = {}) {
    const s = open(driverId);
    if (!s) throw new AppError('You are not clocked in', 409, 'not_in');
    const onRun = q.get(db, "SELECT id FROM batches WHERE driver_id = ? AND status = 'out'", driverId);
    if (onRun) throw new AppError('Finish your current run before you clock out', 409, 'on_a_run');
    q.run(db, 'UPDATE driver_shifts SET clock_out_at = ? WHERE id = ?', iso(), s.id);
    // anything lined up for this driver (not yet out) goes back to the queue
    const { requeueDriver } = ctx.hooks ?? {};
    if (requeueDriver) requeueDriver(driverId);
    await ensureOnline(driverId, false);
    audit.log(actor, 'shift.clock_out', 'driver', driverId);
    ctx.bus.emit('shift', { driverId, clockedIn: false });
    return q.get(db, 'SELECT * FROM driver_shifts WHERE id = ?', s.id);
  }

  const clockedIn = () => q.all(db, 'SELECT * FROM driver_shifts WHERE clock_out_at IS NULL ORDER BY clock_in_at');

  /** Clocked in AND online in Fleetbase AND not already carrying/collecting a run. `busy` ones are returned separately. */
  async function availability({ requireOnline = true } = {}) {
    const shifts = clockedIn();
    let online = null;
    if (requireOnline) {
      try { online = new Map((await fleetbase.drivers()).map((d) => [d.id, d])); } catch (e) { logger.warn?.(`Fleetbase driver list unavailable: ${e.message}`); }
    }
    const result = { available: [], busy: [], offline: [] };
    for (const s of shifts) {
      const fb = online?.get(s.driver_id);
      const loc = fb?.location?.coordinates;
      const rec = { driver_id: s.driver_id, name: s.driver_name ?? fb?.name ?? null, zone: s.zone, clock_in_at: s.clock_in_at, lat: loc && (loc[0] || loc[1]) ? loc[1] : null, lng: loc && (loc[0] || loc[1]) ? loc[0] : null };
      if (online && !fb?.online) { result.offline.push(rec); continue; }
      const run = q.get(db, "SELECT id, status, return_eta_at FROM batches WHERE driver_id = ? AND status IN ('assigned','out') ORDER BY id DESC LIMIT 1", s.driver_id);
      if (run) result.busy.push({ ...rec, batch_id: run.id, batch_status: run.status, return_eta_at: run.return_eta_at });
      else result.available.push(rec);
    }
    return result;
  }

  function issueToken(driverId) {
    const token = randomToken();
    q.run(db, 'INSERT INTO driver_tokens(driver_id, token_hash, created_at) VALUES(?,?,?) ON CONFLICT(driver_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at', driverId, sha256(token), iso());
    audit.log('admin', 'driver.token_issued', 'driver', driverId);
    return token;
  }
  function driverFromToken(token) {
    if (!token) return null;
    const h = sha256(token);
    const row = q.get(db, 'SELECT driver_id, token_hash FROM driver_tokens WHERE token_hash = ?', h);
    return row && safeEqual(row.token_hash, h) ? row.driver_id : null;
  }

  return { clockIn, clockOut, open, clockedIn, availability, issueToken, driverFromToken };
}
