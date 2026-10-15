// Browser walkthrough of the four additions (route history, custom fields, flags/blocks, incidents) against the in-memory demo server.
// Run: PORT=4101 node scripts/demo.mjs &   then   node test-live/ui-walk-additions.mjs      Screenshots: .tmp-test/ui-add/ (swept by npm run sweep)
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.WALK_URL || 'http://localhost:4101';
const A = { Authorization: 'Bearer demo-token', 'Content-Type': 'application/json' };
fs.mkdirSync('.tmp-test/ui-add', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/tile\.openstreetmap|Failed to load resource|ERR_/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `.tmp-test/ui-add/${n}.png` });
const ok = (m) => console.log('✔', m);
const api = async (m, p, b, headers = A) => { const r = await fetch(base + p, { method: m, headers, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; };

await page.goto(base);
await page.fill('#pw', 'demo'); await page.click('button[type=submit]');
await page.waitForSelector('nav');
ok('signed in');

/* Settings: custom fields + GPS retention */
await page.goto(`${base}/settings`);
await page.waitForSelector('#set-custom');
await page.click('text=+ Add a field');
await page.fill('input[id^="cf-l-"]', 'Gate code');
await page.getByLabel('Required on Add order').first().check(); await page.getByLabel('Show to driver').first().check();
await page.click('text=+ Add a field');
const labels = page.locator('input[id^="cf-l-"]');
await labels.nth(1).fill('Spice level');
await page.locator('select[id^="cf-t-"]').nth(1).selectOption('choice');
await page.fill('input[id^="cf-c-"]', 'Mild, Hot, Extra hot');
await page.locator('#set-custom ~ form button[type=submit]').click();
await page.waitForSelector('#set-custom ~ form .ok');
await page.fill('#g-days', '45');
await page.locator('#set-trails ~ form button[type=submit]').click();
await page.waitForSelector('#set-trails ~ form .ok');
await shot('1-settings');
const s = (await api('GET', '/api/settings')).data;
assert.equal(s.custom_fields.length, 2); assert.equal(s.trail_retention_days, 45);
ok('Settings: custom fields and GPS retention saved');

/* Flags page: block a phone */
await page.goto(`${base}/flags`);
await page.click('text=Flag or block…');
await page.fill('#fl-phone', '07700 900555');
await page.click('role=radio[name="Block (refuse new orders)"]');
await page.fill('#fl-reason', 'Abusive to a driver');
await page.click('.ui-modal button[type=submit]');
await page.waitForSelector('.flg-item.blocked');
await shot('2-flags');
ok('Flags page: phone blocked and listed');

/* Add order: blocked warning, required custom field, override */
await page.goto(`${base}/add`);
await page.fill('#add-phone', '07700 900555');
await page.waitForSelector('.add-flag.blocked');
await page.fill('#add-name', 'Rob'); await page.fill('#add-line1', '4 Test Rd'); await page.fill('#add-pc', 'SW11 5XX');
await page.fill('input[aria-label="Item 1 name"]', 'Wings');
await page.selectOption('#cf-spice_level', 'Hot');
await page.click('button:has-text("Add order")');
await page.waitForSelector('text=Gate code is needed');
await page.fill('#cf-gate_code', '4321');
await page.click('button:has-text("Add order")');
await page.waitForSelector('text=is blocked');
await shot('3-add-blocked');
await page.click('text=Add anyway (override block)');
await page.waitForSelector('.add-done');
assert.ok(await page.locator('text=Added over a block').count());
await shot('4-added-over-block');
ok('Add order: custom fields enforced, block warned and overridden');

/* Board card: custom lines, red flag, report incident */
await page.goto(base);
await page.waitForSelector('.brd-flag.blocked');
assert.ok(await page.locator('.brd-custom:has-text("Gate code: 4321")').count());
const card = page.locator('.brd-card', { has: page.locator('.brd-flag.blocked') }).first();
await card.locator('.brd-more').click();
await card.locator('button:has-text("Report incident")').click();
await page.selectOption('#inc-type', 'customer_conduct');
await page.fill('#inc-note', 'Customer was rude at the door');
await page.setInputFiles('#inc-photo', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') });
await page.waitForSelector('img[alt="Preview of the photo to attach"]');
await shot('5-incident-modal');
await page.click('button:has-text("Save incident")');
await page.waitForSelector('text=Incident saved');
ok('Board: card shows custom fields + red flag, incident reported with photo');

await page.goto(`${base}/incidents`);
await page.waitForSelector('.inc-item.open');
assert.ok(await page.locator('.inc-item img').count());
await shot('6-incidents');
const csv = await fetch(`${base}/api/incidents.csv`, { headers: A }); assert.equal(csv.status, 200);
await page.click('button:has-text("Resolve")'); await page.fill('#ui-ask-field', 'Called the customer'); await page.click('button:has-text("Mark resolved")');
await page.waitForSelector('.inc-item.resolved');
ok('Incidents page: listed with photo, resolved, CSV export works');

/* Drivers: route history */
const tok = (await api('POST', '/api/drivers/driver_dan/token')).data.token;
const D = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const t0 = Date.now();
const pts = Array.from({ length: 12 }, (_, i) => ({ lat: 51.4651 + i * 0.0015, lng: -0.1701 + i * 0.002, at: new Date(t0 - (12 - i) * 40000).toISOString() }));
assert.equal((await api('POST', '/driver/location', { points: pts }, D)).data.kept, 12);
await page.goto(`${base}/drivers`);
await page.waitForSelector('.drv-card');
await page.locator('.drv-card', { hasText: 'Dan Rivers' }).locator('button:has-text("Route history")').click();
await page.waitForSelector('input[aria-label="Position along the route"]');
await page.waitForTimeout(800);
assert.ok(await page.locator('text=12 points').count());
await page.click('button:has-text("Play")'); await page.waitForTimeout(500);
await shot('7-route-history');
ok('Drivers: route history replays 12 saved points');

await browser.close();
assert.deepEqual(errors, [], `browser errors: ${errors.join(' | ')}`);
ok('no browser console errors');
