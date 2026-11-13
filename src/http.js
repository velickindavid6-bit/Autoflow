export class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    // Берём последний адрес: его дописал наш доверенный прокси; первый может подделать клиент
    const xff = req.headers['x-forwarded-for'];
    if (xff) { const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
  }
  return req.socket.remoteAddress || 'unknown';
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, secure }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? [].concat(prev) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return reject(new HttpError(415, 'unsupported_media_type'));
    let size = 0, failed = false;
    const chunks = [];
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; chunks.length = 0; reject(new HttpError(413, 'payload_too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
        resolve(v);
      } catch { reject(new HttpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

// Защита от CSRF для изменяющих запросов: Origin обязан совпадать с нашим хостом
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
