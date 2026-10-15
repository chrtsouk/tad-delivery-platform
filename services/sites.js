/** Multi-site: one platform, several shops. The 'main' site IS the store in Settings; others live in the sites table. */
import { q } from '../lib/db.js';
import { AppError, text } from '../lib/util.js';
import { normalisePostcode } from '../lib/geo.js';

export function createSites(ctx) {
  const { db, settings, now, audit } = ctx;

  const fromRow = (r) => ({ id: r.id, name: r.name, postcode: r.postcode, address: r.address || '', phone: r.phone || '', lat: r.lat, lng: r.lng, fleetbase_fleet_id: r.fleetbase_fleet_id, active: Boolean(r.active) });

  function list() {
    const main = { id: 'main', ...settings.get('store'), fleetbase_fleet_id: null, active: true };
    return [main, ...q.all(db, 'SELECT * FROM sites ORDER BY created_at').map(fromRow)];
  }
  const get = (id = 'main') => list().find((s) => s.id === id) ?? null;
  const need = (id = 'main') => { const s = get(id); if (!s || !s.active) throw new AppError(`There is no active shop called "${id}"`, 404, 'unknown_site'); return s; };
  // existing orders and runs keep working even if their shop was switched off; only NEW orders need an active shop
  const store = (id) => { const s = get(id); if (!s) throw new AppError(`There is no shop called "${id}"`, 404, 'unknown_site'); return { name: s.name, lat: s.lat, lng: s.lng, postcode: s.postcode, address: s.address, phone: s.phone }; };

  async function create({ id, name, postcode, address, phone, lat, lng }) {
    const sid = String(id || name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!sid || sid === 'main') throw new AppError('Give the shop a name (the id "main" is reserved)');
    if (get(sid)) throw new AppError(`A shop called "${sid}" already exists`, 409, 'exists');
    const pc = normalisePostcode(postcode);
    let la = lat, ln = lng;
    if (la == null || ln == null) {
      const hit = await ctx.postcodes.lookup(pc.postcode);
      if (!hit) throw new AppError(`We could not find ${pc.postcode} on the map`, 422, 'unknown_postcode');
      la = hit.lat; ln = hit.lng;
    }
    q.run(db, 'INSERT INTO sites(id,name,postcode,address,phone,lat,lng,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)', sid, text(name, 80, 'name', { required: true }), pc.postcode, address ?? null, phone ?? null, la, ln, now().toISOString());
    audit.log('admin', 'site.create', 'site', sid, { name });
    return get(sid);
  }

  function update(id, patch) {
    if (id === 'main') throw new AppError('Edit the main shop in Settings');
    const s = need(id);
    const next = { ...s, ...patch };
    q.run(db, 'UPDATE sites SET name=?, postcode=?, address=?, phone=?, lat=?, lng=?, active=? WHERE id=?', next.name, next.postcode, next.address, next.phone, next.lat, next.lng, next.active ? 1 : 0, id);
    audit.log('admin', 'site.update', 'site', id, patch);
    return get(id);
  }

  /** One Fleetbase fleet per extra shop, so its drivers can be grouped in the Fleetbase console. Best effort. */
  async function ensureFleet(id) {
    const s = need(id);
    if (s.fleetbase_fleet_id || id === 'main' || !ctx.fleetbase.createFleet) return s;
    const f = await ctx.fleetbase.createFleet({ name: `TAD ${s.name}`, status: 'active' });
    q.run(db, 'UPDATE sites SET fleetbase_fleet_id = ? WHERE id = ?', f.id, id);
    return get(id);
  }

  return { list, get, need, store, create, update, ensureFleet };
}
