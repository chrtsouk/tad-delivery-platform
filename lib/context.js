import crypto from 'node:crypto';
import { openDb } from './db.js';
import { createSettings } from './settings.js';
import { createAudit } from './audit.js';
import { createBus } from './bus.js';
import { createFleetbase, createOsrm, createVroom, createPostcodes, createPhoton, createHub } from './clients.js';
import { createOrders } from '../services/orders.js';
import { createShifts } from '../services/shifts.js';
import { createNotify } from '../services/notify.js';
import { createBatcher } from '../services/batcher.js';
import { createIngest } from '../services/ingest.js';
import { createHubSync } from '../services/hubsync.js';
import { createTracking } from '../services/tracking.js';
import { createLabels } from '../services/labels.js';
import { createAnalytics } from '../services/analytics.js';
import { createFleetbaseConfig } from '../services/fleetbase-config.js';

/** Wire every service together. `clients` and `now` can be replaced (tests inject fakes and a fixed clock). */
export function buildContext({ config, clients = {}, now = () => new Date(), db = null, transport = null, push = undefined, logger = console }) {
  const ctx = { config, now, logger };
  ctx.db = db ?? openDb(config.dbPath);
  ctx.trackSecret = config.trackSecret || crypto.randomBytes(24).toString('hex');
  ctx.bus = createBus();
  ctx.settings = createSettings(ctx.db);
  ctx.audit = createAudit(ctx.db, now);
  ctx.fleetbase = clients.fleetbase ?? createFleetbase(config.fleetbase);
  ctx.osrm = clients.osrm ?? createOsrm({ url: config.osrmUrl });
  ctx.vroom = clients.vroom ?? createVroom({ url: config.vroomUrl });
  ctx.postcodes = clients.postcodes ?? createPostcodes({ url: config.postcodesUrl });
  ctx.photon = clients.photon ?? createPhoton({ url: config.photonUrl });
  ctx.hub = clients.hub ?? createHub(config.hub);
  ctx.hooks = {};
  ctx.notify = createNotify({ db: ctx.db, now, config, bus: ctx.bus, transport, ...(push ? { push } : {}), logger });
  ctx.orders = createOrders(ctx);
  ctx.shifts = createShifts(ctx);
  ctx.batcher = createBatcher(ctx);
  ctx.hooks.requeueDriver = ctx.batcher.requeueDriver;
  ctx.ingest = createIngest(ctx);
  ctx.hubsync = createHubSync(ctx);
  ctx.tracking = createTracking(ctx);
  ctx.labels = createLabels(ctx);
  ctx.analytics = createAnalytics(ctx);
  ctx.fleetbaseConfig = createFleetbaseConfig(ctx);
  ctx.notify.wireCustomerEvents();
  ctx.bus.on('order', ({ order, to }) => { if (to === 'new' && ctx.hub.enabled()) ctx.hubsync.pushOrder(order).catch((e) => logger.warn?.(`hub push will retry: ${e.message}`)); });
  return ctx;
}
