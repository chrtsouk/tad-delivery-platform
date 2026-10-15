import { AppError } from './util.js';

/** "sw11 1ab" -> { postcode: "SW11 1AB", outcode: "SW11" } or an AppError in plain words. */
export function normalisePostcode(pc) {
  const raw = String(pc ?? '').toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.exec(raw);
  if (!m) throw new AppError(`"${String(pc ?? '').trim()}" does not look like a UK postcode (for example SW11 1AB)`);
  return { postcode: `${m[1]} ${m[2]}`, outcode: m[1] };
}

export function tryPostcode(pc) { try { return normalisePostcode(pc); } catch { return null; } }

/** Phone as digits with a +44 prefix for UK numbers, so "07700 900111" and "+44 7700 900111" match. */
export function normalisePhone(p) {
  if (p === undefined || p === null || String(p).trim() === '') return null;
  let t = String(p).replace(/[\s().-]/g, '');
  if (t.startsWith('00')) t = `+${t.slice(2)}`;
  if (t.startsWith('+440')) t = `+44${t.slice(4)}`;           // +44 (0)7700 900111 -> +447700900111
  if (t.startsWith('0')) t = `+44${t.slice(1)}`;
  else if (/^44\d{9,10}$/.test(t)) t = `+${t}`;
  if (!/^\+\d{7,15}$/.test(t)) throw new AppError(`"${String(p).trim()}" does not look like a phone number`);
  return t;
}

export function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const centroid = (pts) => ({ lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length });
