import crypto from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest();

/** Signed, URL-safe token: "<payload>.<sig>". Payload is public (an order number), the signature is the credential. */
export function sign(secret, payload) { return `${payload}.${b64(hmac(secret, payload)).slice(0, 22)}`; }
export function verify(secret, token) {
  const i = String(token ?? '').lastIndexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i), sig = token.slice(i + 1);
  const good = b64(hmac(secret, payload)).slice(0, 22);
  const a = Buffer.from(sig), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? payload : null;
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 24) => crypto.randomBytes(n).toString('base64url');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
