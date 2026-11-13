import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAuth } from './auth.js';
import { RateLimiter, applySecurityHeaders, verifyPassword } from './security.js';
import { HttpError, clientIp, readJson, sendJson, redirect, sameOrigin } from './http.js';
import { validateRegister, validateProfile, validateContact, checks, cleanEmail } from './validation.js';
import { createMailer, templates } from './mailer.js';
import { createData } from './data.js';
import { createTelegram } from './telegram.js';
import { createBilling } from './billing.js';

const MIN = 60000, HOUR = 3600000;

const PAGES = {
  '/': 'index.html', '/login': 'login.html', '/register': 'register.html', '/dashboard': 'dashboard.html',
  '/forgot-password': 'forgot-password.html', '/reset-password': 'reset-password.html', '/verify-email': 'verify-email.html',
  '/terms': 'terms.html', '/privacy': 'privacy.html', '/checkout': 'checkout.html',
};
const LEGACY = Object.fromEntries(Object.entries(PAGES).filter(([p]) => p !== '/').map(([p, f]) => ['/' + f, p]).concat([['/index.html', '/']]));
const GUEST_ONLY = new Set(['/login', '/register', '/forgot-password']);
const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function createApp({ config, db }) {
  const limiter = new RateLimiter();
  const auth = createAuth({ db, config });
  const mailer = createMailer(config);
  const data = createData(db, config);
  const telegram = createTelegram({ db, config, data, limiter });
  const billing = createBilling({ db, config, data });
  if (config.billing.mode === 'demo') console.warn(config.isProd ? '[billing] ВНИМАНИЕ: PAYMENTS_MODE=demo. Деньги не списываются, платные тарифы выдаются бесплатно.' : '[billing] демо-оплата: деньги не списываются');
  if (config.isProd && config.mail.transport === 'console') console.warn('[warn] MAIL_TRANSPORT=console: письма (подтверждение, сброс пароля) НЕ отправляются. Настройте SMTP.');
  const publicDir = path.resolve(config.publicDir);

  const tooMany = (res, key, windowMs) => {
    const retry = limiter.retryAfter(key, windowMs);
    res.setHeader('Retry-After', String(retry));
    throw new HttpError(429, 'too_many_requests', { retryAfter: retry });
  };

  /* ---------- Письма ---------- */
  // Токен кладём во фрагмент (#): браузер не отправляет его на сервер, он не попадает в логи прокси и заголовок Referer.
  // Адрес берём из настроек, а не из заголовка Host.
  const link = (p, token) => `${config.appUrl}${p}#token=${encodeURIComponent(token)}`;
  const inBackground = (promise) => promise.catch((e) => console.error('[mail]', e.message)); // ответ пользователю не зависит от почтового сервера

  const sendVerification = (user) => {
    const token = auth.issueToken(user.id, 'verify', config.tokens.verifyHours * HOUR);
    return mailer.send({ to: user.email, ...templates.verify({ name: user.name, hours: config.tokens.verifyHours, link: link('/verify-email', token) }) });
  };
  const sendReset = (user) => {
    const token = auth.issueToken(user.id, 'reset', config.tokens.resetMinutes * MIN);
    return mailer.send({ to: user.email, ...templates.reset({ name: user.name, minutes: config.tokens.resetMinutes, link: link('/reset-password', token) }) });
  };

  /* ================= API ================= */
  async function api(req, res, pathname, ip) {
    const method = req.method;
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);

    if (unsafe && !sameOrigin(req)) throw new HttpError(403, 'bad_origin');

    // --- публичные эндпоинты ---
    if (method === 'POST' && pathname === '/api/register') {
      if (limiter.hit(`reg:${ip}`, HOUR) > config.limits.regPerHour) tooMany(res, `reg:${ip}`, HOUR);
      const { value, errors } = validateRegister(await readJson(req));
      if (Object.keys(errors).length) throw new HttpError(400, 'validation', { fields: errors });
      const user = await auth.createUser(value);
      if (!user) throw new HttpError(409, 'email_taken', { fields: { email: 'Этот email уже зарегистрирован' } });
      const csrf = auth.startSession(res, user, req, ip);
      inBackground(sendVerification(user));
      return sendJson(res, 201, { user: auth.toPublic(user), csrf });
    }

    if (method === 'POST' && pathname === '/api/login') {
      if (limiter.hit(`login:ip:${ip}`, 10 * MIN) > config.limits.loginPerIp10Min) tooMany(res, `login:ip:${ip}`, 10 * MIN);
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
      const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
      // блокировка перебора по email — работает и для несуществующих адресов (нет утечки «есть ли аккаунт»)
      const failKey = `login:fail:${email}`;
      if (limiter.count(failKey, 15 * MIN) >= config.limits.loginFailsPerEmail) tooMany(res, failKey, 15 * MIN);
      const user = email && password ? await auth.checkCredentials(email, password) : null;
      if (!user) {
        limiter.hit(failKey, 15 * MIN);
        throw new HttpError(401, 'invalid_credentials');
      }
      limiter.clear(failKey);
      const csrf = auth.startSession(res, user, req, ip); // всегда новый токен сессии
      return sendJson(res, 200, { user: auth.toPublic(user), csrf });
    }

    // Кто я? Для гостя это обычный ответ {user: null}, а не ошибка 401 (так главная страница узнаёт, показывать ли «Личный кабинет»)
    if (method === 'GET' && pathname === '/api/session') {
      const s = auth.getSession(req);
      return sendJson(res, 200, s ? { user: s.user, csrf: s.csrf } : { user: null });
    }

    // Восстановление пароля. Ответ ВСЕГДА одинаковый: нельзя узнать, есть ли такой аккаунт.
    if (method === 'POST' && pathname === '/api/forgot-password') {
      if (limiter.hit(`forgot:ip:${ip}`, HOUR) > config.limits.forgotPerIpHour) tooMany(res, `forgot:ip:${ip}`, HOUR);
      const email = cleanEmail((await readJson(req)).email);
      if (checks.email(email)) throw new HttpError(400, 'validation', { fields: { email: 'Введите корректный email' } });
      const user = limiter.hit(`forgot:email:${email}`, HOUR) <= config.limits.forgotPerEmailHour ? auth.userByEmail(email) : null;
      if (user) inBackground(sendReset(user));
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && (pathname === '/api/reset-password/check' || pathname === '/api/reset-password')) {
      if (limiter.hit(`token:ip:${ip}`, 10 * MIN) > config.limits.tokenPerIp10Min) tooMany(res, `token:ip:${ip}`, 10 * MIN);
      const body = await readJson(req);
      if (pathname.endsWith('/check')) return sendJson(res, 200, { valid: auth.checkToken(body.token, 'reset') });
      const bad = checks.password(body.password);
      if (bad) throw new HttpError(400, 'validation', { fields: { password: bad } });      // слабый пароль не «сжигает» ссылку
      const userId = auth.consumeToken(body.token, 'reset');
      if (!userId) throw new HttpError(400, 'invalid_token');
      await auth.setPassword(userId, body.password);                                        // все сессии завершаются
      auth.markVerified(userId);                                                            // письмо дошло, значит почта настоящая
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/verify-email') {
      if (limiter.hit(`token:ip:${ip}`, 10 * MIN) > config.limits.tokenPerIp10Min) tooMany(res, `token:ip:${ip}`, 10 * MIN);
      const userId = auth.consumeToken((await readJson(req)).token, 'verify');
      if (!userId) throw new HttpError(400, 'invalid_token');
      auth.markVerified(userId);
      return sendJson(res, 200, { ok: true });
    }

    // Форма «Контакты» на главной
    if (method === 'POST' && pathname === '/api/contact') {
      if (limiter.hit(`contact:${ip}`, HOUR) > config.limits.contactPerHour) tooMany(res, `contact:${ip}`, HOUR);
      const body = await readJson(req);
      // Ловушка для ботов: скрытое поле «website» человек не видит и не заполняет. Бота «благодарим» и ничего не сохраняем.
      if (typeof body.website === 'string' && body.website.trim()) return sendJson(res, 201, { ok: true });
      const { value, errors } = validateContact(body);
      if (Object.keys(errors).length) throw new HttpError(400, 'validation', { fields: errors });
      db.prepare('INSERT INTO contact_messages (name, email, message, ip, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(value.name, value.email, value.message, ip, Date.now());
      if (config.mail.contactTo) inBackground(mailer.send({ to: config.mail.contactTo, replyTo: value.email, ...templates.contact(value) }));
      return sendJson(res, 201, { ok: true });
    }

    // --- всё остальное только с сессией ---
    const session = auth.getSession(req);
    if (!session) throw new HttpError(401, 'unauthorized');
    if (unsafe && !auth.csrfOk(req, session)) throw new HttpError(403, 'bad_csrf');

    // Ни один эндпоинт не принимает id пользователя из запроса: «кто я» берётся только из сессии.
    // Будущие ресурсы (задачи и т.д.) читаем строго через `WHERE id = ? AND user_id = <из сессии>`.

    if (method === 'GET' && pathname === '/api/me') {
      return sendJson(res, 200, { user: session.user, csrf: session.csrf });
    }

    if (method === 'PATCH' && pathname === '/api/me') {
      const { value, errors } = validateProfile(await readJson(req));
      if (Object.keys(errors).length) throw new HttpError(400, 'validation', { fields: errors });
      auth.updateProfile(session.userId, value.name, value.phone);
      return sendJson(res, 200, { user: { ...session.user, name: value.name, phone: value.phone } });
    }

    if (method === 'POST' && pathname === '/api/verify-email/send') {
      const key = `vsend:${session.userId}`;
      if (session.user.emailVerified) return sendJson(res, 200, { ok: true, alreadyVerified: true });
      if (limiter.hit(key, HOUR) > config.limits.verifySendPerHour) tooMany(res, key, HOUR);
      inBackground(sendVerification(auth.userById(session.userId)));
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/change-password') {
      const key = `chpw:${session.userId}`;
      if (limiter.hit(key, HOUR) > config.limits.changePwPerHour) tooMany(res, key, HOUR);
      const body = await readJson(req);
      const row = auth.userById(session.userId);
      const ok = typeof body.current === 'string' && await verifyPassword(body.current.slice(0, 128), row.password_hash);
      if (!ok) throw new HttpError(403, 'invalid_password', { fields: { current: 'Неверный текущий пароль' } });
      const bad = checks.password(body.password);
      if (bad) throw new HttpError(400, 'validation', { fields: { password: bad } });
      await auth.setPassword(session.userId, body.password, session.sid);   // текущая сессия остаётся, остальные завершаются
      data.log(session.userId, 'Пароль изменён', 'Остальные устройства вышли из аккаунта', 'ok');
      return sendJson(res, 200, { ok: true });
    }


    /* ---------- Данные кабинета (задачи, автоматизации, уведомления) ---------- */
    // Пользователь определяется только по сессии. Идентификаторы записей из адреса запроса всегда проверяются на принадлежность ему.
    const uid = session.userId;
    const board = (tz) => ({ ...data.dashboard(uid, tz), tg: telegram.status(uid) });   // данные кабинета + состояние Telegram
    const fresh = (tz, extra = {}) => sendJson(res, 200, { dashboard: board(tz), ...extra });
    const tzOf = () => { const n = parseInt(new URL(req.url, 'http://x').searchParams.get('tz'), 10); return Number.isFinite(n) ? n : 0; };
    const idOf = (m) => Number(m[1]);

    let m;
    if (method === 'GET' && pathname === '/api/dashboard') return fresh(tzOf());

    if (unsafe) {
      // общий предел записи на пользователя: защита базы от зацикленного клиента или скрипта
      if (limiter.hit(`write:${uid}`, MIN) > config.limits.writesPerMin) tooMany(res, `write:${uid}`, MIN);
    }

    if (method === 'POST' && pathname === '/api/tasks') { data.createTask(uid, await readJson(req)); return fresh(tzOf()); }
    if ((m = pathname.match(/^\/api\/tasks\/(\d{1,15})$/))) {
      if (method === 'PATCH') { data.setTaskDone(uid, idOf(m), await readJson(req)); return fresh(tzOf()); }
      if (method === 'DELETE') { data.deleteTask(uid, idOf(m)); return fresh(tzOf()); }
    }


    /* ---------- Тарифы и оплата (заглушка) ---------- */
    if (method === 'GET' && pathname === '/api/billing') return sendJson(res, 200, billing.overview(uid));
    if (method === 'POST' && pathname === '/api/billing/checkout') {
      if (limiter.hit(`checkout:${uid}`, HOUR) > config.limits.checkoutPerHour) tooMany(res, `checkout:${uid}`, HOUR);
      return sendJson(res, 200, billing.checkout(uid, await readJson(req)));
    }
    if ((m = pathname.match(/^\/api\/billing\/orders\/([A-Za-z0-9_-]{16,40})(\/pay|\/cancel)?$/))) {
      if (method === 'GET' && !m[2]) return sendJson(res, 200, { order: billing.getOrder(uid, m[1]) });
      if (method === 'POST' && m[2] === '/pay') return sendJson(res, 200, { order: billing.payDemo(uid, m[1]), billing: billing.overview(uid) });
      if (method === 'POST' && m[2] === '/cancel') return sendJson(res, 200, { order: billing.cancelOrder(uid, m[1]) });
    }

    if (method === 'POST' && pathname === '/api/automations') { data.createAuto(uid, await readJson(req)); return fresh(tzOf()); }
    if ((m = pathname.match(/^\/api\/automations\/(\d{1,15})$/))) {
      if (method === 'PATCH') { data.setAutoEnabled(uid, idOf(m), await readJson(req)); return fresh(tzOf()); }
      if (method === 'DELETE') { data.deleteAuto(uid, idOf(m)); return fresh(tzOf()); }
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/automations\/(\d{1,15})\/run$/))) {
      const name = data.runAuto(uid, idOf(m));
      return fresh(tzOf(), { name });
    }

    if (method === 'POST' && pathname === '/api/notifications/read-all') { data.readAllNotes(uid); return fresh(tzOf()); }
    if (method === 'DELETE' && pathname === '/api/notifications') { data.clearNotes(uid); return fresh(tzOf()); }
    if (method === 'PATCH' && (m = pathname.match(/^\/api\/notifications\/(\d{1,15})$/))) { data.setNoteRead(uid, idOf(m), await readJson(req)); return fresh(tzOf()); }

    if (method === 'POST' && pathname === '/api/telegram/connect') {
      if (limiter.hit(`tglink:${uid}`, HOUR) > config.limits.tgLinkPerHour) tooMany(res, `tglink:${uid}`, HOUR);
      const pending = telegram.startLink(uid);
      return fresh(tzOf(), { pending });
    }
    if (method === 'POST' && pathname === '/api/telegram/disconnect') { telegram.unlink(uid); return fresh(tzOf()); }
    if (method === 'POST' && pathname === '/api/telegram/test') { data.testTelegram(uid); return fresh(tzOf()); }
    if (method === 'PATCH' && pathname === '/api/prefs') { data.setPrefs(uid, await readJson(req)); return fresh(tzOf()); }
    if (method === 'POST' && pathname === '/api/demo/reset') {
      if (limiter.hit(`reset-demo:${uid}`, HOUR) > config.limits.resetDemoPerHour) tooMany(res, `reset-demo:${uid}`, HOUR);
      data.resetDemo(uid);
      return fresh(tzOf());
    }

    if (method === 'POST' && pathname === '/api/logout') {
      auth.endSession(res, session.sid);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'DELETE' && pathname === '/api/me') {
      const key = `del:${session.userId}`;
      if (limiter.hit(key, HOUR) > 5) tooMany(res, key, HOUR);
      const body = await readJson(req);
      const row = auth.userById(session.userId);
      const ok = typeof body.password === 'string' && await verifyPassword(body.password.slice(0, 128), row.password_hash);
      if (!ok) throw new HttpError(403, 'invalid_password');
      auth.deleteUser(session.userId);
      auth.endSession(res, null);
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not_found');
  }

  /* ================= Страницы и статика ================= */
  async function sendFile(req, res, file, { page }) {
    const ext = path.extname(file).toLowerCase();
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': page ? 'text/html; charset=utf-8' : (MIME[ext] || 'application/octet-stream'),
      'Content-Length': body.length,
      'Cache-Control': page ? 'no-store' : 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function pages(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    if (LEGACY[pathname]) return redirect(res, LEGACY[pathname], 301);

    const pageName = PAGES[pathname];
    if (pageName) {
      const session = auth.getSession(req);
      // серверная защита страниц: кабинет только для вошедших, вход/регистрация — только для гостей
      if ((pathname === '/dashboard' || pathname === '/checkout') && !session) return redirect(res, '/login');
      if (GUEST_ONLY.has(pathname) && session) return redirect(res, '/dashboard');
      return sendFile(req, res, path.join(publicDir, pageName), { page: true });
    }

    // статика: только файлы из public, только разрешённые расширения, без точек в начале сегментов
    const ext = path.extname(pathname).toLowerCase();
    const segments = pathname.split('/');
    if (!MIME[ext] || segments.some(s => s.startsWith('.')) || pathname.includes('\0') || pathname.includes('\\')) {
      throw new HttpError(404, 'not_found');
    }
    const file = path.resolve(publicDir, '.' + pathname);
    if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'not_found');
    try {
      const st = await fs.stat(file);
      if (!st.isFile()) throw new Error('not file');
    } catch { throw new HttpError(404, 'not_found'); }
    return sendFile(req, res, file, { page: false });
  }

  /* ================= Сервер ================= */
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      applySecurityHeaders(res, config.isProd);
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'bad_request');
      const ip = clientIp(req, config.trustProxy);
      try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
      catch { throw new HttpError(400, 'bad_request'); }

      if (limiter.hit(`all:${ip}`, MIN) > config.limits.globalPerMin) tooMany(res, `all:${ip}`, MIN);

      if (pathname === '/api' || pathname.startsWith('/api/')) await api(req, res, pathname, ip);
      else await pages(req, res, pathname);
    } catch (e) {
      if (!(e instanceof HttpError)) { console.error('[error]', e); e = new HttpError(500, 'server_error'); }
      if (res.headersSent) { res.end(); return; }
      if (pathname.startsWith('/api/') || e.extra) {
        sendJson(res, e.status, { error: e.code, ...(e.extra || {}) });
      } else {
        res.writeHead(e.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(e.status === 404 ? 'Страница не найдена' : 'Ошибка');
      }
    } finally {
      if (process.env.LOG_REQUESTS !== '0') console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;

  return { server, limiter, auth, mailer, telegram, billing, data };
}
