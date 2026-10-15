/** Custom order fields (Settings-managed): check what came in against the field list, and shape it for the driver app. */
import { AppError } from './util.js';

/** `input` is { [key]: value }. Returns the clean object to store. `enforceRequired` is true for orders typed in by the admin. */
export function cleanCustom(fields, input, { enforceRequired = false } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const f of fields) {
    let v = raw[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    if (f.type === 'checkbox') { out[f.key] = v === true || v === 'true' || v === 1; continue; }
    if (empty) {
      if (f.required && enforceRequired) throw new AppError(`${f.label} is needed`, 422, 'custom_field');
      continue;
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < -1e9 || n > 1e9) throw new AppError(`${f.label} must be a number`, 422, 'custom_field');
      out[f.key] = n;
    } else if (f.type === 'choice') {
      const c = String(v).trim();
      if (!f.choices.includes(c)) throw new AppError(`${f.label} must be one of: ${f.choices.join(', ')}`, 422, 'custom_field');
      out[f.key] = c;
    } else {
      const t = String(v).trim().replace(/\s+/g, ' ');
      if (t.length > 200) throw new AppError(`${f.label} is too long (200 characters at most)`, 422, 'custom_field');
      out[f.key] = t;
    }
  }
  return out;
}

const shown = (f, v) => (f.type === 'checkbox' ? (v ? 'Yes' : 'No') : String(v));

/** [{ key, label, type, value }] for the fields that currently exist and have an answer (ticked checkboxes only). */
export function describeCustom(fields, custom) {
  const c = custom || {};
  return fields.filter((f) => (f.type === 'checkbox' ? c[f.key] === true : c[f.key] !== undefined && c[f.key] !== null))
    .map((f) => ({ key: f.key, label: f.label, type: f.type, value: shown(f, c[f.key]), show_on_driver: f.show_on_driver }));
}

/** What the driver app sees: only the fields marked show-on-driver. */
export const driverCustom = (fields, custom) => describeCustom(fields, custom).filter((f) => f.show_on_driver).map(({ label, value }) => ({ label, value }));
