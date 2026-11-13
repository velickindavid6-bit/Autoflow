import crypto from 'node:crypto';

/* ---------- Пароли: scrypt (встроен в Node, устойчив к подбору на GPU) ---------- */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const scrypt = (password, salt, o) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: SCRYPT.maxmem },
    (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const key = await scrypt(password, Buffer.from(salt, 'base64'),
      { N: +N, r: +r, p: +p, keylen: expected.length });
    return crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

// Фиктивный хеш: чтобы вход по несуществующему email занимал столько же времени
export const DUMMY_HASH = await hashPassword(crypto.randomBytes(12).toString('hex'));

/* ---------- Токены ---------- */
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const publicId = () => crypto.randomBytes(12).toString('base64url');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- Ограничитель частоты запросов (в памяти) ---------- */
export class RateLimiter {
  constructor(maxKeys = 100000) {
    this.m = new Map();
    this.maxKeys = maxKeys;
    this.timer = setInterval(() => this.sweep(), 60000);
    this.timer.unref();
  }
  _live(key, windowMs, now) {
    const e = this.m.get(key);
    if (!e) return [];
    return e.times.filter(t => now - t < windowMs);
  }
  hit(key, windowMs) {
    const now = Date.now();
    const times = this._live(key, windowMs, now);
    times.push(now);
    if (!this.m.has(key) && this.m.size >= this.maxKeys) {
      let n = 0;
      for (const k of this.m.keys()) { this.m.delete(k); if (++n >= 10000) break; }
    }
    this.m.set(key, { times, windowMs });
    return times.length;
  }
  count(key, windowMs) { return this._live(key, windowMs, Date.now()).length; }
  retryAfter(key, windowMs) {
    const t = this._live(key, windowMs, Date.now());
    return t.length ? Math.max(1, Math.ceil((t[0] + windowMs - Date.now()) / 1000)) : 0;
  }
  clear(key) { this.m.delete(key); }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.m) if (!e.times.some(t => now - t < e.windowMs)) this.m.delete(k);
  }
}

/* ---------- Заголовки безопасности ---------- */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(res, isProd) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}
