import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createMailer, buildMessage } from '../src/mailer.js';

process.env.LOG_REQUESTS = '0';
let app, db, base;
const APP_URL = 'https://autoflow.test';

before(async () => {
  const config = loadConfig({
    dbFile: ':memory:', appUrl: APP_URL, mail: { transport: 'memory', contactTo: 'owner@example.com' },
    limits: { regPerHour: 1000, loginPerIp10Min: 1000, globalPerMin: 100000, tokenPerIp10Min: 1000, forgotPerIpHour: 1000 },
  });
  db = openDb(':memory:');
  app = createApp({ config, db });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function call(method, path, { body, cookie, csrf, headers = {} } = {}) {
  const h = { Origin: base, ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  const r = await fetch(base + path, { method, headers: h, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
  const sc = r.headers.get('set-cookie');
  return { status: r.status, json, text, headers: r.headers, cookie: sc ? sc.split(';')[0] : null };
}
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));          // письма уходят в фоне
const user = (n) => ({ name: 'Иван Петров', email: `mail${n}@example.com`, phone: '+7 700 123 45 67', password: 'Secret123' });
const mailsTo = (email) => app.mailer.outbox.filter(m => m.to === email);
const tokenFrom = (mail) => new URLSearchParams(new URL(mail.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token');

test('регистрация отправляет письмо, ссылка подтверждает email один раз', async () => {
  const reg = await call('POST', '/api/register', { body: user(1) });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.user.emailVerified, false);
  await wait();
  const [mail] = mailsTo('mail1@example.com');
  assert.ok(mail, 'письмо не отправлено');
  assert.ok(mail.text.includes(`${APP_URL}/verify-email#token=`), 'ссылка строится из APP_URL');
  assert.ok(mail.html.includes('Подтвердить email'));
  const token = tokenFrom(mail);

  assert.equal((await call('POST', '/api/verify-email', { body: { token: 'x'.repeat(40) } })).status, 400);
  const ok = await call('POST', '/api/verify-email', { body: { token } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: reg.cookie })).json.user.emailVerified, true);
  assert.equal((await call('POST', '/api/verify-email', { body: { token } })).status, 400, 'ссылка одноразовая');
});

test('в БД хранится только хеш токена', () => {
  const rows = db.prepare('SELECT token_hash FROM email_tokens').all();
  assert.ok(rows.length > 0);
  for (const r of rows) assert.match(r.token_hash, /^[0-9a-f]{64}$/);
});

test('повторная отправка подтверждения: нужна сессия, лимит, новая ссылка отменяет старую', async () => {
  assert.equal((await call('POST', '/api/verify-email/send', { body: {} })).status, 401);
  const reg = await call('POST', '/api/register', { body: user(2) });
  await wait();
  const first = tokenFrom(mailsTo('mail2@example.com')[0]);
  assert.equal((await call('POST', '/api/verify-email/send', { cookie: reg.cookie, body: {} })).status, 403, 'нужен CSRF-токен');
  const r = await call('POST', '/api/verify-email/send', { cookie: reg.cookie, csrf: reg.json.csrf, body: {} });
  assert.equal(r.status, 200);
  await wait();
  assert.equal(mailsTo('mail2@example.com').length, 2);
  assert.equal((await call('POST', '/api/verify-email', { body: { token: first } })).status, 400, 'старая ссылка отменена');
  const second = tokenFrom(mailsTo('mail2@example.com')[1]);
  assert.equal((await call('POST', '/api/verify-email', { body: { token: second } })).status, 200);
  const again = await call('POST', '/api/verify-email/send', { cookie: reg.cookie, csrf: reg.json.csrf, body: {} });
  assert.equal(again.json.alreadyVerified, true);
});

test('забыли пароль: одинаковый ответ для существующего и несуществующего email', async () => {
  await call('POST', '/api/register', { body: user(3) });
  await wait();
  const before = app.mailer.outbox.length;
  const known = await call('POST', '/api/forgot-password', { body: { email: 'MAIL3@example.com ' } });
  const ghost = await call('POST', '/api/forgot-password', { body: { email: 'ghost@example.com' } });
  assert.equal(known.status, 200); assert.equal(ghost.status, 200);
  assert.deepEqual(known.json, ghost.json);
  await wait();
  assert.equal(app.mailer.outbox.length, before + 1, 'письмо ушло только существующему');
  assert.equal(mailsTo('ghost@example.com').length, 0);
  assert.equal((await call('POST', '/api/forgot-password', { body: { email: 'not-an-email' } })).status, 400);
});

test('сброс пароля: новый пароль работает, старый нет, все сессии завершены, ссылка одноразовая', async () => {
  const reg = await call('POST', '/api/register', { body: user(4) });
  await wait();
  await call('POST', '/api/forgot-password', { body: { email: 'mail4@example.com' } });
  await wait();
  const mail = mailsTo('mail4@example.com').at(-1);
  assert.ok(mail.text.includes(`${APP_URL}/reset-password#token=`));
  const token = tokenFrom(mail);

  assert.equal((await call('POST', '/api/reset-password/check', { body: { token } })).json.valid, true);
  assert.equal((await call('POST', '/api/reset-password/check', { body: { token: 'nope' } })).json.valid, false);

  // слабый пароль отклоняется и НЕ сжигает ссылку
  let r = await call('POST', '/api/reset-password', { body: { token, password: '12345678' } });
  assert.equal(r.status, 400); assert.ok(r.json.fields.password);
  assert.equal((await call('POST', '/api/reset-password/check', { body: { token } })).json.valid, true);

  r = await call('POST', '/api/reset-password', { body: { token, password: 'BrandNew456' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: reg.cookie })).status, 401, 'старая сессия завершена');
  assert.equal((await call('POST', '/api/login', { body: { email: 'mail4@example.com', password: 'Secret123' } })).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { email: 'mail4@example.com', password: 'BrandNew456' } })).status, 200);
  assert.equal((await call('POST', '/api/reset-password', { body: { token, password: 'Another789' } })).status, 400, 'повторно ссылка не работает');
});

test('просроченная ссылка не работает; токен для другой цели не подходит', async () => {
  const reg = await call('POST', '/api/register', { body: user(5) });
  await wait();
  const verifyToken = tokenFrom(mailsTo('mail5@example.com')[0]);
  assert.equal((await call('POST', '/api/reset-password', { body: { token: verifyToken, password: 'Whatever123' } })).status, 400, 'verify-токен не сбрасывает пароль');

  await call('POST', '/api/forgot-password', { body: { email: 'mail5@example.com' } });
  await wait();
  const token = tokenFrom(mailsTo('mail5@example.com').at(-1));
  db.prepare("UPDATE email_tokens SET expires_at = ? WHERE purpose = 'reset'").run(Date.now() - 1000);
  assert.equal((await call('POST', '/api/reset-password', { body: { token, password: 'Whatever123' } })).status, 400);
  assert.equal((await call('POST', '/api/me', { cookie: reg.cookie })).status !== 200, true);
});

test('лимит запросов на сброс по email: письма не уходят, ответ тот же', async () => {
  await call('POST', '/api/register', { body: user(6) });
  await wait();
  const start = mailsTo('mail6@example.com').length;
  for (let i = 0; i < 6; i++) assert.equal((await call('POST', '/api/forgot-password', { body: { email: 'mail6@example.com' } })).status, 200);
  await wait();
  assert.equal(mailsTo('mail6@example.com').length - start, 3, 'не больше 3 писем в час');
});

test('ссылки в письмах не зависят от заголовка Host (защита от подмены)', async () => {
  await call('POST', '/api/register', { body: user(7) });
  await wait();
  await fetch(base + '/api/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-Host': 'evil.example' },
    body: JSON.stringify({ email: 'mail7@example.com' }) });
  await wait();
  const mail = mailsTo('mail7@example.com').at(-1);
  assert.ok(!mail.text.includes('evil.example'));
  assert.ok(mail.text.includes(APP_URL));
});

test('смена пароля: нужен текущий пароль, остальные сессии завершаются, текущая остаётся', async () => {
  const a = await call('POST', '/api/register', { body: user(8) });
  const b = await call('POST', '/api/login', { body: { email: 'mail8@example.com', password: 'Secret123' } });
  assert.equal((await call('POST', '/api/change-password', { cookie: a.cookie, body: { current: 'Secret123', password: 'Newpass456' } })).status, 403, 'без CSRF нельзя');
  let r = await call('POST', '/api/change-password', { cookie: a.cookie, csrf: a.json.csrf, body: { current: 'wrong', password: 'Newpass456' } });
  assert.equal(r.status, 403); assert.ok(r.json.fields.current);
  r = await call('POST', '/api/change-password', { cookie: a.cookie, csrf: a.json.csrf, body: { current: 'Secret123', password: '123' } });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/change-password', { cookie: a.cookie, csrf: a.json.csrf, body: { current: 'Secret123', password: 'Newpass456' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie: a.cookie })).status, 200, 'текущая сессия жива');
  assert.equal((await call('GET', '/api/me', { cookie: b.cookie })).status, 401, 'другая сессия завершена');
  assert.equal((await call('POST', '/api/login', { body: { email: 'mail8@example.com', password: 'Newpass456' } })).status, 200);
});

test('форма «Контакты»: валидация, сохранение, пересылка владельцу, лимит', async () => {
  let r = await call('POST', '/api/contact', { body: { name: 'A', email: 'bad', message: 'коротко' } });
  assert.equal(r.status, 400); assert.ok(r.json.fields.name && r.json.fields.email && r.json.fields.message);
  r = await call('POST', '/api/contact', { body: { name: 'Анна', email: 'anna@example.com', message: 'Здравствуйте! Хочу узнать про тарифы.\r\nBcc: spy@evil.com' } });
  assert.equal(r.status, 201);
  await wait();
  const row = db.prepare('SELECT * FROM contact_messages ORDER BY id DESC').get();
  assert.equal(row.email, 'anna@example.com');
  const mail = mailsTo('owner@example.com').at(-1);
  assert.equal(mail.replyTo, 'anna@example.com');
  assert.ok(mail.text.includes('Хочу узнать про тарифы'));
  assert.equal((await call('POST', '/api/contact', { headers: { Origin: 'http://evil.example' }, body: { name: 'Анна', email: 'a@example.com', message: 'Тестовое сообщение 1234' } })).status, 403);
  for (let i = 0; i < 6; i++) r = await call('POST', '/api/contact', { body: { name: 'Анна', email: 'anna@example.com', message: 'Тестовое сообщение ' + i + '00' } });
  assert.equal(r.status, 429);
});

test('страницы: новые маршруты доступны, forgot-password только гостям', async () => {
  for (const p of ['/forgot-password', '/reset-password', '/verify-email', '/terms', '/privacy']) {
    assert.equal((await call('GET', p)).status, 200, p);
  }
  assert.equal((await call('GET', '/terms.html')).status, 301);
  const a = await call('POST', '/api/register', { body: user(9) });
  const r = await call('GET', '/forgot-password', { cookie: a.cookie });
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/dashboard');
  assert.equal((await call('GET', '/reset-password', { cookie: a.cookie })).status, 200);
});

/* ---------- Заголовки писем и SMTP ---------- */
test('заголовки письма: перевод строки в теме не позволяет внедрить заголовок, кириллица кодируется', () => {
  const raw = buildMessage({ from: 'AutoFlow <no-reply@x.kz>', to: 'u@x.kz', subject: 'Привет\r\nBcc: spy@evil.com', text: 'тест', html: '<b>тест</b>' });
  const head = raw.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/mi.test(head));
  assert.match(head, /Subject: =\?UTF-8\?B\?/);
  assert.match(head, /Content-Type: multipart\/alternative/);
});

// Мини-сервер SMTP для проверки клиента (с шифрованием и без)
function fakeSmtp({ secure, requireAuth }) {
  const log = { cmds: [], data: '' };
  const handler = (sock) => {
    let inData = false, buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else log.data += line + '\n';
          continue;
        }
        log.cmds.push(line.startsWith('AUTH PLAIN') ? 'AUTH PLAIN <hidden>' : line);
        if (line.startsWith('EHLO')) sock.write(`250-fake\r\n250 AUTH PLAIN LOGIN\r\n`);
        else if (line.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          log.auth = [user, pass];
          sock.write(user === 'bot' && pass === 'secret' ? '235 ok\r\n' : '535 bad credentials\r\n');
        }
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 ?\r\n');
      }
    });
    sock.on('error', () => {});
  };
  const server = secure
    ? tls.createServer({ key: fs.readFileSync(new URL('./fixtures/key.pem', import.meta.url)), cert: fs.readFileSync(new URL('./fixtures/cert.pem', import.meta.url)) }, handler)
    : net.createServer(handler);
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, log, port: server.address().port })));
}

test('SMTP по TLS (порт 465): авторизация, доставка, письмо читается', async () => {
  const { server, log, port } = await fakeSmtp({ secure: true });
  try {
    const mailer = createMailer({ isProd: false, mail: { transport: 'smtp', from: 'AutoFlow <no-reply@autoflow.kz>',
      smtp: { host: '127.0.0.1', port, secure: true, user: 'bot', pass: 'secret', rejectUnauthorized: false } } });
    await mailer.send({ to: 'client@example.com', subject: 'Сброс пароля', text: 'Привет!\n.точка в начале строки\nссылка', html: '<p>Привет</p>' });
    assert.deepEqual(log.auth, ['bot', 'secret']);
    assert.ok(log.cmds.includes('MAIL FROM:<no-reply@autoflow.kz>'));
    assert.ok(log.cmds.includes('RCPT TO:<client@example.com>'));
    assert.match(log.data, /^To: client@example\.com$/m);
    const textPart = log.data.split('--=_af_')[1];
    const decoded = Buffer.from(textPart.split('\n\n')[1].replace(/\n/g, ''), 'base64').toString('utf8');
    assert.ok(decoded.includes('.точка в начале строки'));
  } finally { server.close(); }
});

test('SMTP: неверный пароль даёт ошибку, а пароль не уходит по открытому каналу на чужой хост', async () => {
  const { server, port } = await fakeSmtp({ secure: true });
  try {
    const bad = createMailer({ isProd: false, mail: { transport: 'smtp', from: 'a@b.kz',
      smtp: { host: '127.0.0.1', port, secure: true, user: 'bot', pass: 'WRONG', rejectUnauthorized: false } } });
    await assert.rejects(() => bad.send({ to: 'c@example.com', subject: 's', text: 't' }), /535/);
    // сертификат не доверенный, а проверка включена, значит соединение отклоняется
    const strict = createMailer({ isProd: false, mail: { transport: 'smtp', from: 'a@b.kz',
      smtp: { host: '127.0.0.1', port, secure: true, user: 'bot', pass: 'secret' } } });
    await assert.rejects(() => strict.send({ to: 'c@example.com', subject: 's', text: 't' }));
  } finally { server.close(); }
  const open = createMailer({ isProd: false, mail: { transport: 'smtp', from: 'a@b.kz',
    smtp: { host: 'mail.example.org', port: 25, secure: false, user: 'bot', pass: 'secret' } } });
  await assert.rejects(() => open.send({ to: 'c@example.com', subject: 's', text: 't' }), /незащищ/);
});

test('SMTP без шифрования на localhost (для отладки) работает', async () => {
  const { server, log, port } = await fakeSmtp({ secure: false });
  try {
    const mailer = createMailer({ isProd: false, mail: { transport: 'smtp', from: 'a@b.kz', smtp: { host: '127.0.0.1', port, secure: false, user: '', pass: '' } } });
    await mailer.send({ to: 'c@example.com', subject: 'Тест', text: 'hello' });
    assert.ok(log.cmds.includes('RCPT TO:<c@example.com>'));
  } finally { server.close(); }
});

/* ---------- Объединённая версия: новые проверки ---------- */
test('ссылки в письмах: токен во фрагменте (#), а не в строке запроса', async () => {
  await call('POST', '/api/register', { body: user(20) });
  await wait();
  const url = new URL(mailsTo('mail20@example.com')[0].text.match(/https?:\/\/\S+/)[0]);
  assert.equal(url.search, '', 'в query токена быть не должно');
  assert.match(url.hash, /^#token=[\w-]{20,}$/);
});

test('/api/session: гость получает 200 {user:null}, вошедший получает профиль и csrf', async () => {
  const g = await call('GET', '/api/session');
  assert.equal(g.status, 200); assert.deepEqual(g.json, { user: null });
  assert.equal(g.headers.get('cache-control'), 'no-store');
  const reg = await call('POST', '/api/register', { body: user(21) });
  const s = await call('GET', '/api/session', { cookie: reg.cookie });
  assert.equal(s.json.user.email, 'mail21@example.com'); assert.ok(s.json.csrf);
  assert.equal(JSON.stringify(s.json).includes('password'), false, 'хеш пароля не отдаётся');
  const fake = await call('GET', '/api/session', { cookie: 'af_sid=' + 'a'.repeat(43) });
  assert.deepEqual(fake.json, { user: null }, 'поддельная cookie = гость');
});

test('форма «Контакты»: бот, заполнивший скрытое поле, ничего не сохраняет', async () => {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) app.limiter.clear(`contact:${ip}`);   // лимит уже исчерпан предыдущим тестом
  const before = db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n;
  const r = await call('POST', '/api/contact', { body: { name: 'Бот', email: 'bot@example.com', message: 'Купите наши товары срочно!', website: 'http://spam.example' } });
  assert.equal(r.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n, before, 'сообщение бота не сохранено');
  const ok = await call('POST', '/api/contact', { body: { name: 'Мария', email: 'maria@example.com', message: 'Здравствуйте, хочу подключить тариф.', website: '' } });
  assert.equal(ok.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_messages').get().n, before + 1);
});

test('Resend: запрос уходит по HTTPS-API с ключом, ошибка не раскрывает ключ', async () => {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(seen.length === 1 ? 200 : 403, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}');
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  try {
    const cfg = { isProd: false, mail: { transport: 'resend', from: 'AutoFlow <no-reply@autoflow.kz>', resendKey: 're_TEST_SECRET',
      resendUrl: `http://127.0.0.1:${fake.address().port}/emails` } };
    const mailer = createMailer(cfg);
    await mailer.send({ to: 'client@example.com', subject: 'Тема', text: 'Текст', html: '<b>Текст</b>', replyTo: 'a@b.kz' });
    assert.equal(seen[0].auth, 'Bearer re_TEST_SECRET');
    assert.deepEqual(seen[0].body.to, ['client@example.com']);
    assert.equal(seen[0].body.from, 'AutoFlow <no-reply@autoflow.kz>');
    assert.equal(seen[0].body.reply_to, 'a@b.kz');
    await assert.rejects(() => mailer.send({ to: 'client@example.com', subject: 'Тема', text: 'Текст' }), (e) => /403/.test(e.message) && !e.message.includes('re_TEST_SECRET'));
    const noKey = createMailer({ isProd: false, mail: { ...cfg.mail, resendKey: '' } });
    await assert.rejects(() => noKey.send({ to: 'client@example.com', subject: 's', text: 't' }), /RESEND_API_KEY/);
  } finally { fake.close(); }
});

test('production без APP_URL не запускается (иначе ссылки в письмах вели бы на localhost)', () => {
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try { assert.throws(() => loadConfig({}), /APP_URL/); assert.doesNotThrow(() => loadConfig({ appUrl: 'https://autoflow.kz' })); }
  finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});
