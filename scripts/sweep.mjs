#!/usr/bin/env node
// Disk hygiene: remove stale test artifacts. Run at the start and end of every pass (npm test does both).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let removed = 0;
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); removed++; } catch { /* already gone */ } };

const sandbox = path.join(root, '.tmp-test');
if (fs.existsSync(sandbox)) for (const e of fs.readdirSync(sandbox)) rm(path.join(sandbox, e));

for (const dir of new Set([os.tmpdir(), '/tmp'])) {
  try { for (const e of fs.readdirSync(dir)) if (/^(tad-test-|tad-delivery-test-)/.test(e)) rm(path.join(dir, e)); } catch { /* unreadable */ }
}
if (removed) console.log(`sweep: removed ${removed} stale test item(s)`);
