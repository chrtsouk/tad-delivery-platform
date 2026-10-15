/**
 * Fleetbase -> platform: the Navigator app (and the Fleetbase console) change orders directly in Fleetbase, so we reconcile.
 * Called every tick and on a Fleetbase webhook. A driver starting any order of a run sends the whole run out; completing an
 * order delivers it (customer notification, run completion, return ETA all follow from our own state machine).
 */
import { q } from '../lib/db.js';

export function createFbSync(ctx) {
  const { db, fleetbase, orders, batcher, logger = console } = ctx;

  async function reconcileOrder(row) {
    let fb;
    try { fb = await fleetbase.order(row.fleetbase_order_id); } catch (e) { logger.debug?.(e.message); return null; }
    if (!fb) return null;
    const status = String(fb.status || '').toLowerCase();
    const o = orders.byId(row.id);
    if (['started', 'enroute', 'driver_enroute'].includes(status) && o.state === 'assigned' && o.batch_id) {
      const b = q.get(db, 'SELECT status FROM batches WHERE id = ?', o.batch_id);
      if (b?.status === 'assigned') { await batcher.markOut(o.batch_id, { actor: 'fleetbase' }); return 'out'; }
    }
    if (status === 'completed' && ['assigned', 'out'].includes(orders.byId(row.id).state)) {
      if (orders.byId(row.id).state === 'assigned' && o.batch_id) await batcher.markOut(o.batch_id, { actor: 'fleetbase' }).catch(() => {});
      await batcher.deliver(row.id, { actor: 'fleetbase', skipFleetbase: true });
      return 'delivered';
    }
    return null;
  }

  async function reconcile() {
    const rows = q.all(db, "SELECT id, fleetbase_order_id FROM orders WHERE fleetbase_order_id IS NOT NULL AND state IN ('assigned','out')");
    const changed = [];
    for (const r of rows) { const c = await reconcileOrder(r).catch((e) => { logger.warn?.(`fleetbase reconcile ${r.id}: ${e.message}`); return null; }); if (c) changed.push([r.id, c]); }
    return changed;
  }

  const onWebhook = async (publicId) => {
    const row = q.get(db, 'SELECT id, fleetbase_order_id FROM orders WHERE fleetbase_order_id = ?', publicId);
    return row ? reconcileOrder(row) : null;
  };

  return { reconcile, reconcileOrder, onWebhook };
}
