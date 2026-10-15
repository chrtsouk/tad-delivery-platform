/** Public tracking API client. The token is the last path segment of /t/<token>, passed back exactly as received. */
export function tokenFromLocation(loc = window.location) {
  const parts = loc.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('t');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : parts[parts.length - 1] || '';
}

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function call(token, suffix = '', opts = {}) {
  let res;
  try {
    res = await fetch(`/api/track/${token}${suffix}`, { headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, cache: 'no-store', ...opts });
  } catch {
    throw new ApiError('You appear to be offline', 0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw new ApiError(data?.error || `Something went wrong (${res.status})`, res.status, data?.code);
  return data;
}

export const fetchOrder = (token) => call(token);
export const fetchInbox = (token) => call(token, '/inbox');
export const postRating = (token, rating) => call(token, '/rate', { method: 'POST', body: JSON.stringify({ rating }) });
export const postSubscription = (token, sub) => call(token, '/subscribe', { method: 'POST', body: JSON.stringify(sub) });
