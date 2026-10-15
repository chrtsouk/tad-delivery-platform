/** Small display helpers for the board. */
const SOURCES = { manual: 'Phone', 'own-site': 'Website', hubrise: 'HubRise', ubereats: 'Uber Eats', deliveroo: 'Deliveroo', justeat: 'Just Eat' };
export const sourceLabel = (s) => SOURCES[String(s || '').toLowerCase().replace(/[^a-z-]/g, '')] || (s ? String(s) : 'Unknown');

export const itemsSummary = (items = []) => items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(', ');

/** 3-digit tail of the order number: TAD-20261015-003 -> 003 */
export const shortNo = (number) => String(number || '').split('-').pop();

/** Seconds -> "4:05" or "1:04:05". */
export function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const EVENT_LABELS = {
  created: 'Order created', label_printed: 'Label printed', bag_scanned: 'Bag scanned by driver', fleetbase_synced: 'Sent to the dispatch system',
  fleetbase_dispatched: 'Dispatched to the driver app', fleetbase_dispatch_failed: 'Dispatch to the driver app failed',
  incident: 'Incident reported', flag_warning: 'Customer is flagged', block_overridden: 'Block overridden by the shop',
};
const STATE_LABELS = { scheduled: 'Scheduled', new: 'New', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready', assigned: 'Given to a driver', out: 'Out for delivery', delivered: 'Delivered', collected: 'Collected', failed: 'Delivery failed', removed: 'Removed', cancelled: 'Cancelled' };
export const stateLabel = (s) => STATE_LABELS[s] || s;
export function eventLabel(type) {
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  if (type?.startsWith('state:')) return stateLabel(type.slice(6));
  return type || 'Event';
}
export function eventDetail(e) {
  const d = e.detail;
  if (!d) return '';
  const bits = [];
  if (d.reason) bits.push(d.reason);
  if (d.driver) bits.push(`driver ${d.driver}`);
  if (d.error) bits.push(d.error);
  if (d.why) bits.push(d.why);
  if (d.source) bits.push(`via ${sourceLabel(d.source)}`);
  return bits.join(' · ');
}

/** The server hides the text of 5xx errors, so explain the two printer failures by their code. */
export function printProblem(e) {
  if (e?.code === 'not_configured') return 'No label printer is set up on the server. The label page opened in a new window, so you can print it from the browser.';
  if (e?.code === 'printer_unreachable') return 'The label printer did not answer (is it on and on the network?). The label page opened in a new window, so you can print it from the browser.';
  return `${e?.message || 'The label could not be printed'}. The label page opened in a new window, so you can print it from the browser.`;
}
