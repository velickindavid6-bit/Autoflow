import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let app, base, origin;
process.env.LOG_REQUESTS = '0';

before(async () => {
  const config = loadConfig({ dbFile: ':memory:', limits: { regPerHour: 1000, loginPerIp10Min: 1000, loginFailsPerEmail: 5, globalPerMin: 100000 } });
  app = createApp({ config, db: openDb(':memory:') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
  origin = base;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function call(method, path, { body, cookie, csrf, headers = {}, noOrigin } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  if (!noOrigin && !h.Origin) h.Origin = origin;
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  const r = await fetch(base + path, { method, headers: h, redirect: 'manual',
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let json = null;
  const text = await r.text();
  try { json = JSON.parse(text); } catch { /* html/text */ }
  const sc = r.headers.get('set-cookie');
  return { status: r.status, json, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : null };
}

const good = (n = 1) => ({ name: 'Иван Петров', email: `user${n}@example.com`, phone: '+7 700 123 45 67', password: 'Secret123' });

test('регистрация: успех, сессия и /api/me', async () => {
  const r = await call('POST', '/api/register', { body: good(1) });
  assert.equal(r.status, 201);
  assert.ok(r.cookie.startsWith('af_sid='));
  assert.ok(/HttpOnly/i.test(r.headers.get('set-cookie')));
  assert.ok(/SameSite=Lax/i.test(r.headers.get('set-cookie')));
  assert.equal(r.json.user.email, 'user1@example.com');
  assert.ok(!('password' in r.json.user) && !('password_hash' in r.json.user));
  assert.equal(typeof r.json.user.id, 'string');
  const me = await call('GET', '/api/me', { cookie: r.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.name, 'Иван Петров');
  assert.equal(me.json.csrf, r.json.csrf);
});

test('регистрация: валидация и дубликат email', async () => {
  let r = await call('POST', '/api/register', { body: { ...good(2), password: '12345678' } });
  assert.equal(r.status, 400); assert.ok(r.json.fields.password);
  r = await call('POST', '/api/register', { body: { ...good(2), name: 'Иван' } });
  assert.ok(r.json.fields.name);
  r = await call('POST', '/api/register', { body: { ...good(2), email: 'nope' } });
  assert.ok(r.json.fields.email);
  r = await call('POST', '/api/register', { body: { ...good(2), name: '<b>Ив</b> Петров' } });
  assert.ok(r.json.fields.name);
  r = await call('POST', '/api/register', { body: { name: 1, email: [], phone: {}, password: null } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/register', { body: { ...good(1), email: 'USER1@example.com ' } });
  assert.equal(r.status, 409);
});

test('вход: верный и неверный пароль, одинаковая ошибка для неизвестного email', async () => {
  let r = await call('POST', '/api/login', { body: { email: 'user1@example.com', password: 'wrong' } });
  assert.equal(r.status, 401);
  const r2 = await call('POST', '/api/login', { body: { email: 'ghost@example.com', password: 'Secret123' } });
  assert.equal(r2.status, 401);
  assert.deepEqual(r.json, r2.json);
  r = await call('POST', '/api/login', { body: { email: 'User1@Example.com', password: 'Secret123' } });
  assert.equal(r.status, 200);
  assert.ok(r.cookie);
});

test('защита: без cookie нет доступа, подделанный cookie не работает', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie: 'af_sid=abc' })).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie: 'af_sid=' + 'a'.repeat(500) })).status, 401);
});

test('защита: подмена id в URL/теле не даёт доступ к чужим данным', async () => {
  const a = await call('POST', '/api/register', { body: good(10) });
  const b = await call('POST', '/api/register', { body: good(11) });
  const viaQuery = await call('GET', `/api/me?id=${b.json.user.id}&userId=1`, { cookie: a.cookie });
  assert.equal(viaQuery.json.user.email, 'user10@example.com');
  const patch = await call('PATCH', '/api/me', { cookie: a.cookie, csrf: a.json.csrf,
    body: { id: b.json.user.id, userId: 2, email: 'x@x.com', name: 'Анна Новая', phone: '' } });
  assert.equal(patch.status, 200);
  const bMe = await call('GET', '/api/me', { cookie: b.cookie });
  assert.equal(bMe.json.user.name, 'Иван Петров');
  const aMe = await call('GET', '/api/me', { cookie: a.cookie });
  assert.equal(aMe.json.user.name, 'Анна Новая');
  assert.equal(aMe.json.user.email, 'user10@example.com');
  assert.equal((await call('GET', '/api/users/1', { cookie: a.cookie })).status, 404);
});

test('CSRF: чужой Origin, отсутствие Origin и токена блокируются', async () => {
  const a = await call('POST', '/api/register', { body: good(20) });
  let r = await call('PATCH', '/api/me', { cookie: a.cookie, csrf: a.json.csrf, headers: { Origin: 'http://evil.example' }, body: { name: 'Хакер Хакеров', phone: '' } });
  assert.equal(r.status, 403);
  r = await call('PATCH', '/api/me', { cookie: a.cookie, csrf: a.json.csrf, noOrigin: true, body: { name: 'Хакер Хакеров', phone: '' } });
  assert.equal(r.status, 403);
  r = await call('PATCH', '/api/me', { cookie: a.cookie, body: { name: 'Хакер Хакеров', phone: '' } });
  assert.equal(r.status, 403); assert.equal(r.json.error, 'bad_csrf');
  r = await call('PATCH', '/api/me', { cookie: a.cookie, csrf: 'wrong', body: { name: 'Хакер Хакеров', phone: '' } });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/login', { headers: { Origin: 'http://evil.example' }, body: { email: 'user20@example.com', password: 'Secret123' } });
  assert.equal(r.status, 403);
  r = await call('POST', '/api/login', { headers: { 'Content-Type': 'text/plain' }, body: '{"email":"a","password":"b"}' });
  assert.equal(r.status, 415);
});

test('выход инвалидирует сессию на сервере', async () => {
  const a = await call('POST', '/api/register', { body: good(30) });
  const out = await call('POST', '/api/logout', { cookie: a.cookie, csrf: a.json.csrf, body: {} });
  assert.equal(out.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: a.cookie })).status, 401);
});

test('удаление аккаунта требует пароль', async () => {
  const a = await call('POST', '/api/register', { body: good(40) });
  let r = await call('DELETE', '/api/me', { cookie: a.cookie, csrf: a.json.csrf, body: { password: 'bad' } });
  assert.equal(r.status, 403);
  r = await call('DELETE', '/api/me', { cookie: a.cookie, csrf: a.json.csrf, body: { password: 'Secret123' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: a.cookie })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { email: 'user40@example.com', password: 'Secret123' } })).status, 401);
});

test('страницы: кабинет только после входа, гость не видит login после входа', async () => {
  let r = await call('GET', '/dashboard');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/login');
  assert.equal((await call('GET', '/login')).status, 200);
  const a = await call('POST', '/api/register', { body: good(50) });
  r = await call('GET', '/dashboard', { cookie: a.cookie });
  assert.equal(r.status, 200); assert.ok(r.text.includes('<html'));
  r = await call('GET', '/login', { cookie: a.cookie });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/dashboard');
  r = await call('GET', '/dashboard.html');
  assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/dashboard');
});

test('статика: траверсал, dot-файлы, неразрешённые типы, //host', async () => {
  assert.equal((await call('GET', '/style.css')).status, 200);
  assert.equal((await call('GET', '/assets/btn-login.png')).status, 200);
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server.js', '/assets/../../server.js',
    '/.env', '/data/autoflow.db', '/src/app.js', '/server.js', '/package.json', '/%00.css', '/..\\server.js', '/index.html%00.png']) {
    const r = await call('GET', p);
    assert.ok([400, 404, 301].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.text.includes('createServer'), p);
  }
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const s = net.connect(new URL(base).port, '127.0.0.1', () => s.write('GET //evil.com/x HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n'));
      let buf = ''; s.on('data', d => buf += d); s.on('end', () => resolve(buf));
    });
  });
  assert.ok(raw.startsWith('HTTP/1.1 400'));
});

test('заголовки безопасности', async () => {
  const r = await call('GET', '/');
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(!r.headers.get('x-powered-by'));
});

test('большое тело отклоняется', async () => {
  const r = await call('POST', '/api/register', { body: JSON.stringify({ name: 'x'.repeat(40000) }) });
  assert.equal(r.status, 413);
});

test('блокировка перебора пароля (5 неудач → 429), даже для несуществующего email', async () => {
  for (const email of ['user1@example.com', 'nobody@example.com']) {
    let last;
    for (let i = 0; i < 6; i++) last = await call('POST', '/api/login', { body: { email, password: 'bad-pass-' + i } });
    assert.equal(last.status, 429, email);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  }
  // верный пароль во время блокировки тоже не пускает
  const r = await call('POST', '/api/login', { body: { email: 'user1@example.com', password: 'Secret123' } });
  assert.equal(r.status, 429);
});

test('лимит регистраций с одного IP (настройки по умолчанию)', async () => {
  const app2 = createApp({ config: loadConfig({ dbFile: ':memory:' }), db: openDb(':memory:') });
  await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${app2.server.address().port}`;
  let last;
  for (let i = 0; i < 12; i++) {
    last = await fetch(b2 + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2 }, body: JSON.stringify(good(200 + i)) });
  }
  assert.equal(last.status, 429);
  app2.server.closeAllConnections?.(); app2.server.close();
});
