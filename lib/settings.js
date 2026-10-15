import { q } from './db.js';
import { AppError } from './util.js';

export const DEFAULTS = {
  store: { name: 'Texas After Dark', lat: 51.465, lng: -0.17, postcode: 'SW11 1AB', address: '', phone: '' },
  open: false,                       // shop open/closed switch (board)
  max_tasks: 3,                      // most drops one driver takes on one run
  max_gap_minutes: 12,               // longest drive allowed between two drops on one run
  strategy: 'nearest',               // nearest | round_robin | fewest_jobs
  batch_hold_minutes: 3,             // wait this long for a batch to fill before sending it part-full
  service_minutes_per_drop: 3,       // time at each door, for VROOM
  return_push_minutes: 5,            // tell a returning driver to collect his next orders when he is this close
  late_after_minutes: 35,            // SLA: an order older than this (since accepted) is late
  warn_after_minutes: 25,            // SLA: amber
  cluster_merge_km: 2,               // two postcode districts closer than this are batched together
  radius_km: 5,                      // delivery radius, set by the owner
  excluded_outcodes: [],             // postcode districts we never deliver to
  fee_bands: [],                     // [{ up_to_km, fee_pence }] delivery fee by zone/distance
  min_order_pence: 0,
  prep_minutes: 15,
  default_eta_minutes: 40,
  sound: true,
  show_driver_phone: true,           // the customer's tracking page shows a call button for the driver
};
const STRATEGIES = ['nearest', 'round_robin', 'fewest_jobs'];

export function createSettings(db) {
  const all = () => {
    const out = { ...DEFAULTS, store: { ...DEFAULTS.store } };
    for (const r of q.all(db, 'SELECT key, value FROM settings')) out[r.key] = JSON.parse(r.value);
    return out;
  };
  const get = (key) => all()[key];
  function set(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULTS)) throw new AppError(`Unknown setting "${k}"`);
      validate(k, v);
      q.run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(v));
    }
    return all();
  }
  return { all, get, set };
}

function validate(k, v) {
  const num = (min, max) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new AppError(`${k} must be a number from ${min} to ${max}`); };
  switch (k) {
    case 'max_tasks': if (!Number.isInteger(v) || v < 1 || v > 20) throw new AppError('max_tasks must be a whole number from 1 to 20'); break;
    case 'max_gap_minutes': case 'batch_hold_minutes': case 'return_push_minutes': case 'service_minutes_per_drop':
    case 'late_after_minutes': case 'warn_after_minutes': case 'prep_minutes': case 'default_eta_minutes': num(0, 600); break;
    case 'radius_km': num(0.5, 200); break;
    case 'cluster_merge_km': num(0, 50); break;
    case 'min_order_pence': num(0, 100000); break;
    case 'strategy': if (!STRATEGIES.includes(v)) throw new AppError(`strategy must be one of ${STRATEGIES.join(', ')}`); break;
    case 'open': case 'sound': case 'show_driver_phone': if (typeof v !== 'boolean') throw new AppError(`${k} must be true or false`); break;
    case 'excluded_outcodes': if (!Array.isArray(v) || v.some((x) => !/^[A-Z]{1,2}\d[A-Z\d]?$/.test(x))) throw new AppError('excluded_outcodes must be a list of postcode districts like "SW4"'); break;
    case 'fee_bands': if (!Array.isArray(v) || v.some((b) => !(b.up_to_km > 0) || !Number.isInteger(b.fee_pence) || b.fee_pence < 0)) throw new AppError('fee_bands must be a list of { up_to_km, fee_pence }'); break;
    case 'store': if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number') throw new AppError('store needs lat and lng'); break;
    default:
  }
}
