import { loadEnvFile, loadConfig } from './lib/config.js';
import { buildContext } from './lib/context.js';
import { createApp } from './server/app.js';

loadEnvFile();
const config = loadConfig();
if (!config.trackSecret || !config.sessionSecret) {
  console.error('Missing TRACK_SECRET / SESSION_SECRET. Run: node scripts/init-env.mjs');
  process.exit(1);
}
const ctx = buildContext({ config });
const app = createApp(ctx);

const server = app.listen(config.port, () => console.log(`TAD delivery platform on ${config.publicUrl} (port ${config.port})`));

let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await ctx.fbsync.reconcile();
    await ctx.batcher.tick({ skipIfBusy: true });
    await ctx.hubsync.pushPending();
    await ctx.hubsync.pollEvents();
  } catch (e) { console.warn('tick:', e.message); } finally { busy = false; }
}, config.tickMs);

const stop = () => { clearInterval(timer); server.close(() => { ctx.db.close(); process.exit(0); }); server.closeAllConnections?.(); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
