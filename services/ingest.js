/**
 * tad-ingest: channel adapters -> ONE order schema -> orders.create (which mirrors into Fleetbase).
 *   (a) our own website/app       posts straight in (API key)
 *   (b) HubRise                   OAuth + callback, HMAC-SHA256 of the raw body vs X-HubRise-Hmac-SHA256, answer 200 fast, GET the order
 *   (c) Uber Eats / Deliveroo / Just Eat direct   behind config flags; inert until the owner supplies approved keys via env
 *   (d) manual "Add new order"    Photon autofill + postcodes.io + the self-building address book
 */
import crypto from 'node:crypto';
import { q } from '../lib/db.js';
import { AppError, fetchJson } from '../lib/util.js';
import { safeEqual } from '../lib/tokens.js';
import { tryPostcode } from '../lib/geo.js';

const pence = (s) => { const m = /^(-?\d+(?:\.\d+)?)/.exec(String(s ?? '')); return m ? Math.round(parseFloat(m[1]) * 100) : null; };

/* ------------------------------------------------------------- mappers */

/** HubRise order -> our schema (https://www.hubrise.com/developers/api/orders) */
export function mapHubRiseOrder(o) {
  const c = o.customer || {};
  const service = o.service_type === 'collection' ? 'collection' : o.service_type === 'delivery' ? 'delivery' : null;
  if (!service) return null;
  const items = (o.items || []).map((i) => ({ name: [i.product_name, i.sku_name].filter(Boolean).join(' – '), qty: Number(i.quantity) || 1, price_pence: pence(i.price) }));
  const charges = (o.charges || []).filter((x) => /deliver/i.test(`${x.name || ''}${x.type || ''}`));
  return {
    source: 'hubrise', external_id: o.id,
    fulfilment: service,
    customer: { name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, phone: c.phone || null, email: c.email || null },
    address: service === 'delivery' ? { line1: [c.address_1, c.address_2].filter(Boolean).join(', '), postcode: c.postal_code, lat: c.latitude ?? null, lng: c.longitude ?? null } : {},
    items: items.length ? items : [{ name: 'Order', qty: 1 }],
    notes: [o.customer_notes, c.delivery_notes].filter(Boolean).join(' | ') || null,
    total_pence: pence(o.total),
    delivery_fee_pence: charges.length ? charges.reduce((n, x) => n + (pence(x.price) ?? 0), 0) : null,
    paid: (o.payments || []).length > 0 ? true : o.payment_discrepancy == null,
    scheduled_for: o.expected_time && o.asap === false ? o.expected_time : null,
  };
}

/** Uber Eats order (GET resource_href) -> our schema. Unverified against a live payload: inert until enabled. */
export function mapUberEatsOrder(o) {
  const e = o.eater || {}, d = o.delivery?.location || o.delivery_location || {};
  return {
    source: 'ubereats', external_id: o.id, fulfilment: 'delivery',
    customer: { name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null, phone: e.phone || e.phone_code || null },
    address: { line1: d.street_address_line_one || d.address || d.street_address, postcode: d.postal_code, lat: d.latitude ?? null, lng: d.longitude ?? null },
    items: (o.cart?.items || o.items || []).map((i) => ({ name: i.title || i.name, qty: i.quantity || 1, price_pence: i.price?.unit_price?.amount ?? null })),
    notes: o.cart?.special_instructions || null, total_pence: o.payment?.charges?.total?.amount ?? null,
  };
}

/** Deliveroo order.new webhook body -> our schema. Unverified against a live payload: inert until enabled. */
export function mapDeliverooOrder(ev) {
  const o = ev.body?.order || ev.order || ev;
  const a = o.delivery?.address || {};
  return {
    source: 'deliveroo', external_id: o.id, fulfilment: 'delivery',
    customer: { name: o.customer?.first_name ? `${o.customer.first_name} ${o.customer.last_name ?? ''}`.trim() : null, phone: o.customer?.contact_number || null },
    address: { line1: [a.address1, a.address2].filter(Boolean).join(', ') || a.address_line, postcode: a.post_code || a.postcode, lat: a.latitude ?? null, lng: a.longitude ?? null },
    items: (o.items || []).map((i) => ({ name: i.name, qty: i.quantity || 1, price_pence: i.unit_price?.fractional ?? null })),
    notes: o.notes || null, total_pence: o.total_price?.fractional ?? null,
  };
}

/** Just Eat order -> our schema. Unverified against a live payload: inert until enabled. */
export function mapJustEatOrder(o) {
  const a = o.Customer?.Address || o.customer?.address || {};
  return {
    source: 'justeat', external_id: o.Id || o.id || o.OrderId, fulfilment: (o.FulfilmentType || o.fulfilment || 'delivery').toLowerCase().includes('collect') ? 'collection' : 'delivery',
    customer: { name: o.Customer?.Name || o.customer?.name || null, phone: o.Customer?.PhoneNumber || o.customer?.phone || null },
    address: { line1: [a.Line1, a.Line2].filter(Boolean).join(', '), postcode: a.PostalCode, lat: a.Latitude ?? null, lng: a.Longitude ?? null },
    items: (o.Items || o.items || []).map((i) => ({ name: i.Name || i.name, qty: i.Quantity || i.quantity || 1, price_pence: i.UnitPrice != null ? Math.round(i.UnitPrice * 100) : null })),
    notes: o.Note || o.note || null, total_pence: o.TotalPrice != null ? Math.round(o.TotalPrice * 100) : null,
  };
}

/* ------------------------------------------------------------- service */

export function createIngest(ctx) {
  const { db, now, config, orders, postcodes, photon, audit, logger = console } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const iso = () => now().toISOString();

  /* (a) own website / app */
  function ownSiteAuth(headerKey) {
    if (!config.ownSiteKey) throw new AppError('The own-site API key is not set on the server', 503, 'not_configured');
    if (!safeEqual(headerKey, config.ownSiteKey)) throw new AppError('Wrong or missing X-TAD-Key', 401, 'unauthorised');
  }
  const fromOwnSite = (body) => orders.create({ ...body, source: 'own-site' }, { actor: 'own-site' });

  /* (b) HubRise */
  const hr = () => {
    const row = q.get(db, "SELECT data FROM integrations WHERE name = 'hubrise'");
    return row ? JSON.parse(row.data) : null;
  };
  const saveHr = (data) => q.run(db, "INSERT INTO integrations(name,data,updated_at) VALUES('hubrise',?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", JSON.stringify(data), iso());

  function hubriseAuthorizeUrl(redirectUri) {
    const { clientId } = config.hubrise;
    if (!clientId) throw new AppError('HubRise is not configured (HUBRISE_CLIENT_ID / HUBRISE_CLIENT_SECRET)', 503, 'not_configured');
    // the callback comes back from another site, so a SameSite=Strict login cookie is not sent: the one-time `state` is the proof instead
    const state = crypto.randomBytes(16).toString('hex');
    q.run(db, "INSERT INTO integrations(name,data,updated_at) VALUES('hubrise_state',?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at", JSON.stringify({ state, at: now().getTime() }), iso());
    const p = new URLSearchParams({ redirect_uri: redirectUri, client_id: clientId, scope: 'location[orders.read_write]', state });
    return `https://manager.hubrise.com/oauth2/v1/authorize?${p}`;
  }

  async function hubriseExchange(code, redirectUri, state) {
    const row = q.get(db, "SELECT data FROM integrations WHERE name = 'hubrise_state'");
    const saved = row ? JSON.parse(row.data) : null;
    q.run(db, "DELETE FROM integrations WHERE name = 'hubrise_state'");      // single use
    if (!saved || !state || !safeEqual(saved.state, String(state)) || now().getTime() - saved.at > 10 * 60000) throw new AppError('This HubRise connection link has expired. Start again from Settings.', 400, 'bad_state');
    if (!code) throw new AppError('HubRise did not send a code', 400, 'bad_request');
    const { clientId, clientSecret, apiUrl } = config.hubrise;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tok = await fetchJson('https://manager.hubrise.com/oauth2/v1/token', {
      method: 'POST', body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(), fetchImpl,
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    saveHr({ access_token: tok.access_token, location_id: tok.location_id, account_id: tok.account_id, location_name: tok.location_name });
    // register the callback: "order" create + update events
    await fetchJson(`${apiUrl}/callback`, { method: 'POST', fetchImpl, headers: { 'X-Access-Token': tok.access_token },
      body: { url: `${config.publicUrl}/api/ingest/hubrise/callback`, events: { order: ['create', 'update'] } } });
    audit.log('admin', 'hubrise.connected', 'integration', 'hubrise', { location: tok.location_name });
    return { location_name: tok.location_name };
  }

  /** The exact check HubRise documents: HMAC-SHA256 of the RAW body with the client secret vs X-HubRise-Hmac-SHA256. */
  function verifyHubRise(rawBody, signature) {
    const secret = config.hubrise.clientSecret;
    if (!secret) throw new AppError('HubRise is not configured', 503, 'not_configured');
    if (!signature) return false;
    const mac = crypto.createHmac('sha256', secret).update(rawBody).digest();
    return safeEqual(mac.toString('hex'), String(signature).trim().toLowerCase()) || safeEqual(mac.toString('base64'), String(signature).trim());
  }

  /** Process one callback event (call after answering 200). */
  async function handleHubRiseEvent(ev) {
    if (ev.resource_type !== 'order') return { ignored: true };
    const eventId = `hubrise:${ev.id}`;
    if (q.get(db, 'SELECT 1 AS x FROM webhook_seen WHERE id = ?', eventId)) return { duplicate: true };
    try {
      const r = await processHubRiseEvent(ev);
      q.run(db, 'INSERT OR IGNORE INTO webhook_seen(id,at) VALUES(?,?)', eventId, iso());     // only a processed event is "seen": a failed one must stay retryable
      return r;
    } catch (e) {
      q.run(db, 'INSERT INTO ingest_failures(source, external_id, error, payload, at) VALUES(?,?,?,?,?)', 'hubrise', String(ev.order_id || ev.new_state?.id || ''), e.message, JSON.stringify(ev), iso());
      audit.log('system', 'ingest.failed', 'order', ev.order_id || null, { source: 'hubrise', error: e.message });
      ctx.bus.emit('board', { ingestFailed: true });
      throw e;
    }
  }

  const failures = () => q.all(db, 'SELECT id, source, external_id, error, at FROM ingest_failures WHERE resolved_at IS NULL ORDER BY id');
  async function retryFailure(id) {
    const f = q.get(db, 'SELECT * FROM ingest_failures WHERE id = ? AND resolved_at IS NULL', id);
    if (!f) throw new AppError('That failed order is not waiting any more', 404, 'not_found');
    const r = await processHubRiseEvent(JSON.parse(f.payload));      // throws again if it still cannot be created: the row stays
    q.run(db, 'UPDATE ingest_failures SET resolved_at = ? WHERE id = ?', iso(), id);
    q.run(db, 'INSERT OR IGNORE INTO webhook_seen(id,at) VALUES(?,?)', `hubrise:${JSON.parse(f.payload).id}`, iso());
    audit.log('admin', 'ingest.retried', 'order', f.external_id, r);
    return r;
  }
  function dismissFailure(id) { q.run(db, 'UPDATE ingest_failures SET resolved_at = ? WHERE id = ?', iso(), id); audit.log('admin', 'ingest.dismissed', 'ingest_failure', id); }

  async function processHubRiseEvent(ev) {
    const orderId = ev.order_id || ev.new_state?.id;
    let full = ev.new_state;
    const tok = hr();
    if (tok?.access_token && orderId) {
      try { full = await fetchJson(`${config.hubrise.apiUrl}/location/orders/${orderId}`, { headers: { 'X-Access-Token': tok.access_token }, fetchImpl }); }
      catch (e) { logger.warn?.(`HubRise GET order ${orderId} failed, using the callback copy: ${e.message}`); }
    }
    if (!full) return { ignored: true };
    full = { id: orderId, ...full };
    const existing = q.get(db, "SELECT id, state FROM orders WHERE source = 'hubrise' AND external_id = ?", full.id);
    if (existing) {
      if (['cancelled', 'rejected'].includes(full.status) && !['cancelled', 'delivered', 'collected', 'removed'].includes(existing.state)) {
        try { orders.transition(existing.id, 'cancelled', { actor: 'hubrise', reason: `Cancelled in HubRise (${full.status})` }); } catch (e) { logger.warn?.(e.message); }
      }
      return { updated: true };
    }
    const mapped = mapHubRiseOrder(full);
    if (!mapped) return { ignored: true, why: 'eat-in order' };
    const { order } = await orders.create(mapped, { actor: 'hubrise' });
    return { created: order.number };
  }

  /* (c) direct platform adapters — inert until enabled */
  function platform(name) {
    const p = config.platforms[name];
    if (!p?.enabled) throw new AppError(`The ${name} adapter is switched off (no approved API keys yet)`, 404, 'not_enabled');
    return p;
  }
  function verifyPlatform(name, rawBody, signature) {
    const p = platform(name);
    if (!p.webhookSecret) throw new AppError(`${name} webhook secret is not set`, 503, 'not_configured');
    const mac = crypto.createHmac('sha256', p.webhookSecret).update(rawBody).digest();
    const sig = String(signature ?? '').replace(/^sha256=/i, '').trim();
    return safeEqual(mac.toString('hex'), sig.toLowerCase()) || safeEqual(mac.toString('base64'), sig);
  }
  async function handlePlatformEvent(name, payload) {
    platform(name);
    const mapper = { uberEats: mapUberEatsOrder, deliveroo: mapDeliverooOrder, justEat: mapJustEatOrder }[name];
    const mapped = mapper(payload);
    if (!mapped.external_id) throw new AppError('That order has no id');
    return orders.create(mapped, { actor: name });
  }

  /* (d) manual "Add new order" helpers */
  /** One search box: address book first (by phone and text), then postcodes.io for a postcode, then Photon for street / house number. */
  async function searchAddress({ phone, query, near }) {
    const out = [];
    for (const a of orders.findAddresses({ phone, query })) out.push({ from: 'address_book', label: `${a.address_line}, ${a.postcode}`, line1: a.address_line, postcode: a.postcode, lat: a.lat, lng: a.lng, name: a.name, uses: a.uses });
    const text = String(query ?? '').trim();
    if (text.length >= 3) {
      const pc = tryPostcode(text);
      if (pc) {
        const hit = await postcodes.lookup(pc.postcode).catch(() => null);
        if (hit) out.push({ from: 'postcode', label: pc.postcode, line1: '', postcode: pc.postcode, lat: hit.lat, lng: hit.lng });
      }
      if (ctx.osPlaces?.enabled()) {
        try {
          for (const r of await ctx.osPlaces.search(text)) { const pcn = tryPostcode(r.postcode); if (pcn) out.push({ from: 'os_places', label: r.label, line1: r.line1, postcode: pcn.postcode, lat: r.lat, lng: r.lng }); }
        } catch (e) { logger.warn?.(`address search (OS Places) unavailable: ${e.message}`); }
      }
      try {
        for (const r of await photon.search(text, { near })) {
          if (r.postcode && !tryPostcode(r.postcode)) continue;
          out.push({ from: 'photon', label: r.label, line1: r.line1, postcode: r.postcode ? tryPostcode(r.postcode).postcode : null, lat: r.lat, lng: r.lng });
        }
      } catch (e) { logger.warn?.(`address search (Photon) unavailable: ${e.message}`); }
    }
    return out;
  }

  async function manual(body, { actor = 'admin' } = {}) {
    return orders.create({ ...body, source: 'manual', external_id: body.external_id ?? null }, { actor });
  }

  return { failures, retryFailure, dismissFailure, ownSiteAuth, fromOwnSite, hubriseAuthorizeUrl, hubriseExchange, verifyHubRise, handleHubRiseEvent, verifyPlatform, handlePlatformEvent, searchAddress, manual, hubriseConnected: () => Boolean(hr()) };
}
