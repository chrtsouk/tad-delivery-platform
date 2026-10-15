import crypto from 'node:crypto';
import { AppError } from '../lib/util.js';
import { sign, verify, safeEqual } from '../lib/tokens.js';

const COOKIE = 'tad_session';
const DAY = 12 * 3600 * 1000;

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
}

/** One role: admin (the shop tablet). Password -> signed session cookie; a static API token works for scripts. */
export function createAuth(ctx) {
  const { config, now } = ctx;
  const secret = config.sessionSecret || crypto.randomBytes(24).toString('hex');
  const attempts = new Map();   // ip -> { n, until }

  function login(ip, password) {
    const a = attempts.get(ip);
    if (a && a.until > now().getTime()) throw new AppError('Too many wrong passwords. Wait a minute and try again.', 429, 'rate_limited');
    if (!config.adminPassword) throw new AppError('The admin password is not set on the server (ADMIN_PASSWORD)', 503, 'not_configured');
    if (!safeEqual(password, config.adminPassword)) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(ip, { n, until: n >= 5 ? now().getTime() + 60000 : 0 });
      throw new AppError('Wrong password', 401, 'unauthorised');
    }
    attempts.delete(ip);
    return sign(secret, `admin:${now().getTime() + DAY}`);
  }

  function isAdmin(req) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1];
    if (bearer && config.adminToken && safeEqual(bearer, config.adminToken)) return true;
    const tok = parseCookies(req.get('cookie'))[COOKIE];
    const payload = tok && verify(secret, decodeURIComponent(tok));
    return Boolean(payload && payload.startsWith('admin:') && Number(payload.slice(6)) > now().getTime());
  }

  const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : next(new AppError('Please sign in', 401, 'unauthorised')));

  const cookie = (token) => `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DAY / 1000}${config.publicUrl.startsWith('https') ? '; Secure' : ''}`;
  const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

  /** Driver app: per-driver bearer token issued by the admin. */
  function requireDriver(req, res, next) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '')?.[1];
    const id = ctx.shifts.driverFromToken(bearer);
    if (!id) return next(new AppError('Driver sign-in needed', 401, 'unauthorised'));
    req.driverId = id;
    next();
  }

  return { login, isAdmin, requireAdmin, requireDriver, cookie, clearCookie };
}
