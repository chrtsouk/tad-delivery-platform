#!/usr/bin/env node
// Generates the local secrets into .env.local (gitignored). Never prints them. Existing values are kept.
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = '.env.local';
const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const keys = { ADMIN_PASSWORD: 18, ADMIN_API_TOKEN: 24, SESSION_SECRET: 32, TRACK_SECRET: 32, OWN_SITE_API_KEY: 24 };
let add = '';
for (const [k, n] of Object.entries(keys)) if (!new RegExp(`^${k}=`, 'm').test(have)) add += `${k}=${crypto.randomBytes(n).toString('base64url')}\n`;
if (add) { fs.writeFileSync(file, have + (have && !have.endsWith('\n') ? '\n' : '') + add, { mode: 0o600 }); console.log(`wrote new secrets to ${file}`); } else console.log('secrets already present');
