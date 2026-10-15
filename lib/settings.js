import { q } from './db.js';
import { AppError } from './util.js';
import { validTz } from './tz.js';

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
  timezone: 'Europe/London',         // reports and order numbers follow shop time
  sound: true,
  show_driver_phone: true,           // the customer's tracking page shows a call button for the driver
  trail_retention_days: 90,          // how long saved driver GPS trails are kept (0 = keep forever)
  custom_fields: [],                 // [{ key, label, type: text|number|choice|checkbox, required, show_on_driver, choices }] extra fields on every order
};
export const FIELD_TYPES = ['text', 'number', 'choice', 'checkbox'];
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
      const stored = k === 'custom_fields' ? normaliseFields(v) : v;
      q.run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, JSON.stringify(stored));
    }
    return all();
  }
  return { all, get, set };
}

/** Give every field a stable key (from its label, kept when the label is edited later) and a clean shape. */
function normaliseFields(list) {
  const used = new Set(list.map((f) => f.key).filter(Boolean));
  return list.map((f) => {
    let key = f.key;
    if (!key) {
      const base = String(f.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'field';
      key = base; for (let i = 2; used.has(key); i++) key = `${base}_${i}`;
      used.add(key);
    }
    return { key, label: String(f.label).trim(), type: f.type, required: Boolean(f.required), show_on_driver: Boolean(f.show_on_driver), choices: f.type === 'choice' ? f.choices.map((c) => String(c).trim()) : [] };
  });
}

function validate(k, v) {
  const num = (min, max) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new AppError(`${k} must be a number from ${min} to ${max}`); };
  switch (k) {
    case 'max_tasks': if (!Number.isInteger(v) || v < 1 || v > 20) throw new AppError('max_tasks must be a whole number from 1 to 20'); break;
    case 'max_gap_minutes': case 'batch_hold_minutes': case 'return_push_minutes': case 'service_minutes_per_drop':
    case 'late_after_minutes': case 'warn_after_minutes': case 'prep_minutes': case 'default_eta_minutes': num(0, 600); break;
    case 'radius_km': num(0.5, 200); break;
    case 'trail_retention_days': if (!Number.isInteger(v) || v < 0 || v > 3650) throw new AppError('trail_retention_days must be a whole number of days from 0 (keep forever) to 3650'); break;
    case 'custom_fields': {
      if (!Array.isArray(v) || v.length > 20) throw new AppError('custom_fields must be a list of 20 fields at most');
      const keys = new Set();
      for (const f of v) {
        if (!f || typeof f !== 'object') throw new AppError('Each custom field needs a label and a type');
        const label = String(f.label ?? '').trim();
        if (!label || label.length > 40) throw new AppError('Each custom field needs a label of 1 to 40 characters');
        if (!FIELD_TYPES.includes(f.type)) throw new AppError(`Custom field "${label}": type must be one of ${FIELD_TYPES.join(', ')}`);
        if (f.key !== undefined && !/^[a-z0-9_]{1,40}$/.test(f.key)) throw new AppError(`Custom field "${label}" has a bad key`);
        if (f.key) { if (keys.has(f.key)) throw new AppError(`Two custom fields share the key "${f.key}"`); keys.add(f.key); }
        if (f.type === 'choice' && (!Array.isArray(f.choices) || f.choices.length < 2 || f.choices.length > 20 || f.choices.some((c) => !String(c).trim() || String(c).length > 60))) throw new AppError(`Custom field "${label}": a choice field needs 2 to 20 choices`);
        if (f.type === 'checkbox' && f.required) throw new AppError(`Custom field "${label}": a checkbox cannot be required (unticked is a valid answer)`);
      }
      if (new Set(v.map((f) => String(f.label).trim().toLowerCase())).size !== v.length) throw new AppError('Two custom fields have the same label');
      break;
    }
    case 'cluster_merge_km': num(0, 50); break;
    case 'min_order_pence': num(0, 100000); break;
    case 'timezone': if (typeof v !== 'string' || !validTz(v)) throw new AppError('timezone must be a valid zone like Europe/London'); break;
    case 'strategy': if (!STRATEGIES.includes(v)) throw new AppError(`strategy must be one of ${STRATEGIES.join(', ')}`); break;
    case 'open': case 'sound': case 'show_driver_phone': if (typeof v !== 'boolean') throw new AppError(`${k} must be true or false`); break;
    case 'excluded_outcodes': if (!Array.isArray(v) || v.some((x) => !/^[A-Z]{1,2}\d[A-Z\d]?$/.test(x))) throw new AppError('excluded_outcodes must be a list of postcode districts like "SW4"'); break;
    case 'fee_bands': if (!Array.isArray(v) || v.some((b) => !(b.up_to_km > 0) || !Number.isInteger(b.fee_pence) || b.fee_pence < 0)) throw new AppError('fee_bands must be a list of { up_to_km, fee_pence }'); break;
    case 'store': if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number') throw new AppError('store needs lat and lng'); break;
    default:
  }
}
