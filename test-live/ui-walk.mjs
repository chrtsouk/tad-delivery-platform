// LIVE browser walkthrough (real headless Chrome) against the running local stack. Screenshots go to .tmp-test/ui/.
// Run after scripts/start-all.sh (server on PORT, default 4100): node test-live/ui-walk.mjs
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { loadEnvFile } from '../lib/config.js';

loadEnvFile();
const base = process.env.WALK_URL || 'http://localhost:4100';
fs.mkdirSync('.tmp-test/ui', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/tile\.openstreetmap|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `.tmp-test/ui/${n}.png` });
const ok = (m) => console.log('✔', m);

// start from a clean slate: finish anything left from an earlier run
const A = { Authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, 'Content-Type': 'application/json' };
const api = async (m, p, b) => (await fetch(base + p, { method: m, headers: A, body: b ? JSON.stringify(b) : undefined })).json();
let board = await api('GET', '/api/board');
for (const b of board.batches.filter((x) => x.status === 'assigned')) await api('POST', `/api/batcher/runs/${b.id}/out`);
board = await api('GET', '/api/board');
for (const o of board.orders.filter((x) => ['out'].includes(x.state))) await api('POST', `/api/orders/${o.id}/transition`, { to: 'delivered' });
for (const o of (await api('GET', '/api/board')).orders.filter((x) => ['new', 'accepted', 'preparing', 'ready'].includes(x.state))) await api('POST', `/api/orders/${o.id}/transition`, { to: 'cancelled', reason: 'ui-walk cleanup' });
await page.goto(base);
await page.fill('#pw', process.env.ADMIN_PASSWORD);
await page.click('button[type=submit]');
await page.waitForSelector('header.top');
ok('signed in');
await shot('01-board-empty');

// Drivers: clock a real Fleetbase driver in
await page.click('nav >> text=Drivers');
await page.waitForSelector('text=Test Driver');
const dcard = page.locator('.drv-card, article, .card', { hasText: 'Test Driver' }).first();
if (await dcard.getByRole('button', { name: /clock in/i }).count()) await dcard.getByRole('button', { name: /clock in/i }).click();
await dcard.getByRole('button', { name: /clock out/i }).waitFor();
ok('driver clocked in via the UI');
await shot('02-drivers');

// Add order: phone, address search through Photon, then submit
await page.click('nav >> text=Add order');
await page.getByLabel(/phone/i).first().fill('07700 900111');
const search = page.getByPlaceholder(/search|address|postcode/i).first();
await search.fill('10 Downing Street');
await page.waitForSelector('text=/Downing/i', { timeout: 15000 });
await shot('03-add-search');
await page.getByRole('option', { name: /10 Downing Street/i }).first().click();
await page.getByLabel(/name/i).first().fill('Walk Test');
const item = page.getByPlaceholder(/item/i).first();
if (await item.count()) await item.fill('Wings');
await page.getByRole('button', { name: /^(add|create|place|save).*order/i }).first().click();
await page.waitForSelector('text=/TAD-\\d{8}-\\d+/', { timeout: 15000 });
const number = (await page.locator('text=/TAD-\\d{8}-\\d+/').first().innerText()).match(/TAD-\d{8}-\d+/)[0];
ok(`order created through the form: ${number}`);
await shot('04-add-done');

// Board: accept -> ready -> lands with the driver
await page.click('nav >> text=Board');
const card = () => page.locator(`[aria-label^="Order ${number}"]`).first();
await card().waitFor({ timeout: 15000 });
await card().getByRole('button', { name: 'Accept' }).click();
await page.waitForTimeout(1000);
await card().getByRole('button', { name: 'Ready', exact: true }).click();
await page.locator('.brd-col.drivers', { hasText: 'Test Driver' }).locator(`[aria-label^="Order ${number}"]`).waitFor({ timeout: 30000 });
ok('order accepted, marked ready and batched onto the driver lane (real VROOM/OSRM/Fleetbase)');
await shot('05-board-assigned');

await page.click('nav >> text=Scan');
await page.getByLabel('Order number').fill(number);
await page.getByRole('button', { name: 'Check' }).click();
await page.waitForSelector('text=/Hand to Test Driver|Already out with/', { timeout: 10000 });
ok('shop-side bag check says whose bag it is');
await shot('05b-scan');
for (const [name, sel] of [['Calendar', 'text=Calendar'], ['Analytics', 'text=Analytics'], ['Audit', 'text=Audit'], ['Settings', 'text=Settings']]) {
  await page.click(`nav >> ${sel}`);
  await page.waitForTimeout(1200);
  await shot(`06-${name.toLowerCase()}`);
  ok(`${name} page renders`);
}
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
console.log(JSON.stringify({ number }));
await browser.close();
