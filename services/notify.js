/**
 * Free notifications — no paid SMS, no Novu.
 *   email      nodemailer over the owner's own SMTP
 *   web push   web-push-libs/web-push (VAPID) to the customer's tracking page / the driver's phone
 *   inbox      every message is also stored, so the driver app and the tracking page can poll it
 *   wa.me      click-to-chat links the admin taps to message a customer or driver from the tablet
 */
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { q } from '../lib/db.js';

const CUSTOMER_COPY = {
  accepted: (o, url) => ({ title: 'We have your order', body: `Order ${o.number} is accepted and being made. Follow it live: ${url}` }),
  out: (o, url) => ({ title: 'Out for delivery', body: `Order ${o.number} is on its way. Watch your driver: ${url}` }),
  delivered: (o) => ({ title: 'Delivered', body: `Order ${o.number} has been delivered. Enjoy! Thanks for ordering from Texas After Dark.` }),
  failed: (o, url) => ({ title: 'We could not deliver', body: `We could not deliver order ${o.number}. We will be in touch — ${url}` }),
};

export function createNotify({ db, now, config, bus, transport = null, push = webpush, logger = console }) {
  const iso = () => now().toISOString();
  const mail = transport ?? (config.smtp.host ? nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined }) : null);
  const pushOn = Boolean(config.vapid.publicKey && config.vapid.privateKey);
  if (pushOn) push.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);

  const trackUrl = (o) => `${config.publicUrl}/t/${encodeURIComponent(o.track_token)}`;

  function store(kind, target, channel, payload) {
    const r = q.run(db, 'INSERT INTO notifications(kind,target,channel,payload,created_at) VALUES(?,?,?,?,?)', kind, target, channel, JSON.stringify(payload), iso());
    return Number(r.lastInsertRowid);
  }
  const markSent = (id, error) => q.run(db, 'UPDATE notifications SET sent_at = ?, error = ? WHERE id = ?', iso(), error ?? null, id);

  async function sendPush(kind, ref, payload) {
    if (!pushOn) return 0;
    let sent = 0;
    for (const s of q.all(db, 'SELECT * FROM push_subscriptions WHERE kind = ? AND ref = ?', kind, ref)) {
      try { await push.sendNotification(JSON.parse(s.sub_json), JSON.stringify(payload)); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) q.run(db, 'DELETE FROM push_subscriptions WHERE id = ?', s.id); else logger.warn?.(`web-push failed: ${e.message}`); }
    }
    return sent;
  }

  /** To a driver: stored in the inbox (the app polls /driver/notifications) and pushed if he subscribed. Returns the inbox id. */
  function driver(driverId, payload) {
    const id = store(payload.kind, driverId, 'inbox', payload);
    sendPush('driver', driverId, payload).then((n) => markSent(id, n ? null : undefined)).catch(() => {});
    bus?.emit('notify', { target: `driver:${driverId}`, payload });
    return id;
  }

  /** To a customer: tracking-link message by web push, email (if we have one) and the inbox the tracking page shows. */
  async function customer(order, kind) {
    const copy = CUSTOMER_COPY[kind]?.(order, trackUrl(order));
    if (!copy) return null;
    const payload = { kind, ...copy, url: trackUrl(order), order: order.number };
    const id = store(kind, order.number, 'inbox', payload);
    const results = { inbox: id, push: await sendPush('order', order.number, payload), email: false };
    if (order.customer_email && mail) {
      try { await mail.sendMail({ from: config.smtp.from, to: order.customer_email, subject: `${copy.title} — ${order.number}`, text: copy.body }); results.email = true; q.run(db, 'INSERT INTO notifications(kind,target,channel,payload,created_at,sent_at) VALUES(?,?,?,?,?,?)', kind, order.customer_email, 'email', JSON.stringify(payload), iso(), iso()); }
      catch (e) { logger.warn?.(`email to customer failed: ${e.message}`); q.run(db, 'INSERT INTO notifications(kind,target,channel,payload,created_at,error) VALUES(?,?,?,?,?,?)', kind, order.customer_email, 'email', JSON.stringify(payload), iso(), e.message); }
    }
    markSent(id);
    return results;
  }

  const subscribe = (kind, ref, sub) => q.run(db, 'INSERT INTO push_subscriptions(kind,ref,endpoint,sub_json,created_at) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET kind=excluded.kind, ref=excluded.ref, sub_json=excluded.sub_json', kind, ref, sub.endpoint, JSON.stringify(sub), iso());

  const inbox = (target, { unreadOnly = true } = {}) =>
    q.all(db, `SELECT id, kind, payload, created_at, read_at FROM notifications WHERE target = ? AND channel = 'inbox' ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 50`, target).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  const markRead = (target, ids) => ids.length && q.run(db, `UPDATE notifications SET read_at = ? WHERE target = ? AND id IN (${ids.map(() => '?').join(',')})`, iso(), target, ...ids);

  /** https://wa.me click-to-chat link: opens WhatsApp with the message ready; the human taps send. */
  function waLink(phone, message) {
    const digits = String(phone ?? '').replace(/[^\d]/g, '');
    return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
  }

  /** Watch the bus: accepted / out for delivery / delivered / failed go to the customer by themselves. */
  function wireCustomerEvents() {
    bus.on('order', ({ order, to }) => { if (CUSTOMER_COPY[to] && order.fulfilment === 'delivery') customer(order, to).catch((e) => logger.warn?.(e.message)); });
  }

  return { driver, customer, subscribe, inbox, markRead, waLink, wireCustomerEvents, trackUrl, vapidPublicKey: config.vapid.publicKey || null };
}
