export class AppError extends Error {
  constructor(message, status = 400, code = 'bad_request') { super(message); this.status = status; this.code = code; }
}

export const text = (v, max, what, { required = false } = {}) => {
  const t = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!t) { if (required) throw new AppError(`${what} is needed`); return null; }
  if (t.length > max) throw new AppError(`${what} is too long (${max} characters at most)`);
  return t;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toInt(v, what, { min = 0, max = 1e9, fallback } = {}) {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new AppError(`${what} is needed`); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${what} must be a whole number from ${min} to ${max}`);
  return n;
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = err.status && Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) logger.error?.(`[${req.method} ${req.path}]`, err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side' : err.message, code: err.code || 'error' });
  };
}

export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error || data.message || JSON.stringify(data.errors))) || `HTTP ${res.status}`;
      throw new AppError(`${new URL(url).host} said: ${msg}`, 502, 'upstream_error');
    }
    return data;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(`Could not reach ${new URL(url).host}: ${e.name === 'AbortError' ? 'timed out' : e.message}`, 502, 'upstream_unreachable');
  } finally { clearTimeout(t); }
}
