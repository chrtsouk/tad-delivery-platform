export const STATE_HEADLINE = {
  scheduled: 'Scheduled for later',
  new: 'Order received',
  accepted: 'Order accepted',
  preparing: 'Being made',
  ready: 'Ready — finding your driver',
  assigned: 'Driver on the way to the shop',
  out: 'Out for delivery',
  delivered: 'Delivered',
  collected: 'Collected',
  cancelled: 'Order cancelled',
  removed: 'Order cancelled',
  failed: "We couldn't deliver",
};

export function headline(o) {
  if (o.closed) return 'Order cancelled';
  if (o.failed) return "We couldn't deliver";
  return STATE_HEADLINE[o.state] || o.steps?.find((s) => s.current)?.label || 'Order update';
}

export function queueText(o) {
  const n = o.queue_position;
  if (n == null || o.closed || o.failed) return null;
  if (o.state === 'out') return n <= 1 ? "You're the next stop" : `${n - 1} ${n - 1 === 1 ? 'stop' : 'stops'} before yours`;
  return n <= 1 ? "You're next in the queue" : `You're #${n} in the queue`;
}

export function etaText(o) {
  if (o.eta_minutes == null || o.closed || o.failed) return null;
  const m = o.eta_minutes;
  const approx = m <= 1 ? 'about 1 min' : `about ${m} min`;
  return { approx, clock: o.eta_at ? clockTime(o.eta_at) : null };
}

export function clockTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function placedText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `Placed today at ${t}` : `Placed ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${t}`;
}

export const digits = (p) => String(p ?? '').replace(/[^\d]/g, '');

/** Bearing in degrees from a to b. */
export function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
