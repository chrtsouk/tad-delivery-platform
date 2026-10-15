#!/usr/bin/env node
// Puts the TAD logo (and ONLY the logo — no restyling) into Fleetbase's Branding settings, and syncs the delivery radius
// into a Fleetbase service area. Needs the Fleetbase admin e-mail + password: FLEETBASE_ADMIN_EMAIL / FLEETBASE_ADMIN_PASSWORD
// (or docker/fleetbase/.admin-password written by the local setup). Safe to re-run.
import fs from 'node:fs';
import { loadEnvFile, loadConfig } from '../lib/config.js';

loadEnvFile();
const base = process.env.FLEETBASE_URL || 'http://localhost:8000';
const email = process.env.FLEETBASE_ADMIN_EMAIL || 'admin@texasafterdark.co.uk';
const password = process.env.FLEETBASE_ADMIN_PASSWORD || (fs.existsSync('docker/fleetbase/.admin-password') ? fs.readFileSync('docker/fleetbase/.admin-password', 'utf8').trim() : '');
if (!password) { console.error('Set FLEETBASE_ADMIN_PASSWORD'); process.exit(1); }

const j = async (path, opts = {}) => {
  const res = await fetch(base + path, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await res.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${typeof d === 'string' ? d.slice(0, 200) : JSON.stringify(d).slice(0, 300)}`);
  return d;
};
const { token } = await j('/int/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: email, password }) });
const auth = { Authorization: `Bearer ${token}` };

const upload = async (file, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'image/png' }), name);
  fd.append('path', 'uploads/branding'); fd.append('type', 'branding');
  return j('/int/v1/files/upload', { method: 'POST', headers: auth, body: fd });
};
const up = await upload('assets/tad-logo-512.png', 'tad-logo.png');
const logo = up.file ?? up;
await j('/int/v1/settings/branding', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: { logo_uuid: logo.uuid, icon_uuid: logo.uuid } }) });
console.log('Fleetbase branding set to the TAD logo');
