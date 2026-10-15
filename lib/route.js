import { haversineKm } from './geo.js';

/** Rough urban driving time when OSRM is unreachable: straight-line * 1.35 at 22 km/h. */
export const estimateSeconds = (a, b) => (haversineKm(a, b) * 1.35 / 22) * 3600;

/** Nearest-neighbour order from `start`; the fallback when VROOM cannot be reached. */
export function nnSequence(start, stops) {
  const left = [...stops], out = [];
  let cur = start;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((s, i) => { const d = haversineKm(cur, s); if (d < bd) { bd = d; bi = i; } });
    const [n] = left.splice(bi, 1);
    out.push(n); cur = n;
  }
  return out;
}
