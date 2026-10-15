import fs from 'node:fs';
import path from 'node:path';

/** Load KEY=VALUE lines from .env.local (gitignored) into process.env without overriding real environment variables. */
export function loadEnvFile(file = path.resolve('.env.local')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** Every secret and URL comes from the environment only. Defaults point at the local docker stack. */
export function loadConfig(env = process.env) {
  const e = (k, d = '') => (env[k] !== undefined && env[k] !== '' ? env[k] : d);
  return {
    port: Number(e('PORT', 4000)),
    publicUrl: e('PUBLIC_URL', 'http://localhost:4000'),
    dbPath: e('TAD_DB_PATH', '.data/tad.sqlite'),
    adminPassword: e('ADMIN_PASSWORD'),            // the single admin (shop tablet)
    adminToken: e('ADMIN_API_TOKEN'),              // same admin, for scripts
    sessionSecret: e('SESSION_SECRET'),
    trackSecret: e('TRACK_SECRET'),                // signs customer tracking links
    fleetbaseWebhookSecret: e('FLEETBASE_WEBHOOK_SECRET'),
    ownSiteKey: e('OWN_SITE_API_KEY'),             // the own website/app posts orders with this
    fleetbase: { url: e('FLEETBASE_URL', 'http://localhost:8000'), apiKey: e('FLEETBASE_API_KEY'), socketUrl: e('FLEETBASE_SOCKET_URL', 'ws://localhost:38000') },
    vroomUrl: e('VROOM_URL', 'http://localhost:3000'),
    osrmUrl: e('OSRM_URL', 'http://localhost:5001'),
    postcodesUrl: e('POSTCODES_URL', 'http://localhost:8001'),
    photonUrl: e('PHOTON_URL', 'http://localhost:2322'),
    hub: { url: e('HUB_URL'), token: e('HUB_TOKEN'), webhookSecret: e('HUB_WEBHOOK_SECRET') },
    hubrise: { clientId: e('HUBRISE_CLIENT_ID'), clientSecret: e('HUBRISE_CLIENT_SECRET'), apiUrl: e('HUBRISE_API_URL', 'https://api.hubrise.com/v1') },
    platforms: {
      uberEats: { enabled: e('UBEREATS_ENABLED') === 'true', clientId: e('UBEREATS_CLIENT_ID'), clientSecret: e('UBEREATS_CLIENT_SECRET'), webhookSecret: e('UBEREATS_WEBHOOK_SECRET') },
      deliveroo: { enabled: e('DELIVEROO_ENABLED') === 'true', clientId: e('DELIVEROO_CLIENT_ID'), clientSecret: e('DELIVEROO_CLIENT_SECRET'), webhookSecret: e('DELIVEROO_WEBHOOK_SECRET') },
      justEat: { enabled: e('JUSTEAT_ENABLED') === 'true', apiKey: e('JUSTEAT_API_KEY'), webhookSecret: e('JUSTEAT_WEBHOOK_SECRET') },
    },
    smtp: { host: e('SMTP_HOST'), port: Number(e('SMTP_PORT', 587)), user: e('SMTP_USER'), pass: e('SMTP_PASS'), from: e('SMTP_FROM') },
    vapid: { publicKey: e('VAPID_PUBLIC_KEY'), privateKey: e('VAPID_PRIVATE_KEY'), subject: e('VAPID_SUBJECT', 'mailto:info@example.com') },
    printer: { host: e('PRINTER_HOST'), port: Number(e('PRINTER_PORT', 9100)), type: e('PRINTER_TYPE', 'epson') },
    osPlacesKey: e('OS_PLACES_API_KEY'),
    tickMs: Number(e('TICK_MS', 15000)),
  };
}
