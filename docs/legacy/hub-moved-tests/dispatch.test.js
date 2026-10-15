/**
 * Owner note 18, the connected system: customers, drivers, deliveries, a run-builder by postcode and capacity, the driver's
 * own API, the customer's tracking link, and the public API for an ordering website. All the personal data is guarded.
 */
import { setup, db } from './helpers.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import dispatch from '../server/core/dispatch.js';
import kitchen from '../server/core/kitchen.js';
import settings from '../server/core/settings.js';
import integrations from '../server/core/integrations.js';
import analytics from '../server/core/analytics.js';
import sitesCore from '../server/core/sites.js';
import group from '../server/core/group.js';
import users from '../server/core/users.js';
import { resetTrackLimits, trackLimiterSizes } from '../server/trackpage.js';
import { createApp } from '../server/index.js';

setup();

const order = (n = 1) => kitchen.create({ lines: [{ name: 'Wings', qty: n }], placed_at: '2027-05-14T20:00:00' });
const drop = (o = {}) => dispatch.create({ recipient: 'Sam Smith', phone: '07700 900123', address: '1 High St', postcode: 'sw11 1ab', items: 1, ...o });

test('postcodes, phones and items are checked and tidied; a drop needs somewhere to go', () => {
  assert.deepEqual(dispatch.normalisePostcode(' sw11  1ab '), { postcode: 'SW11 1AB', area: 'SW11' });
  assert.deepEqual(dispatch.normalisePostcode('E1 6AN'), { postcode: 'E1 6AN', area: 'E1' });
  assert.equal(dispatch.normalisePostcode('W1A 1AA').area, 'W1A');
  for (const bad of ['', 'hello', '12345', 'SW11', 'SW11 1A']) assert.throws(() => dispatch.normalisePostcode(bad), /UK postcode/, bad);
  assert.throws(() => drop({ address: '' }), /address is needed/);
  assert.throws(() => drop({ recipient: '' }), /Who it is for/);
  assert.throws(() => drop({ postcode: 'nope' }), /UK postcode/);
  assert.throws(() => drop({ phone: 'abc' }), /phone number/);
  assert.throws(() => drop({ items: 0 }), /whole number/);
  assert.throws(() => drop({ items: 1.5 }), /whole number/);
  assert.throws(() => drop({ items: 9999 }), /whole number/);
  assert.throws(() => drop({ promised_at: 'soon' }), /not a time/);
  assert.throws(() => drop({ address: 'x'.repeat(201) }), /too long/);
  const d = drop();
  assert.equal(d.postcode, 'SW11 1AB');
  assert.equal(d.area, 'SW11');
  assert.equal(d.phone, '07700900123');
  assert.equal(d.status, 'waiting');
});

test('a delivery made from a kitchen order counts its items, takes its time, and cannot be made twice', () => {
  const o = order(3);
  const d = drop({ kitchen_order_id: o.id, items: undefined });
  assert.equal(d.items, 3);
  assert.equal(d.order_number, o.number);
  assert.equal(d.placed_at, o.placed_at);
  const again = drop({ kitchen_order_id: o.id });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, d.id);
  assert.throws(() => drop({ kitchen_order_id: 'nope' }), /not here/);
  const other = group.saveSite({ code: 'LDN9', name: 'Elsewhere', kind: 'kitchen' }).id;
  assert.throws(() => drop({ kitchen_order_id: kitchen.create({ site_id: other, lines: [{ name: 'x', qty: 1 }] }).id }), /another site/);
  const c = order(); kitchen.cancel(c.id, { reason: 'customer rang' });
  assert.throws(() => drop({ kitchen_order_id: c.id }), /cancelled/);
  dispatch.cancel(d.id, { reason: 'test' });
  assert.equal(drop({ kitchen_order_id: o.id }).duplicate, false, 'once cancelled, the order can have a new delivery');
});

test('customers: saved once per phone, remembered from a drop, and erased for good on request', () => {
  const c = dispatch.saveCustomer({ name: 'Ann Lee', phone: '07700 900555', email: 'ANN@example.com', address: '5 Low Rd', postcode: 'e1 6an', marketing_ok: true });
  assert.equal(c.email, 'ann@example.com');
  assert.equal(c.postcode, 'E1 6AN');
  assert.throws(() => dispatch.saveCustomer({ name: 'Other', phone: '07700 900555' }), /already has that phone/);
  assert.throws(() => dispatch.saveCustomer({ name: '' }), /name is needed/);
  assert.throws(() => dispatch.saveCustomer({ name: 'x', email: 'no' }), /email/);
  const d = dispatch.create({ customer_id: c.id, items: 2 });
  assert.equal(d.recipient, 'Ann Lee');
  assert.equal(d.address, '5 Low Rd');
  assert.equal(d.area, 'E1');
  const remembered = drop({ recipient: 'Bo New', phone: '07700 900666', remember: true });
  assert.ok(remembered.customer_id);
  assert.equal(drop({ recipient: 'Bo New', phone: '07700 900666', remember: true }).customer_id, remembered.customer_id, 'the same phone is the same customer');
  assert.equal(dispatch.customers({ q: 'ann' }).length, 1);
  assert.equal(dispatch.customers({ q: 'E1 6' }).length, 1);

  dispatch.addMessage(d.id, { from_kind: 'customer', from_name: 'Ann', body: 'Ring the bell twice' });
  dispatch.eraseCustomer(c.id);
  const gone = dispatch.get(d.id);
  assert.equal(gone.recipient, null);
  assert.equal(gone.address, null);
  assert.equal(gone.phone, null);
  assert.equal(gone.area, 'E1', 'the area and times stay: the kitchen\'s own record');
  assert.equal(dispatch.messages(d.id)[0].body, '(erased)');
  assert.equal(dispatch.customers({ q: 'ann' }).length, 0);
  assert.equal(db.get('SELECT * FROM customers WHERE id = ?', [c.id]).phone, null);
  assert.throws(() => dispatch.saveCustomer({ id: c.id, name: 'Ann' }), /erased/);
  assert.throws(() => dispatch.create({ customer_id: c.id }), /erased/);
});

test('drivers: a name, a limit that is the owner\'s own, and a key shown once', () => {
  const a = dispatch.saveDriver({ name: 'Dan Driver', phone: '07700 900001', vehicle: 'Scooter', max_items: 4 });
  assert.equal(a.max_items, 4);
  assert.equal(a.state, 'free');
  assert.equal(a.has_key, false);
  assert.throws(() => dispatch.saveDriver({ name: 'dan driver' }), /already a driver/);
  assert.throws(() => dispatch.saveDriver({ name: '' }), /name is needed/);
  assert.throws(() => dispatch.saveDriver({ name: 'Z', max_items: 0 }), /whole number/);
  assert.equal(dispatch.saveDriver({ name: 'Free Fran' }).max_items, null, 'no limit unless the owner sets one');

  const { key } = dispatch.newDriverKey(a.id);
  assert.match(key, /^drv_[0-9a-f]{48}$/);
  assert.equal(dispatch.authenticateDriver(key).id, a.id);
  assert.equal(dispatch.authenticateDriver(key + 'x'), null);
  assert.equal(dispatch.authenticateDriver('tad_notadriverkey'), null);
  assert.equal(dispatch.authenticateDriver(''), null);
  assert.ok(!JSON.stringify(dispatch.drivers()).includes(key), 'the key is never given back');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM drivers')).includes(key), 'and never stored');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM change_log')).includes(key));
  const second = dispatch.newDriverKey(a.id).key;
  assert.equal(dispatch.authenticateDriver(key), null, 'a new key kills the old one at once');
  assert.equal(dispatch.authenticateDriver(second).id, a.id);
  dispatch.revokeDriverKey(a.id);
  assert.equal(dispatch.authenticateDriver(second), null);
});

test('giving out drops: only waiting ones, within the driver\'s limit unless told otherwise, and taking back', () => {
  const dan = dispatch.drivers().find((d) => d.name === 'Dan Driver');
  const fran = dispatch.drivers().find((d) => d.name === 'Free Fran');
  const x = drop({ items: 3 }); const y = drop({ items: 2 });
  assert.throws(() => dispatch.assign(dan.id, []), /at least one/);
  assert.throws(() => dispatch.assign('nope', [x.id]), /not here/);
  assert.equal(dispatch.assign(dan.id, [x.id])[0].status, 'assigned');
  assert.equal(dispatch.drivers().find((d) => d.id === dan.id).room, 1);
  assert.equal(dispatch.drivers().find((d) => d.id === dan.id).state, 'loaded');
  assert.throws(() => dispatch.assign(dan.id, [y.id]), (e) => e.status === 409 && /takes 4 items at most and would have 5/.test(e.message) && e.details.over === true);
  assert.equal(dispatch.get(y.id).status, 'waiting', 'nothing half-done');
  assert.throws(() => dispatch.assign(dan.id, [x.id]), /only waiting/);
  assert.equal(dispatch.assign(dan.id, [y.id], { allow_over: true })[0].driver_name, 'Dan Driver');
  assert.equal(dispatch.assign(fran.id, [drop({ items: 40 }).id])[0].status, 'assigned', 'no limit set: any size');
  assert.equal(dispatch.unassign(y.id).status, 'waiting');
  assert.equal(dispatch.get(y.id).driver_id, null);
  assert.throws(() => dispatch.unassign(y.id), /waiting, so it cannot/);
  dispatch.saveDriver({ id: fran.id, name: 'Free Fran' });
  assert.throws(() => dispatch.saveDriver({ id: fran.id, name: 'Free Fran', active: false }), /still has 1 drop/);
  dispatch.cancel(dispatch.get(dispatch.board({}).assigned.find((d) => d.items === 40).id).id, { reason: 'test over' });
  dispatch.saveDriver({ id: fran.id, name: 'Free Fran', active: false });
  assert.throws(() => dispatch.assign(fran.id, [y.id]), /not working/);
  dispatch.saveDriver({ id: fran.id, name: 'Free Fran', active: true });
});

test('leaving, delivered, failed and cancelled: each needs the right state, and a reason where it matters; leaving bumps the kitchen order', () => {
  const dan = dispatch.drivers().find((d) => d.name === 'Dan Driver');
  for (const d of dispatch.board({}).assigned) dispatch.unassign(d.id);
  const o = order(2);
  kitchen.ready(o.id);
  const d = drop({ kitchen_order_id: o.id, items: undefined });
  assert.throws(() => dispatch.markDelivered(d.id), /waiting, so it cannot/);
  assert.throws(() => dispatch.sendOut(dan.id), /nothing loaded/);
  dispatch.assign(dan.id, [d.id]);
  assert.throws(() => dispatch.sendOut(dispatch.drivers().find((x) => x.name === 'Free Fran').id, [d.id]), /not loaded on/);
  assert.equal(kitchen.get(o.id).status, 'ready');
  const out = dispatch.sendOut(dan.id);
  assert.equal(out[0].status, 'out');
  assert.ok(out[0].out_at);
  assert.equal(kitchen.get(o.id).status, 'bumped', 'the food has left the kitchen');
  assert.equal(dispatch.drivers().find((x) => x.id === dan.id).state, 'on_run');
  assert.throws(() => dispatch.markFailed(d.id, { reason: '' }), /Say why/);
  assert.throws(() => dispatch.markFailed(d.id, { reason: 'no' }), /Say why/);
  const done = dispatch.markDelivered(d.id);
  assert.equal(done.status, 'delivered');
  assert.ok(Number.isInteger(done.took_minutes) && done.took_minutes >= 0, 'how long it took, from the order to the door');
  assert.throws(() => dispatch.cancel(d.id, { reason: 'too late' }), /delivered, so it cannot/);
  assert.throws(() => dispatch.markDelivered(d.id), /delivered, so it cannot/);
  const f = drop(); dispatch.assign(dan.id, [f.id]); dispatch.sendOut(dan.id);
  assert.equal(dispatch.markFailed(f.id, { reason: 'Nobody home' }).failed_reason, 'Nobody home');
  assert.throws(() => dispatch.cancel(drop().id, { reason: '' }), /Say why/);
  const board = dispatch.board({});
  assert.equal(board.delivered_tonight, 1);
  assert.equal(board.failed_tonight, 1);
});

test('the run suggestion: oldest first, nearest postcodes together, within each driver\'s room, nothing changed', () => {
  for (const x of [...dispatch.board({}).waiting, ...dispatch.board({}).assigned]) dispatch.cancel(x.id, { reason: 'clear for suggestion test' });
  for (const dr of dispatch.drivers()) dispatch.saveDriver({ id: dr.id, name: dr.name, active: false });
  const A = dispatch.saveDriver({ name: 'Ann Runner', max_items: 4 });
  const B = dispatch.saveDriver({ name: 'Ben Runner', max_items: 3 });
  const mk = (at, pc, items) => drop({ postcode: pc, items, recipient: `to ${pc}` }) && db.get('SELECT * FROM deliveries ORDER BY created_at DESC, rowid DESC LIMIT 1');
  const t = (m) => `2027-05-14T20:${String(m).padStart(2, '0')}:00.000Z`;
  const d1 = dispatch.create({ recipient: 'one', address: 'a', postcode: 'SW11 1AA', items: 2 }); db.run('UPDATE deliveries SET placed_at = ? WHERE id = ?', [t(0), d1.id]);
  const d2 = dispatch.create({ recipient: 'two', address: 'a', postcode: 'E1 1AA', items: 1 }); db.run('UPDATE deliveries SET placed_at = ? WHERE id = ?', [t(5), d2.id]);
  const d3 = dispatch.create({ recipient: 'three', address: 'a', postcode: 'SW12 1AA', items: 2 }); db.run('UPDATE deliveries SET placed_at = ? WHERE id = ?', [t(10), d3.id]);
  const d4 = dispatch.create({ recipient: 'four', address: 'a', postcode: 'SW11 2BB', items: 1 }); db.run('UPDATE deliveries SET placed_at = ? WHERE id = ?', [t(15), d4.id]);
  void mk;
  const s = dispatch.suggest({});
  console.log(JSON.stringify({s, drivers: dispatch.drivers()}, null, 1).slice(0, 3000));
  const runA = s.runs.find((r) => r.driver_id === A.id);
  const runB = s.runs.find((r) => r.driver_id === B.id);
  assert.deepEqual(runA.delivery_ids, [d1.id, d4.id], 'the oldest drop and its neighbour in SW11; SW12 does not fit the room left');
  assert.equal(runA.items, 3);
  assert.deepEqual(runA.areas, ['SW11']);
  assert.deepEqual(runB.delivery_ids, [d2.id], 'the next oldest, from a different part of town, goes alone');
  assert.deepEqual(s.left.map((d) => d.id), [d3.id]);
  assert.match(s.note, /no map/);
  assert.equal(dispatch.get(d1.id).status, 'waiting', 'a suggestion changes nothing');
  assert.ok(!s.runs.some((r) => r.over));

  // and the suggestion can be carried out as given
  for (const r of s.runs) dispatch.assign(r.driver_id, r.delivery_ids);
  assert.equal(dispatch.get(d1.id).status, 'assigned');

  // a drop bigger than any limit is not forced on a driver who already has work; with an empty driver and nothing else, it goes alone and says so
  dispatch.cancel(d3.id, { reason: 'test' });
  const big = dispatch.create({ recipient: 'big', address: 'a', postcode: 'N1 1AA', items: 9 });
  assert.deepEqual(dispatch.suggest({}).runs, [], 'both drivers are loaded: nothing is forced on them');
  const C = dispatch.saveDriver({ name: 'Cy Runner', max_items: 2 });
  const over = dispatch.suggest({}).runs.find((r) => r.driver_id === C.id);
  assert.deepEqual(over.delivery_ids, [big.id]);
  assert.equal(over.items, 9);
  assert.equal(over.over, true);
  dispatch.cancel(big.id, { reason: 'test' });
  dispatch.saveDriver({ id: C.id, name: 'Cy Runner', active: false });
});

test('the driver sees only their own run, reports a place that is on Earth, and moves only their own drops', () => {
  const dan = dispatch.drivers().find((d) => d.name === 'Ann Runner');
  const ben = dispatch.drivers().find((d) => d.name === 'Ben Runner');
  const run = dispatch.driverRun(db.get('SELECT * FROM drivers WHERE id = ?', [dan.id]));
  assert.deepEqual(run.deliveries.map((d) => d.recipient).sort(), ['four', 'one']);
  assert.ok(run.deliveries.every((d) => d.address && d.phone !== undefined));
  assert.ok(!JSON.stringify(run).includes('three'), 'not someone else\'s drop');
  const driverBen = db.get('SELECT * FROM drivers WHERE id = ?', [ben.id]);
  const driverAnn = db.get('SELECT * FROM drivers WHERE id = ?', [dan.id]);
  assert.throws(() => dispatch.driverSetStatus(driverBen, run.deliveries[0].id, 'out'), /not on your run/);
  assert.throws(() => dispatch.driverSetStatus(driverAnn, run.deliveries[0].id, 'cancelled'), /out, delivered or failed/);
  assert.equal(dispatch.driverSetStatus(driverAnn, run.deliveries[0].id, 'out').status, 'out');
  assert.throws(() => dispatch.driverSetStatus(driverAnn, run.deliveries[0].id, 'failed', {}), /Say why/);
  for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }, { lat: 'x', lng: 1 }, {}]) assert.throws(() => dispatch.ping(dan.id, bad), /Earth/);
  dispatch.ping(dan.id, { lat: 51.4612345678, lng: -0.1632 });
  const after = dispatch.drivers().find((d) => d.id === dan.id);
  assert.equal(after.last_lat, 51.461235);
  assert.ok(after.last_seen_at);
  assert.equal(db.all("SELECT * FROM change_log WHERE entity = 'driver' AND field = 'last_lat'").length, 0, 'a position is not a change-log entry');
});

test('tracking: off until switched on; shows the customer their order and no one else\'s details; team notes never reach it', () => {
  const t = db.get("SELECT * FROM deliveries WHERE recipient = 'one'").tracking_token;
  assert.equal(dispatch.tracking(t), null, 'off by default');
  settings.set('tracking_enabled', true);
  assert.equal(dispatch.tracking('nonsense token!'), null);
  assert.equal(dispatch.tracking('x'.repeat(65)), null);
  assert.equal(dispatch.tracking('unknownunknownunknown'), null);
  const d = dispatch.tracking(t);
  assert.equal(d.status, 'out');
  assert.equal(d.driver, 'Ann', 'first name only');
  assert.equal(d.items, 2);
  assert.equal(d.position.lat, 51.461235);
  assert.ok(d.position.seen_minutes_ago >= 0);
  const flat = JSON.stringify(d);
  for (const secret of ['1 High', '07700', 'Sam Smith']) assert.ok(!flat.includes(secret), `${secret} must not be on the tracking page`);
  assert.ok(!('address' in d) && !('phone' in d) && !('recipient' in d));

  const id = db.get("SELECT id FROM deliveries WHERE recipient = 'one'").id;
  dispatch.addMessage(id, { from_kind: 'driver', from_name: 'Ann', body: 'customer never answers, skip him' });
  dispatch.addMessage(id, { from_kind: 'driver', from_name: 'Ann', body: 'Two minutes away!', audience: 'all' });
  dispatch.addMessage(id, { from_kind: 'office', from_name: 'Sam', body: 'internal: refund him', audience: 'team' });
  assert.throws(() => dispatch.addMessage(id, { from_kind: 'office', body: 'x', audience: 'everyone' }), /team, or all/);
  assert.throws(() => dispatch.addMessage(id, { from_kind: 'nobody', body: 'x' }), /from/);
  assert.throws(() => dispatch.addMessage(id, { from_kind: 'office', body: '' }), /message is needed/);
  assert.throws(() => dispatch.addMessage(id, { from_kind: 'office', body: 'x'.repeat(301) }), /too long/);
  assert.deepEqual(dispatch.tracking(t).messages.map((m) => m.body), ['Two minutes away!']);
  assert.equal(dispatch.messages(id).length, 3, 'the team sees all of it');
  dispatch.trackingMessage(t, 'Please leave it with the neighbour');
  assert.equal(dispatch.tracking(t).messages.length, 2);
  assert.equal(dispatch.messages(id).at(-1).audience, 'all');
  for (let i = 0; i < 4; i++) dispatch.trackingMessage(t, `hello ${i}`);
  assert.throws(() => dispatch.trackingMessage(t, 'one too many'), (e) => e.status === 429);
  assert.equal(dispatch.trackingMessage('unknownunknownunknown', 'x'), null);
  assert.equal(dispatch.messages(id, { markRead: true }).length, 8);
  assert.equal(dispatch.get(id).unread_messages, 0);

  const done = dispatch.get(id);
  dispatch.markDelivered(done.id);
  assert.equal(dispatch.tracking(t).position, null, 'no live position once it has arrived');
  assert.throws(() => dispatch.trackingMessage(t, 'late'), /finished/);
  settings.set('tracking_enabled', false);
  assert.equal(dispatch.tracking(t), null);
});

test('personal data stays out of the analytics copy, the change log and the events feed', () => {
  settings.set('tracking_enabled', true);
  const log = JSON.stringify(db.all('SELECT * FROM change_log'));
  for (const t of db.all('SELECT tracking_token FROM deliveries').map((r) => r.tracking_token)) assert.ok(!log.includes(t), 'a tracking link is a secret');
  analytics.refresh();
  const copy = new DatabaseSync(analytics.FILE(), { readOnly: true });
  const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  copy.close();
  for (const t of ['customers', 'drivers', 'deliveries', 'delivery_messages']) assert.ok(!tables.includes(t), `${t} is not in the analytics copy`);
  fs.rmSync(analytics.FILE(), { force: true });
  const key = integrations.createKey({ name: 'events', scopes: ['events'] }).key;
  const feed = JSON.stringify(integrations.events({ after: 0, limit: 1000 }));
  for (const t of db.all('SELECT tracking_token FROM deliveries').map((r) => r.tracking_token)) assert.ok(!feed.includes(t), 'no tracking link in the events feed');
  void key;
});

/* ------------------------------------------------------------------- HTTP */

after(() => { if (server) { server.closeAllConnections?.(); server.close(); } });
let server; let base; let READ; let WRITE; let BOTH; let DRV_KEY; let DRV_ID;
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
};
const bearer = (k) => ({ Authorization: `Bearer ${k}` });

test('start the server; make keys', async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  READ = integrations.createKey({ name: 'status only', scopes: ['dispatch:read'] }).key;
  WRITE = integrations.createKey({ name: 'website', scopes: ['dispatch:write', 'orders:write'] }).key;
  BOTH = integrations.createKey({ name: 'website that also reads', scopes: ['dispatch:write', 'dispatch:read'] }).key;
  const d = dispatch.saveDriver({ name: 'App Driver', phone: '07700 900777', max_items: 5 });
  DRV_ID = d.id; DRV_KEY = dispatch.newDriverKey(d.id).key;
  resetTrackLimits();
});

test('the public API: the website makes an order and its delivery; a status-only key sees no one\'s details', async () => {
  const noScope = await call('POST', '/api/v1/deliveries', { recipient: 'x' }, bearer(READ));
  assert.equal(noScope.status, 403);
  assert.match(noScope.body.error, /dispatch:write/);
  assert.equal((await call('GET', '/api/v1/deliveries', undefined, bearer(WRITE))).status, 403);

  const ord = await call('POST', '/api/v1/orders', { source: 'website', external_ref: 'W-1', lines: [{ name: 'Wings', qty: 2 }, { name: 'Chips', qty: 1 }] }, bearer(WRITE));
  assert.equal(ord.status, 200);
  const made = await call('POST', '/api/v1/deliveries', { source: 'website', external_ref: 'W-1', recipient: 'Web Customer', phone: '07700 900888', address: '9 Web Way', postcode: 'se1 9sg', remember: true }, bearer(WRITE));
  assert.equal(made.status, 200);
  assert.equal(made.body.duplicate, false);
  assert.match(made.body.tracking_path, /^\/track\/[A-Za-z0-9_-]{24}$/);
  const again = await call('POST', '/api/v1/deliveries', { source: 'website', external_ref: 'W-1', recipient: 'Web Customer', address: '9 Web Way', postcode: 'SE1 9SG' }, bearer(WRITE));
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.id, made.body.id);
  const noOrder = await call('POST', '/api/v1/deliveries', { source: 'website', external_ref: 'NOPE', recipient: 'x', address: 'a', postcode: 'SE1 9SG' }, bearer(WRITE));
  assert.equal(noOrder.status, 404);
  assert.equal((await call('POST', '/api/v1/deliveries', { recipient: 'x', address: 'a', postcode: 'bad' }, bearer(WRITE))).status, 400);

  const list = await call('GET', '/api/v1/deliveries?status=waiting', undefined, bearer(READ));
  assert.equal(list.status, 200);
  const mine = list.body.deliveries.find((x) => x.id === made.body.id);
  assert.equal(mine.items, 3);
  assert.equal(mine.area, 'SE1');
  const flat = JSON.stringify(list.body);
  assert.ok(!flat.includes('Web Customer') && !flat.includes('9 Web Way') && !flat.includes('07700'), 'no name, address or phone for a read key');
  assert.equal((await call('GET', '/api/v1/deliveries?status=bogus', undefined, bearer(READ))).status, 400);
  const one = await call('GET', `/api/v1/deliveries/${made.body.id}`, undefined, bearer(READ));
  assert.equal(one.status, 200);
  assert.equal(one.body.tracking_path, undefined, 'a status-only key is not given the customer\'s live link');
  assert.equal((await call('GET', `/api/v1/deliveries/${made.body.id}`, undefined, bearer(BOTH))).body.tracking_path, made.body.tracking_path);
  const drv = await call('GET', '/api/v1/drivers', undefined, bearer(READ));
  assert.ok(drv.body.drivers.some((d) => d.name === 'App'), 'first name only');
  assert.ok(!JSON.stringify(drv.body).includes('07700'));
});

test('the driver app: its own key, its own run, the status steps, messages, and nothing of anyone else\'s', async () => {
  const wait = dispatch.board({}).waiting.find((d) => d.recipient === 'Web Customer');
  dispatch.assign(DRV_ID, [wait.id]);
  assert.equal((await call('GET', '/api/v1/driver/run')).status, 401);
  assert.equal((await call('GET', '/api/v1/driver/run', undefined, bearer('drv_wrong'))).status, 401);
  assert.equal((await call('GET', '/api/v1/driver/run', undefined, bearer(READ))).status, 401, 'an API key is not a driver key');
  assert.equal((await call('GET', '/api/v1/deliveries', undefined, bearer(DRV_KEY))).status, 401, 'a driver key is not an API key');
  const run = await call('GET', '/api/v1/driver/run', undefined, bearer(DRV_KEY));
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.deliveries.map((d) => d.recipient), ['Web Customer']);
  assert.equal(run.body.deliveries[0].address, '9 Web Way');
  assert.equal((await call('POST', '/api/v1/driver/location', { lat: 200, lng: 0 }, bearer(DRV_KEY))).status, 400);
  assert.equal((await call('POST', '/api/v1/driver/location', { lat: 51.5, lng: -0.12 }, bearer(DRV_KEY))).status, 200);
  const other = dispatch.board({}).assigned.concat(dispatch.board({}).out).find((d) => d.driver_id !== DRV_ID);
  assert.equal((await call('POST', `/api/v1/driver/deliveries/${other.id}/status`, { status: 'delivered' }, bearer(DRV_KEY))).status, 403);
  assert.equal((await call('GET', `/api/v1/driver/deliveries/${other.id}/messages`, undefined, bearer(DRV_KEY))).status, 403);
  const id = run.body.deliveries[0].id;
  assert.equal((await call('POST', `/api/v1/driver/deliveries/${id}/status`, { status: 'out' }, bearer(DRV_KEY))).body.status, 'out');
  assert.equal((await call('POST', `/api/v1/driver/deliveries/${id}/messages`, { body: 'On my way' }, bearer(DRV_KEY))).status, 200);
  assert.equal((await call('POST', `/api/v1/driver/deliveries/${id}/messages`, { body: 'Outside now', audience: 'all' }, bearer(DRV_KEY))).status, 200);
  assert.equal((await call('GET', `/api/v1/driver/deliveries/${id}/messages`, undefined, bearer(DRV_KEY))).body.messages.length, 2);

  // the customer's public page and API
  resetTrackLimits();
  const path = dispatch.trackingPath(id);
  const token = path.split('/').pop();
  const page = await fetch(`${base}${path}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.ok(!/https?:\/\/(?!www\.openstreetmap\.org)/.test(html.replace(/https:\/\/www\.openstreetmap\.org[^']*/g, '')), 'the page loads nothing from anywhere else');
  settings.set('tracking_enabled', false);
  assert.equal((await call('GET', `/track-api/${token}`)).status, 404, 'off: same answer as an unknown link');
  settings.set('tracking_enabled', true);
  const t = await call('GET', `/track-api/${token}`);
  assert.equal(t.status, 200);
  assert.equal(t.body.status, 'out');
  assert.equal(t.body.driver, 'App');
  assert.deepEqual(t.body.messages.map((m) => m.body), ['Outside now']);
  assert.ok(!JSON.stringify(t.body).includes('9 Web Way'));
  assert.equal((await call('GET', '/track-api/unknownunknownunknown')).status, 404);
  assert.equal((await call('POST', `/track-api/${token}/message`, { body: 'Left at the gate please' })).status, 200);
  assert.equal((await call('POST', `/track-api/${token}/message`, { body: '' })).status, 400);
  assert.equal((await call('POST', '/track-api/unknownunknownunknown/message', { body: 'x' })).status, 404);
  for (let i = 0; i < 70; i++) await call('GET', `/track-api/${token}`);
  assert.equal((await call('GET', `/track-api/${token}`)).status, 429, 'a visitor cannot hammer a link');
  resetTrackLimits();
  assert.equal((await call('POST', `/api/v1/driver/deliveries/${id}/status`, { status: 'delivered' }, bearer(DRV_KEY))).body.status, 'delivered');
});

test('the office routes: dispatchers work them, customers\' list is for managers, keys and erasing are the owner\'s; a site-limited person is held to their site', async () => {
  const owner = users.ensureOwner(); users.setPin(owner.id, '8080');
  const mgr = users.create({ name: 'Mia Manager', role: 'manager', pin: '1111' });
  const cook = users.create({ name: 'Cal Cook', role: 'staff', pin: '2222' });
  settings.set('lan_mode', true);
  const login = async (pin, name) => (await call('POST', '/api/login', { name, pin })).body.token;
  const T = {
    owner: { 'x-tad-token': await login('8080', owner.name) },
    mgr: { 'x-tad-token': await login('1111', 'Mia Manager') },
    cook: { 'x-tad-token': await login('2222', 'Cal Cook') },
  };
  assert.equal((await call('GET', '/api/dispatch', undefined, T.cook)).status, 200, 'the shift can see the board');
  const made = await call('POST', '/api/dispatch/deliveries', { recipient: 'Phone Pat', phone: '07700 900999', address: '3 Phone Rd', postcode: 'sw11 3cd', items: 2 }, T.cook);
  assert.equal(made.status, 200);
  assert.equal((await call('GET', '/api/dispatch/suggest', undefined, T.cook)).status, 200);
  assert.equal((await call('GET', '/api/customers', undefined, T.cook)).status, 403, 'the customer list is not the cook\'s');
  assert.equal((await call('GET', '/api/customers', undefined, T.mgr)).status, 200);
  assert.equal((await call('POST', '/api/drivers', { name: 'Cook Made' }, T.cook)).status, 403);
  const drv = await call('POST', '/api/drivers', { name: 'Mgr Made', max_items: 6 }, T.mgr);
  assert.equal(drv.status, 200);
  assert.equal((await call('POST', `/api/drivers/${drv.body.id}/key`, {}, T.mgr)).status, 403, 'a driver-app key is the owner\'s to make');
  const key = await call('POST', `/api/drivers/${drv.body.id}/key`, {}, T.owner);
  assert.match(key.body.key, /^drv_/);
  assert.equal((await call('GET', '/api/drivers', undefined, T.cook)).body.drivers.some((d) => JSON.stringify(d).includes('drv_')), false);
  const asg = await call('POST', '/api/dispatch/assign', { driver_id: drv.body.id, ids: [made.body.id] }, T.cook);
  assert.equal(asg.status, 200);
  const over = await call('POST', '/api/dispatch/assign', { driver_id: drv.body.id, ids: [(await call('POST', '/api/dispatch/deliveries', { recipient: 'Big', address: 'a', postcode: 'SW11 1AA', items: 9 }, T.cook)).body.id] }, T.cook);
  assert.equal(over.status, 409);
  assert.equal(over.body.details.over, true);
  assert.equal((await call('POST', `/api/dispatch/drivers/${drv.body.id}/out`, {}, T.cook)).status, 200);
  assert.equal((await call('POST', `/api/dispatch/deliveries/${made.body.id}/failed`, { reason: '' }, T.cook)).status, 400);
  assert.equal((await call('POST', `/api/dispatch/deliveries/${made.body.id}/delivered`, {}, T.cook)).status, 200);
  assert.equal((await call('POST', `/api/dispatch/deliveries/${made.body.id}/messages`, { body: 'internal', audience: 'team' }, T.cook)).status, 200);
  assert.equal((await call('GET', `/api/dispatch/deliveries/${made.body.id}/messages`, undefined, T.cook)).body.messages.length, 1);
  const cust = await call('POST', '/api/customers', { name: 'Erase Me', phone: '07700 900321', address: 'x', postcode: 'SW11 1AA' }, T.mgr);
  assert.equal((await call('POST', `/api/customers/${cust.body.id}/erase`, {}, T.mgr)).status, 403);
  assert.equal((await call('POST', `/api/customers/${cust.body.id}/erase`, {}, T.owner)).status, 200);

  // a person limited to another site is refused for this site's drops
  const other = group.saveSite({ code: 'LDN7', name: 'Seven', kind: 'kitchen' }).id;
  group.grant({ user_id: mgr.id, site_id: other, role: 'manager' });
  const lim = { 'x-tad-token': await login('1111', 'Mia Manager') };
  const dropHere = dispatch.create({ recipient: 'Here', address: 'a', postcode: 'SW11 1AA' });
  assert.equal((await call('POST', `/api/dispatch/deliveries/${dropHere.id}/cancel`, { reason: 'try' }, lim)).status, 403);
  assert.equal(dispatch.get(dropHere.id).status, 'waiting');
  settings.set('lan_mode', false);
  assert.ok(sitesCore.defaultSite());
});

/* ------------------------------------------------------ found by the review */

test('personal details never reach the change log, the events feed or the analytics copy, so erasing a customer really erases', () => {
  const c = dispatch.saveCustomer({ name: 'Priv Acy', phone: '07700 900424', email: 'priv@example.com', address: '77 Secret Rd', postcode: 'N7 7NN' });
  const d = dispatch.create({ customer_id: c.id, note: 'gate code 4242' });
  dispatch.saveCustomer({ id: c.id, name: 'Priv Acy', phone: '07700 900424', address: '78 Secret Rd', postcode: 'N7 7NN' });
  dispatch.eraseCustomer(c.id);
  const everything = JSON.stringify(db.all('SELECT * FROM change_log'));
  for (const secret of ['Priv Acy', '07700900424', 'priv@example.com', '77 Secret Rd', '78 Secret Rd', 'N7 7NN', 'gate code 4242']) {
    assert.ok(!everything.includes(secret), `${secret} must not be in the change log`);
  }
  assert.ok(db.all("SELECT * FROM change_log WHERE entity IN ('customer', 'delivery')").length >= 3, 'the log still says it happened');
  const feed = JSON.stringify(integrations.events({ after: 0, limit: 1000 }));
  assert.ok(!feed.includes('Secret Rd') && !feed.includes('07700900424'));
  const gone = db.get('SELECT * FROM deliveries WHERE id = ?', [d.id]);
  assert.equal(gone.postcode, null, 'the postcode is personal too: the area is what stays');
  assert.equal(gone.area, 'N7');
  // a kitchen order's customer name is hidden in the log as well
  kitchen.create({ lines: [{ name: 'Wings', qty: 1 }], customer: 'Visible Vera' });
  assert.ok(!JSON.stringify(db.all('SELECT * FROM change_log')).includes('Visible Vera'));
});

test('erasing a customer reaches the other copy of the app: the message rows are changed through the repository', () => {
  const c = dispatch.saveCustomer({ name: 'Sync Sam', phone: '07700 900425' });
  const d = dispatch.create({ customer_id: c.id, recipient: 'Sync Sam', address: 'x', postcode: 'SW1A 1AA' });
  const m = dispatch.addMessage(d.id, { from_kind: 'customer', from_name: 'Sam', body: 'secret door code' });
  const before = db.get('SELECT updated_at FROM delivery_messages WHERE id = ?', [m.id]).updated_at;
  const clockOn = process.env.TAD_NOW;
  process.env.TAD_NOW = '2027-05-15T09:00';
  try { dispatch.eraseCustomer(c.id); } finally { process.env.TAD_NOW = clockOn; }
  const row = db.get('SELECT * FROM delivery_messages WHERE id = ?', [m.id]);
  assert.equal(row.body, '(erased)');
  assert.ok(row.updated_at > before, 'updated_at moves, which is what the sync compares');
});

test('a delivery that failed is not a dead end: it stays in view, goes back on the board, can be cancelled, and the order can be delivered again', () => {
  const dan = dispatch.saveDriver({ name: 'Retry Rita', max_items: 10 });
  const o = order(2);
  const d = drop({ kitchen_order_id: o.id, items: undefined });
  dispatch.assign(dan.id, [d.id]); dispatch.sendOut(dan.id);
  dispatch.markFailed(d.id, { reason: 'Nobody home' });
  assert.ok(dispatch.board({}).failed.some((x) => x.id === d.id), 'it stays on the board until someone decides');
  const again = drop({ kitchen_order_id: o.id, items: undefined });
  assert.equal(again.duplicate, false, 'a failed drop does not block a new delivery for the order');
  dispatch.cancel(again.id, { reason: 'made by mistake' });
  const back = dispatch.requeue(d.id);
  assert.equal(back.status, 'waiting');
  assert.equal(back.driver_id, null);
  assert.equal(back.failed_reason, null);
  assert.throws(() => dispatch.requeue(d.id), /waiting, so it cannot/);
  assert.equal(dispatch.assign(dan.id, [d.id])[0].status, 'assigned');
  dispatch.sendOut(dan.id); dispatch.markFailed(d.id, { reason: 'Wrong address' });
  assert.equal(dispatch.cancel(d.id, { reason: 'Customer cannot be reached' }).status, 'cancelled');
  assert.ok(!dispatch.board({}).failed.some((x) => x.id === d.id));
});

test('the tracking limits: a flood of made-up links is bounded, a real customer polling is not blocked', async () => {
  resetTrackLimits();
  settings.set('tracking_enabled', true);
  const d = dispatch.create({ recipient: 'Poll Pat', address: 'x', postcode: 'SW11 1AA' });
  const tok = db.get('SELECT tracking_token FROM deliveries WHERE id = ?', [d.id]).tracking_token;
  const own = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => own.on('listening', r));
  const url = (p) => `http://127.0.0.1:${own.address().port}${p}`;
  try {
    // 200 different made-up links from one visitor: all 404, none stored per link
    for (let i = 0; i < 200; i++) assert.equal((await fetch(url(`/track-api/madeup${String(i).padStart(14, '0')}`))).status, 404);
    assert.deepEqual(trackLimiterSizes(), { visitors: 1, links: 0 }, 'made-up links add nothing to the tables');
    // the one real link is still answered, and polls every 15 seconds for ten minutes would be 40 calls: well inside the limit
    for (let i = 0; i < 40; i++) assert.equal((await fetch(url(`/track-api/${tok}`))).status, 200);
  } finally { own.closeAllConnections?.(); own.close(); resetTrackLimits(); }
});

test('sending a run out is checked against the site of every drop, including the ones loaded on the driver without being named', async () => {
  const hq = sitesCore.defaultSite().id;
  const other = group.saveSite({ code: 'LDN8', name: 'Eight', kind: 'kitchen' }).id;
  const drv = dispatch.saveDriver({ name: 'Cross Site', max_items: 20 });
  const here = dispatch.create({ site_id: hq, recipient: 'Here', address: 'a', postcode: 'SW11 1AA' });
  dispatch.assign(drv.id, [here.id]);
  const owner = users.ensureOwner(); users.setPin(owner.id, '8080');
  const mia = users.create({ name: 'Otto Other', role: 'manager', pin: '3333' });
  group.grant({ user_id: mia.id, site_id: other, role: 'manager' });
  settings.set('lan_mode', true);
  const own = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => own.on('listening', r));
  const req = async (path, token, body = {}) => {
    const r = await fetch(`http://127.0.0.1:${own.address().port}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tad-token': token }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const login = async (name, pin) => (await (await fetch(`http://127.0.0.1:${own.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pin }) })).json()).token;
    const tok = await login('Otto Other', '3333');
    assert.equal((await req(`/dispatch/drivers/${drv.id}/out`, tok)).status, 403, 'without naming the drops');
    assert.equal((await req(`/dispatch/drivers/${drv.id}/out`, tok, { ids: [here.id] })).status, 403, 'naming them');
    assert.equal(dispatch.get(here.id).status, 'assigned', 'nothing left the kitchen');
    assert.equal(kitchen.board({ site_id: hq }).orders.length >= 0, true);
    assert.equal((await req(`/dispatch/drivers/${drv.id}/out`, await login(owner.name, '8080'))).status, 200, 'the owner may');
  } finally { settings.set('lan_mode', false); own.closeAllConnections?.(); own.close(); }
});
