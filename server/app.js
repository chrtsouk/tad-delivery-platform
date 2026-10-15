import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { AppError, errorHandler } from '../lib/util.js';
import { q } from '../lib/db.js';
import { createAuth } from './auth.js';
import { parseQr } from '../services/labels.js';
import { safeEqual } from '../lib/tokens.js';
import { localDate } from '../lib/tz.js';
import { normalisePostcode } from '../lib/geo.js';

const json = express.json({ limit: '4mb' });
const raw = express.raw({ type: '*/*', limit: '2mb' });

export function createApp(ctx, { webDir = path.resolve('web/dist'), uploadDir = path.resolve('.data/uploads') } = {}) {
  const { orders, batcher, shifts, settings, tracking, ingest, hubsync, labels, analytics, notify, audit, bus, now, logger = console } = ctx;
  const auth = createAuth(ctx);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });

  const admin = express.Router();
  const driver = express.Router();
  const pub = express.Router();
  const fail = (m, s = 400, c = 'bad_request') => { throw new AppError(m, s, c); };
  const intParam = (v, what = 'id') => { const n = Number(v); if (!Number.isInteger(n) || n < 1) fail(`${what} is not valid`); return n; };

  app.get('/healthz', (req, res) => res.json({ ok: true, at: now().toISOString() }));

  /* ------------------------------------------------ webhooks (raw bodies) */
  app.post('/api/ingest/hubrise/callback', raw, (req, res) => {
    const body = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!ingest.verifyHubRise(body, req.get('x-hubrise-hmac-sha256'))) throw new AppError('Bad signature', 401, 'bad_signature');
    let ev; try { ev = JSON.parse(body.toString('utf8')); } catch { throw new AppError('Not JSON'); }
    res.status(200).json({ ok: true });                                   // HubRise wants a 200 within 20 s: answer first, work after
    ingest.handleHubRiseEvent(ev).catch((e) => logger.error?.(`HubRise event ${ev.id}: ${e.message}`));
  });
  app.post('/api/ingest/:platform/webhook', raw, async (req, res) => {
    const name = { ubereats: 'uberEats', deliveroo: 'deliveroo', justeat: 'justEat' }[req.params.platform];
    if (!name) throw new AppError('Unknown platform', 404, 'not_found');
    const body = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!ingest.verifyPlatform(name, body, req.get('x-signature') || req.get('x-uber-signature') || req.get('x-deliveroo-hmac-sha256') || req.get('x-hub-signature-256'))) throw new AppError('Bad signature', 401, 'bad_signature');
    const r = await ingest.handlePlatformEvent(name, JSON.parse(body.toString('utf8')));
    res.json({ ok: true, order: r.order.number });
  });
  app.post('/api/hub/webhook', raw, (req, res) => {
    const body = req.body instanceof Buffer ? req.body.toString('utf8') : '';
    if (!hubsync.verifyWebhook(body, req.get('x-tad-timestamp'), req.get('x-tad-signature'))) throw new AppError('Bad signature', 401, 'bad_signature');
    const ev = JSON.parse(body);
    const changed = hubsync.applyEvent({ entity: ev.entity, field: ev.field, new: ev.new, entity_id: ev.entity_id });
    res.json({ ok: true, changed });
  });

  // Fleetbase developer-console webhook (order.* events): the secret travels in the URL query, set FLEETBASE_WEBHOOK_SECRET
  app.post('/api/fleetbase/webhook', express.json({ limit: '1mb' }), async (req, res) => {
    if (!ctx.config.fleetbaseWebhookSecret) throw new AppError('The Fleetbase webhook secret is not set', 503, 'not_configured');
    if (!safeEqual(String(req.query.k ?? ''), ctx.config.fleetbaseWebhookSecret)) throw new AppError('Bad secret', 401, 'unauthorised');
    const id = req.body?.data?.id ?? req.body?.id;
    res.json({ ok: true, change: id ? await ctx.fbsync.onWebhook(id) : null });
  });

  app.use(json);

  /* -------------------------------------------------------------- public */
  app.post('/api/login', (req, res) => {
    const token = auth.login(req.ip, String(req.body?.password ?? ''));
    res.set('Set-Cookie', auth.cookie(token)).json({ ok: true });
  });
  app.post('/api/logout', (req, res) => res.set('Set-Cookie', auth.clearCookie).json({ ok: true }));
  app.get('/api/me', (req, res) => res.json({ admin: auth.isAdmin(req) }));

  pub.post('/ingest/own', async (req, res) => {
    ingest.ownSiteAuth(req.get('x-tad-key'));
    const r = await ingest.fromOwnSite(req.body);
    res.status(r.duplicate ? 200 : 201).json({ ok: true, number: r.order.number, duplicate: r.duplicate, tracking_url: notify.trackUrl(r.order) });
  });
  pub.get('/public/quote', async (req, res) => res.json(await tracking.quote({ postcode: req.query.postcode, site: req.query.site || 'main' })));
  pub.get('/public/status', (req, res) => { const s = settings.all(); res.json({ open: s.open, eta_minutes: s.default_eta_minutes, radius_km: s.radius_km, min_order_pence: s.min_order_pence }); });
  pub.get('/track/:token', async (req, res) => res.json(await tracking.view(req.params.token)));
  pub.post('/track/:token/rate', (req, res) => res.json(tracking.rate(req.params.token, req.body?.rating)));
  pub.post('/track/:token/subscribe', (req, res) => {
    const o = tracking.orderForToken(req.params.token);
    if (!req.body?.endpoint) fail('A push subscription is needed');
    notify.subscribe('order', o.number, req.body);
    res.json({ ok: true });
  });
  pub.get('/track/:token/inbox', (req, res) => { const o = tracking.orderForToken(req.params.token); res.json({ messages: notify.inbox(o.number, { unreadOnly: false }).map((m) => ({ id: m.id, ...m.payload, at: m.created_at })) }); });
  app.use('/api', pub);

  /* --------------------------------------------------------------- admin */
  admin.use(auth.requireAdmin);

  admin.get('/sites', (req, res) => res.json({ sites: ctx.sites.list() }));
  admin.post('/sites', async (req, res) => res.status(201).json({ site: await ctx.sites.create(req.body || {}) }));
  admin.put('/sites/:id', (req, res) => res.json({ site: ctx.sites.update(req.params.id, req.body || {}) }));
  admin.post('/sites/:id/fleet', async (req, res) => res.json({ site: await ctx.sites.ensureFleet(req.params.id) }));
  admin.get('/settings', (req, res) => res.json(settings.all()));
  admin.put('/settings', (req, res) => {
    const s = settings.set(req.body || {});
    audit.log('admin', 'settings.update', 'settings', null, req.body);
    bus.emit('board', { settings: true });
    if ('radius_km' in (req.body || {}) || 'store' in (req.body || {})) ctx.fleetbaseConfig.syncServiceArea().catch((e) => logger.warn?.(`service area sync: ${e.message}`));
    res.json(s);
  });

  admin.get('/board', async (req, res) => res.json(await board()));
  admin.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onOrder = ({ order, to }) => send('order', { id: order.id, number: order.number, to });
    const onBatch = (b) => send('batch', b);
    const onBoard = (b) => send('board', b);
    bus.on('order', onOrder); bus.on('batch', onBatch); bus.on('board', onBoard);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); bus.off('order', onOrder); bus.off('batch', onBatch); bus.off('board', onBoard); });
    send('hello', { at: now().toISOString() });
  });

  admin.get('/orders', (req, res) => res.json({ orders: orders.list({ states: req.query.states ? String(req.query.states).split(',') : undefined, since: req.query.since }) }));
  admin.post('/orders', async (req, res) => { const r = await ingest.manual(req.body || {}); res.status(r.duplicate ? 200 : 201).json({ order: r.order }); });
  admin.get('/orders/:id', (req, res) => { const id = intParam(req.params.id); res.json({ order: orders.need(id), timeline: orders.timeline(id) }); });
  admin.post('/orders/:id/transition', async (req, res) => {
    const id = intParam(req.params.id), { to, reason } = req.body || {};
    if (to === 'delivered') return res.json({ order: await batcher.deliver(id, { actor: 'admin' }) });
    if (to === 'failed') return res.json({ order: await batcher.fail(id, { reason, actor: 'admin' }) });
    const o = orders.transition(id, to, { actor: 'admin', reason });
    if (to === 'ready') batcher.tick().catch((e) => logger.warn?.(e.message));
    res.json({ order: o });
  });
  admin.post('/orders/:id/requeue', (req, res) => { const o = orders.transition(intParam(req.params.id), 'ready', { actor: 'admin' }); batcher.tick().catch(() => {}); res.json({ order: o }); });
  admin.post('/orders/:id/remove', (req, res) => res.json({ order: orders.transition(intParam(req.params.id), 'removed', { actor: 'admin', reason: req.body?.reason || 'Removed by admin' }) }));

  admin.get('/geo/postcode', async (req, res) => {
    const pc = normalisePostcode(req.query.postcode);
    const hit = await ctx.postcodes.lookup(pc.postcode);
    if (!hit) fail(`We could not find ${pc.postcode} on the map`, 404, 'unknown_postcode');
    res.json({ postcode: pc.postcode, lat: hit.lat, lng: hit.lng, district: hit.admin_district });
  });
  admin.get('/address/search', async (req, res) => res.json({ results: await ingest.searchAddress({ phone: req.query.phone, query: req.query.q, near: ctx.settings.get('store') }) }));

  admin.post('/batcher/tick', async (req, res) => res.json(await batcher.tick()));
  admin.post('/batcher/send-now', async (req, res) => res.json(await batcher.sendNow(Array.isArray(req.body?.orderIds) ? req.body.orderIds : null)));
  admin.post('/batcher/move', async (req, res) => res.json({ order: await batcher.moveOrder(intParam(req.body?.orderId, 'orderId'), req.body?.driverId ?? null) }));
  admin.post('/batcher/runs/:id/out', async (req, res) => res.json({ run: await batcher.markOut(intParam(req.params.id), { actor: 'admin' }) }));

  admin.get('/drivers', async (req, res) => res.json({ ...(await shifts.availability({ requireOnline: false })), fleetbase: await ctx.fleetbase.drivers().then((d) => d.map((x) => ({ id: x.id, name: x.name, phone: x.phone, online: x.online }))).catch(() => null) }));
  admin.get('/drivers/availability', async (req, res) => res.json(await shifts.availability()));
  admin.post('/drivers/:id/clock-in', async (req, res) => res.json({ shift: await shifts.clockIn(req.params.id, { zone: req.body?.zone, siteId: req.body?.site_id, actor: 'admin' }) }));
  admin.post('/drivers/:id/clock-out', async (req, res) => res.json({ shift: await shifts.clockOut(req.params.id, { actor: 'admin' }) }));
  admin.post('/drivers/:id/token', (req, res) => res.json({ token: shifts.issueToken(req.params.id), note: 'Shown once. Put it in the TAD Drivers app settings.' }));

  admin.get('/orders/:id/label', async (req, res) => { const o = orders.need(intParam(req.params.id)); res.type('html').send(await labels.html(o)); });
  admin.get('/orders/:id/label.svg', async (req, res) => { const o = orders.need(intParam(req.params.id)); res.type('image/svg+xml').send(await labels.svg(o)); });
  admin.post('/orders/:id/print', async (req, res) => { const o = orders.need(intParam(req.params.id)); orders.event(o.id, 'label_printed'); res.json(await labels.print(o)); });
  // Shop-side bag check: staff scan a label at the counter; it says whose bag it is and marks it picked
  admin.post('/scan', (req, res) => {
    const number = parseQr(req.body?.code ?? req.body?.number);
    if (!number) fail('That is not a Texas After Dark bag label', 422, 'bad_code');
    const o = orders.byNumber(number);
    if (!o) fail('That order does not exist', 404, 'not_found');
    const driverName = o.driver_id ? q.get(ctx.db, 'SELECT driver_name AS n FROM driver_shifts WHERE driver_id = ? ORDER BY id DESC LIMIT 1', o.driver_id)?.n ?? o.driver_id : null;
    if (['assigned', 'out'].includes(o.state)) {
      q.run(ctx.db, 'UPDATE orders SET picked_at = COALESCE(picked_at, ?) WHERE id = ?', now().toISOString(), o.id);
      orders.event(o.id, 'bag_scanned', { by: 'shop' });
    }
    res.json({ order: { id: o.id, number: o.number, state: o.state, name: o.customer_name, postcode: o.postcode, items: o.items, stop_seq: o.stop_seq }, driver_id: o.driver_id, driver_name: driverName, ok: ['assigned', 'out'].includes(o.state),
      message: o.state === 'assigned' ? `Hand to ${driverName}` : o.state === 'out' ? `Already out with ${driverName}` : `Order is ${o.state}` });
  });
  admin.get('/orders/:id/wa-link', (req, res) => {
    const o = orders.need(intParam(req.params.id));
    const kind = String(req.query.kind || 'out');
    res.json({ link: notify.waLink(o.customer_phone, `Texas After Dark — order ${o.number}: ${req.query.text || `follow it here ${notify.trackUrl(o)}`}`), kind });
  });

  admin.get('/analytics/demand', (req, res) => res.json(analytics.demand({ from: req.query.from, to: req.query.to })));
  admin.get('/analytics/drivers', (req, res) => res.json({ drivers: analytics.driverPerformance({ from: req.query.from, to: req.query.to }) }));
  admin.get('/analytics/end-of-day', (req, res) => res.json(analytics.endOfDay(String(req.query.day || localDate(now(), settings.get('timezone'))))));
  admin.get('/orders-export.csv', (req, res) => res.type('text/csv').set('Content-Disposition', 'attachment; filename="tad-orders.csv"').send(analytics.ordersCsv({ from: req.query.from, to: req.query.to })));
  admin.get('/audit', (req, res) => res.json({ events: analytics.auditLog(Math.min(Number(req.query.limit) || 200, 1000), { from: req.query.from, to: req.query.to }) }));
  admin.get('/calendar', (req, res) => res.json(calendar(req.query.from, req.query.to)));

  admin.post('/shop/open', (req, res) => { settings.set({ open: true }); audit.log('admin', 'shop.open'); bus.emit('board', { open: true }); res.json({ open: true }); });
  admin.post('/shop/close', (req, res) => {
    settings.set({ open: false });
    // all-off: orders that failed and are still waiting are removed when the shop closes
    const removed = orders.list({ states: ['failed'] }).map((o) => orders.transition(o.id, 'removed', { actor: 'admin', reason: 'Shop closed' }).number);
    audit.log('admin', 'shop.close', null, null, { removed });
    bus.emit('board', { open: false });
    res.json({ open: false, removed });
  });

  admin.post('/privacy/erase', (req, res) => res.json(hubsync.erasePerson({ phone: req.body?.phone })));
  admin.get('/ingest/failures', (req, res) => res.json({ failures: ingest.failures() }));
  admin.post('/ingest/failures/:id/retry', async (req, res) => res.json(await ingest.retryFailure(intParam(req.params.id))));
  admin.post('/ingest/failures/:id/dismiss', (req, res) => { ingest.dismissFailure(intParam(req.params.id)); res.json({ ok: true }); });
  admin.get('/integrations', (req, res) => res.json({ hubrise: { configured: Boolean(ctx.config.hubrise.clientId), connected: ingest.hubriseConnected() }, hub: { enabled: ctx.hub.enabled() }, printer: Boolean(ctx.config.printer.host), email: Boolean(ctx.config.smtp.host), push: Boolean(notify.vapidPublicKey),
    platforms: Object.fromEntries(Object.entries(ctx.config.platforms).map(([k, v]) => [k, v.enabled])) }));
  admin.get('/hubrise/connect', (req, res) => res.json({ url: ingest.hubriseAuthorizeUrl(`${ctx.config.publicUrl}/api/hubrise/oauth/callback`) }));
  app.get('/api/hubrise/oauth/callback', async (req, res) => {
    const r = await ingest.hubriseExchange(String(req.query.code || ''), `${ctx.config.publicUrl}/api/hubrise/oauth/callback`, String(req.query.state || ''));
    res.type('html').send(`<p>HubRise connected to ${String(r.location_name).replace(/[<>&]/g, '')}. You can close this tab.</p>`);
  });
  app.use('/api', admin);

  /* -------------------------------------------------------------- driver */
  driver.use(auth.requireDriver);
  driver.get('/me', async (req, res) => {
    const open = shifts.open(req.driverId);
    res.json({ driver_id: req.driverId, clocked_in: Boolean(open), since: open?.clock_in_at ?? null, zone: open?.zone ?? null });
  });
  driver.post('/clock-in', async (req, res) => res.json({ shift: await shifts.clockIn(req.driverId, { zone: req.body?.zone, siteId: req.body?.site_id }) }));
  driver.post('/clock-out', async (req, res) => res.json({ shift: await shifts.clockOut(req.driverId) }));
  driver.get('/run', (req, res) => res.json(driverRun(req.driverId)));
  driver.post('/scan', (req, res) => {
    const number = parseQr(req.body?.code);
    if (!number) fail('That is not a Texas After Dark bag label', 422, 'bad_code');
    const o = orders.byNumber(number);
    if (!o) fail('That order does not exist', 404, 'not_found');
    const run = driverRun(req.driverId);
    if (!run.batch || !run.orders.some((x) => x.id === o.id)) {
      throw new AppError(`Wrong bag — order ${o.number} is not on your run${o.driver_id ? ' (it is another driver\'s)' : ''}`, 409, 'wrong_bag');
    }
    q.run(ctx.db, 'UPDATE orders SET picked_at = COALESCE(picked_at, ?) WHERE id = ?', now().toISOString(), o.id);
    orders.event(o.id, 'bag_scanned', { driver: req.driverId });
    const after = driverRun(req.driverId);
    res.json({ ok: true, order: o.number, remaining: after.orders.filter((x) => !x.picked_at).map((x) => x.number), all_scanned: after.orders.every((x) => x.picked_at) });
  });
  driver.post('/run/start', async (req, res) => {
    const run = driverRun(req.driverId);
    if (!run.batch || run.batch.status !== 'assigned') fail('You have no run waiting to leave', 409, 'no_run');
    const missing = run.orders.filter((o) => !o.picked_at).map((o) => o.number);
    if (missing.length && !req.body?.force) throw new AppError(`Scan these bags first: ${missing.join(', ')}`, 409, 'bags_not_scanned');
    res.json({ run: await batcher.markOut(run.batch.id, { actor: `driver:${req.driverId}` }) });
  });
  driver.post('/orders/:id/delivered', async (req, res) => { mine(req.driverId, intParam(req.params.id)); res.json({ order: await batcher.deliver(intParam(req.params.id), { actor: `driver:${req.driverId}` }) }); });
  driver.post('/orders/:id/failed', async (req, res) => {
    const id = intParam(req.params.id); mine(req.driverId, id);
    const photo = req.body?.photo ? savePhoto(req.body.photo, id) : null;
    res.json({ order: await batcher.fail(id, { reason: req.body?.reason, photo, actor: `driver:${req.driverId}` }) });
  });
  driver.get('/notifications', (req, res) => res.json({ messages: notify.inbox(req.driverId).map((m) => ({ id: m.id, ...m.payload, at: m.created_at })) }));
  driver.post('/notifications/read', (req, res) => { notify.markRead(req.driverId, (req.body?.ids || []).map(Number).filter(Number.isInteger)); res.json({ ok: true }); });
  driver.post('/push/subscribe', (req, res) => { if (!req.body?.endpoint) fail('A push subscription is needed'); notify.subscribe('driver', req.driverId, req.body); res.json({ ok: true }); });
  app.use('/driver', driver);

  /* ------------------------------------------------------------- helpers */
  function mine(driverId, orderId) { const o = orders.need(orderId); if (o.driver_id !== driverId) fail('That order is not on your run', 403, 'not_yours'); return o; }

  function driverRun(driverId) {
    const b = q.get(ctx.db, "SELECT * FROM batches WHERE driver_id = ? AND status IN ('assigned','out') ORDER BY id DESC LIMIT 1", driverId);
    if (!b) return { batch: null, orders: [], next_run_waiting: Boolean(q.get(ctx.db, "SELECT 1 AS x FROM batches WHERE driver_id = ? AND status = 'planned'", driverId)) };
    const os = q.all(ctx.db, "SELECT id FROM orders WHERE batch_id = ? AND state IN ('assigned','out','delivered','failed') ORDER BY stop_seq", b.id).map((r) => orders.byId(r.id));
    return { batch: { id: b.id, status: b.status, return_eta_at: b.return_eta_at }, orders: os.map(publicOrder) };
  }
  const publicOrder = (o) => ({ id: o.id, number: o.number, state: o.state, stop_seq: o.stop_seq, name: o.customer_name, phone: o.customer_phone, address: o.address_line, postcode: o.postcode, lat: o.lat, lng: o.lng, notes: o.notes, items: o.items, picked_at: o.picked_at, fleetbase_order_id: o.fleetbase_order_id });

  function savePhoto(dataUrl, orderId) {
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) fail('The photo must be a PNG, JPEG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) fail('The photo is too big (3 MB at most)');
    fs.mkdirSync(uploadDir, { recursive: true });
    const name = `failed-${orderId}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(uploadDir, name), buf);
    return name;
  }
  admin.get('/uploads/:name', (req, res) => {
    const name = path.basename(req.params.name);
    const f = path.join(uploadDir, name);
    fs.existsSync(f) ? res.sendFile(f) : res.status(404).json({ error: 'No such file' });
  });

  async function board() {
    const s = settings.all();
    const open = orders.list({ states: ['scheduled', 'new', 'accepted', 'preparing', 'ready', 'assigned', 'out', 'failed'] });
    const since = new Date(now().getTime() - 6 * 3600 * 1000).toISOString();
    const recent = q.all(ctx.db, "SELECT id FROM orders WHERE state IN ('delivered','collected','cancelled','removed') AND COALESCE(delivered_at, cancelled_at, created_at) >= ? ORDER BY id DESC LIMIT 40", since).map((r) => orders.byId(r.id));
    const av = await shifts.availability({ requireOnline: false }).catch(() => ({ available: [], busy: [], offline: [] }));
    const batches = q.all(ctx.db, "SELECT * FROM batches WHERE status IN ('assigned','planned','out') ORDER BY id").map((b) => ({ ...b, route_json: undefined, order_ids: q.all(ctx.db, 'SELECT id FROM orders WHERE batch_id = ? ORDER BY stop_seq', b.id).map((r) => r.id) }));
    const { proposals, engine } = await batcher.plan().catch(() => ({ proposals: [], engine: 'none' }));
    return {
      now: now().toISOString(), ingest_failures: ingest.failures().length, settings: s, orders: open.map(withSla(s)), recent: recent.map(withSla(s)), drivers: av, batches, engine,
      preview: proposals.map((p) => ({ order_ids: p.orders.map((o) => o.id), ripe: p.ripe, full: p.full, waits_seconds: p.waits_seconds })),
    };
  }
  const withSla = (s) => (o) => {
    const start = Date.parse(o.accepted_at ?? o.created_at);
    const age = Math.max(0, (now().getTime() - start) / 60000);
    const active = ['new', 'accepted', 'preparing', 'ready', 'assigned', 'out'].includes(o.state);
    return { ...o, age_minutes: Math.round(age * 10) / 10, sla: !active ? 'done' : age >= s.late_after_minutes ? 'late' : age >= s.warn_after_minutes ? 'warn' : 'ok' };
  };

  function calendar(from, to) {
    const f = from ?? new Date(now().getTime() - 7 * 86400000).toISOString(), t = to ?? new Date(now().getTime() + 30 * 86400000).toISOString();
    const pre = q.all(ctx.db, "SELECT id, number, customer_name, scheduled_for, state, postcode FROM orders WHERE scheduled_for IS NOT NULL AND scheduled_for >= ? AND scheduled_for < ?", f, t)
      .map((o) => ({ kind: 'pre-order', id: `o${o.id}`, title: `${o.number} ${o.customer_name ?? ''} ${o.postcode ?? ''}`.trim(), start: o.scheduled_for, end: new Date(Date.parse(o.scheduled_for) + 30 * 60000).toISOString(), state: o.state }));
    const sh = q.all(ctx.db, 'SELECT * FROM driver_shifts WHERE clock_in_at >= ? AND clock_in_at < ?', f, t)
      .map((s) => ({ kind: 'shift', id: `s${s.id}`, title: s.driver_name || s.driver_id, start: s.clock_in_at, end: s.clock_out_at ?? now().toISOString(), open: !s.clock_out_at }));
    return { events: [...pre, ...sh] };
  }

  /* --------------------------------------------------------- static web */
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir, { index: 'index.html', maxAge: '1h' }));
    app.get('/t/:token', (req, res) => res.sendFile(path.join(webDir, 'track.html'), { dotfiles: 'allow' }));
    // client-side routes of the admin app: a reload on /add, /drivers… must still load the app
    app.get(['/add', '/scan', '/drivers', '/calendar', '/analytics', '/audit', '/settings'], (req, res) => res.sendFile(path.join(webDir, 'index.html'), { dotfiles: 'allow' }));
  } else {
    app.get('/', (req, res) => res.type('text').send('TAD delivery platform API is running. Build the web app with: npm run web:build'));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'No such API route', code: 'not_found' }));
  app.use(errorHandler(logger));
  return app;
}
