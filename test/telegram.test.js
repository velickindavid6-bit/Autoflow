import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createTelegram } from '../src/telegram.js';

process.env.LOG_REQUESTS = '0';
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawX';   // выдуманный токен нужного формата, только для тестов

/* ---------- Поддельный сервер Telegram ---------- */
const fake = { calls: [], updates: [], behavior: {}, server: null, url: '', nextId: 1 };
function startFake({ token = TOKEN, getMe = null } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''; req.on('data', d => body += d);
      req.on('end', async () => {
        const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!m || m[1] !== token) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
        const method = m[2], params = body ? JSON.parse(body) : {};
        if (method === 'getMe') return getMe ? getMe(send) : send(200, { ok: true, result: { id: 1, is_bot: true, username: 'autoflow_test_bot' } });
        if (method === 'getUpdates') {
          if (!fake.updates.length) await new Promise(r => setTimeout(r, Math.min(300, (params.timeout || 0) * 1000)));
          return send(200, { ok: true, result: fake.updates.splice(0) });
        }
        fake.calls.push({ method, ...params });
        const forced = fake.behavior[method];
        if (forced && forced.times > 0) { forced.times--; return send(forced.code, { ok: false, error_code: forced.code, description: forced.description || 'error', parameters: forced.retry ? { retry_after: forced.retry } : undefined }); }
        return send(200, { ok: true, result: { message_id: fake.nextId++ } });
      });
    });
    server.listen(0, '127.0.0.1', () => { fake.server = server; fake.url = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
}
const reset = () => { fake.calls.length = 0; fake.updates.length = 0; fake.behavior = {}; };
const sent = (chatId) => fake.calls.filter(c => c.method === 'sendMessage' && (chatId === undefined || c.chat_id === chatId));
const lastText = (chatId) => sent(chatId).at(-1)?.text;

/* ---------- Приложение ---------- */
let app, db, base, now = 0;
const cfgFor = (extra = {}) => loadConfig({
  dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' },
  telegram: { token: TOKEN, apiBase: fake.url, poll: false },
  limits: { regPerHour: 1000, loginPerIp10Min: 1000, globalPerMin: 100000, writesPerMin: 100000, tgLinkPerHour: 1000, tgChatPerMin: 1000, ...extra },
});

before(async () => {
  await startFake();
  db = openDb(':memory:');
  app = createApp({ config: cfgFor(), db });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(await app.telegram.init(), true);
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); fake.server.close(); });

async function call(method, path, { body, cookie, csrf } = {}) {
  const h = { Origin: base, 'Content-Type': 'application/json' };
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  const sc = r.headers.get('set-cookie');
  return { status: r.status, json, cookie: sc ? sc.split(';')[0] : null };
}
let n = 0, chatSeq = 1000;
async function newUser() {
  n++;
  const r = await call('POST', '/api/register', { body: { name: 'Иван Петров', email: `tg${n}@example.com`, phone: '+7 700 123 45 67', password: 'Secret123' } });
  const dbId = db.prepare('SELECT id FROM users WHERE public_id = ?').get(r.json.user.id).id;
  const u = { cookie: r.cookie, csrf: r.json.csrf, id: dbId };
  u.api = (m, p, b) => call(m, p, { body: b, cookie: u.cookie, csrf: u.csrf });
  return u;
}
const upgrade = (u, plan = 'pro', database = db) => database.prepare(`INSERT INTO subscriptions (user_id, plan, period_end, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, period_end = excluded.period_end`).run(u.id, plan, Date.now() + 30 * 86400000, Date.now());
const dash = async (u) => (await u.api('GET', '/api/dashboard')).json.dashboard;

// Сообщения «от пользователя Telegram»
const msg = (chatId, text, extra = {}) => ({ update_id: ++now, message: { message_id: now, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, username: `user${chatId}` }, text, ...extra } });
const say = (chatId, text) => app.telegram.handleUpdate(msg(chatId, text));
const press = (chatId, data, messageId = 777) => app.telegram.handleUpdate({ update_id: ++now, callback_query: { id: `cb${now}`, from: { id: chatId, is_bot: false, username: `user${chatId}` }, message: { message_id: messageId, chat: { id: chatId, type: 'private' } }, data } });

// Полная привязка: кабинет → ссылка → /start → «Да»
async function link(user, chatId = ++chatSeq) {
  const r = await user.api('POST', '/api/telegram/connect');
  assert.equal(r.status, 200, 'connect');
  const code = r.json.pending.code;
  await say(chatId, `/start ${code}`);
  await press(chatId, `lk:y:${code}`);
  return { chatId, code };
}

test('запуск: имя бота получено, неверный формат токена и отклонённый токен выключают бота без утечки токена', async () => {
  assert.equal(app.telegram.isEnabled(), true);
  assert.equal(app.telegram.botName(), 'autoflow_test_bot');

  const logs = [];
  const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const mk = (token, apiBase = fake.url) => createTelegram({ db, config: { ...cfgFor(), telegram: { token, apiBase, poll: false, codeMinutes: 10 } }, data: null, limiter: app.limiter, logger });

  assert.equal(await mk('это-не-токен').init(), false);
  assert.equal(await mk('').init(), false);
  const wrong = '987654321:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ';
  assert.equal(await mk(wrong).init(), false, 'Telegram ответил 401');
  assert.equal(await mk(TOKEN, 'http://127.0.0.1:1').init(), false, 'нет связи');
  const all = logs.join('\n');
  assert.ok(!all.includes(wrong) && !all.includes(TOKEN) && !all.includes('AAHdqTc'), 'токен не попадает в лог');
  assert.ok(logs.length >= 3);
});

test('API: подключение требует сессию и CSRF, выдаёт ссылку; в БД только хеш кода', async () => {
  assert.equal((await call('POST', '/api/telegram/connect')).status, 401);
  const u = await newUser();
  assert.equal((await call('POST', '/api/telegram/connect', { cookie: u.cookie })).status, 403, 'без CSRF');
  const r = await u.api('POST', '/api/telegram/connect');
  assert.equal(r.status, 200);
  const { code, link: url, expiresAt } = r.json.pending;
  assert.equal(url, `https://t.me/autoflow_test_bot?start=${code}`);
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 10 * 60000 + 1000);
  assert.deepEqual(r.json.dashboard.tg, { configured: true, bot: 'autoflow_test_bot', on: false, username: '', since: 0 });

  const rows = db.prepare('SELECT code_hash FROM telegram_codes WHERE user_id = ?').all(u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, crypto.createHash('sha256').update(code).digest('hex'));
  assert.ok(rows[0].code_hash !== code);

  // новая ссылка отменяет прежнюю
  const r2 = await u.api('POST', '/api/telegram/connect');
  assert.notEqual(r2.json.pending.code, code);
  reset(); await say(5001, `/start ${code}`);
  assert.match(lastText(5001), /недействительна|устарела/);
});

test('привязка: нужно подтверждение «Да» в Telegram; без него чат не привязывается', async () => {
  reset();
  const u = await newUser();
  const { json } = await u.api('POST', '/api/telegram/connect');
  const code = json.pending.code, chatId = ++chatSeq;
  await say(chatId, `/start ${code}`);
  const ask = sent(chatId).at(-1);
  assert.match(ask.text, /Подключить этот чат к аккаунту Иван \(t\*\*\*@example\.com\)\?/, 'показан замаскированный email');
  assert.ok(!ask.text.includes(`tg${n}@`), 'полный email не раскрывается');
  const kb = ask.reply_markup.inline_keyboard[0];
  assert.deepEqual(kb.map(b => b.callback_data), [`lk:y:${code}`, `lk:n:${code}`]);
  assert.equal((await dash(u)).tg.on, false, 'до подтверждения аккаунт не привязан');

  await press(chatId, `lk:y:${code}`);
  const d = await dash(u);
  assert.equal(d.tg.on, true); assert.equal(d.tg.username, `user${chatId}`);
  assert.ok(d.feed.some(f => f.text === 'Telegram-бот подключён'));
  assert.ok(d.notes.some(x => x.type === 'tg'));
  assert.match(lastText(chatId), /Готово/);

  // код одноразовый
  reset();
  const other = ++chatSeq;
  await say(other, `/start ${code}`);
  assert.match(lastText(other), /недействительна|устарела/);
  await press(other, `lk:y:${code}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_links WHERE chat_id = ?').get(other).c, 0, 'использованный код не привязывает второй чат');
});

test('привязка: «Нет» сжигает код; просроченный код не работает; мусорный код отклоняется', async () => {
  const u = await newUser();
  let { json } = await u.api('POST', '/api/telegram/connect');
  let code = json.pending.code, chat = ++chatSeq;
  await say(chat, `/start ${code}`); await press(chat, `lk:n:${code}`);
  await press(chat, `lk:y:${code}`);
  assert.equal((await dash(u)).tg.on, false, 'после «Нет» код мёртв');

  ({ json } = await u.api('POST', '/api/telegram/connect'));
  code = json.pending.code;
  db.prepare('UPDATE telegram_codes SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, u.id);
  reset(); await say(chat, `/start ${code}`);
  assert.match(lastText(chat), /недействительна|устарела/);
  await press(chat, `lk:y:${code}`);
  assert.equal((await dash(u)).tg.on, false);

  for (const junk of ['abc', 'x'.repeat(200), "' OR 1=1 --", '../../etc/passwd']) {
    reset(); await say(chat, `/start ${junk}`);
    assert.match(lastText(chat), /недействительна|устарела/, junk);
  }
});

test('защита от угона: один Telegram-чат = один аккаунт', async () => {
  const a = await newUser(), b = await newUser();
  const { chatId } = await link(a);
  const { json } = await b.api('POST', '/api/telegram/connect');
  reset(); await say(chatId, `/start ${json.pending.code}`);
  assert.match(lastText(chatId), /уже привязан к другому аккаунту/);
  await press(chatId, `lk:y:${json.pending.code}`);
  assert.equal((await dash(b)).tg.on, false, 'чужой чат не привязался ко второму аккаунту');
  // после /stop чат свободен
  await say(chatId, '/stop');
  assert.equal((await dash(a)).tg.on, false);
  await press(chatId, `lk:y:${json.pending.code}`);
  assert.equal((await dash(b)).tg.on, true);
});

test('чат без привязки ничего не может: команды и кнопки не работают', async () => {
  reset();
  const victim = await newUser();
  const before = (await dash(victim)).tasks;
  const stranger = ++chatSeq;
  for (const cmd of ['/tasks', '/add Взломанная задача', '/stop', 'привет', '/unknown']) {
    await say(stranger, cmd);
    assert.ok(sent(stranger).at(-1), cmd);
  }
  await say(stranger, '/tasks'); assert.match(lastText(stranger), /не подключён/);
  await say(stranger, '/add Взломанная задача'); assert.match(lastText(stranger), /не подключён/);
  await press(stranger, `done:${db.prepare('SELECT id FROM tasks WHERE user_id = ? LIMIT 1').get(victim.id).id}`);
  const after = (await dash(victim)).tasks;
  assert.deepEqual(after.map(t => [t.id, t.done]), before.map(t => [t.id, t.done]), 'задачи не изменились');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE title = 'Взломанная задача'").get().c, 0);
});

test('команды: /add создаёт задачу и запускает правила, /tasks со списком и кнопками, ✅ отмечает выполненной', async () => {
  const u = await newUser();
  upgrade(u);
  const { chatId } = await link(u);
  await u.api('POST', '/api/automations', { name: 'Эхо в бот', trigger: 'Новая задача создана', action: 'Отправить уведомление в Telegram' });
  reset();

  await say(chatId, '/add   Купить   молоко ');
  assert.match(lastText(chatId), /Задача добавлена: Купить молоко/);
  const d = await dash(u);
  const t = d.tasks.find(x => x.title === 'Купить молоко');
  assert.ok(t && !t.done);
  assert.ok(d.autos.find(a => a.name === 'Эхо в бот').runs >= 1, 'правило сработало от задачи из Telegram');

  await say(chatId, '/tasks');
  const list = sent(chatId).at(-1);
  assert.match(list.text, /Активные задачи/); assert.ok(list.text.includes('Купить молоко'));
  const btn = list.reply_markup.inline_keyboard.flat().find(b => b.callback_data === `done:${t.id}`);
  assert.ok(btn && btn.text.startsWith('✅'));

  await press(chatId, btn.callback_data, 555);
  assert.equal((await dash(u)).tasks.find(x => x.id === t.id).done, true);
  const edit = fake.calls.filter(c => c.method === 'editMessageText').at(-1);
  assert.equal(edit.message_id, 555); assert.ok(!edit.text.includes('Купить молоко'), 'список обновился');
  assert.ok(fake.calls.some(c => c.method === 'answerCallbackQuery' && c.text === 'Готово ✅'));

  // валидация
  await say(chatId, '/add'); assert.match(lastText(chatId), /Напишите текст/);
  await say(chatId, '/add ' + 'я'.repeat(300)); assert.match(lastText(chatId), /максимум 120/);
  await say(chatId, '/help'); assert.match(lastText(chatId), /\/tasks/);
  await say(chatId, 'просто текст'); assert.match(lastText(chatId), /\/add текст/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND title LIKE 'яяя%'").get(u.id).c, 0);
});

test('ИЗОЛЯЦИЯ: кнопка ✅ не позволяет трогать задачи другого аккаунта', async () => {
  const a = await newUser(), b = await newUser();
  const { chatId } = await link(a);
  await link(b);
  const foreign = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND done = 0 LIMIT 1').get(b.id).id;
  reset();
  await press(chatId, `done:${foreign}`);
  assert.equal(db.prepare('SELECT done FROM tasks WHERE id = ?').get(foreign).done, 0, 'чужая задача не изменилась');
  assert.ok(fake.calls.some(c => c.method === 'answerCallbackQuery' && c.text === 'Задача не найдена'));
  // перебор номеров
  for (let id = 1; id < 60; id++) await press(chatId, `done:${id}`);
  const bDone = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND done = 1').get(b.id).c;
  assert.equal(bDone, 6, 'у Б выполненными остались только образцы (6)');
});

test('чужие источники игнорируются: группы, боты, чужой callback, слишком длинные данные', async () => {
  reset();
  const u = await newUser();
  const { chatId } = await link(u);
  reset();
  await app.telegram.handleUpdate({ update_id: ++now, message: { message_id: 1, chat: { id: -100500, type: 'group' }, from: { id: 42, is_bot: false }, text: '/tasks' } });
  await app.telegram.handleUpdate({ update_id: ++now, message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: true }, text: '/tasks' } });
  await app.telegram.handleUpdate({ update_id: ++now, message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, photo: [] } });
  await app.telegram.handleUpdate({ update_id: ++now, callback_query: { id: 'x', from: { id: 999, is_bot: false }, message: { message_id: 1, chat: { id: chatId, type: 'private' } }, data: 'done:1' } });
  await app.telegram.handleUpdate({ update_id: ++now, callback_query: { id: 'y', from: { id: chatId, is_bot: false }, message: { message_id: 1, chat: { id: chatId, type: 'private' } }, data: 'done:1' + '0'.repeat(80) } });
  await app.telegram.handleUpdate(null); await app.telegram.handleUpdate({}); await app.telegram.handleUpdate({ message: {} });
  assert.equal(sent().filter(c => c.chat_id === -100500).length, 0, 'в группе бот молчит');
  assert.equal(sent(chatId).length, 1, 'ответ только на «не текст»');
  assert.match(lastText(chatId), /только текст/);
});

test('лимит сообщений в минуту на чат', async () => {
  const cfg = cfgFor({ tgChatPerMin: 3 });
  const db2 = openDb(':memory:');
  const x = createApp({ config: cfg, db: db2 });
  await x.telegram.init();
  reset();
  for (let i = 0; i < 8; i++) await x.telegram.handleUpdate(msg(9001, '/help'));
  assert.equal(sent(9001).length, 3, 'сверх лимита сообщения игнорируются');
  x.server.close();
});

test('уведомления: автоматизация шлёт сообщение в чат через очередь', async () => {
  const u = await newUser();
  upgrade(u);
  const { chatId } = await link(u);
  await u.api('POST', '/api/automations', { name: 'Дубль в Telegram', trigger: 'Задача выполнена', action: 'Отправить уведомление в Telegram' });
  const d0 = await dash(u);
  const task = d0.tasks.find(t => !t.done);
  reset();
  await u.api('PATCH', `/api/tasks/${task.id}`, { done: true });
  assert.equal(sent().length, 0, 'пока сообщение только в очереди');
  assert.ok(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c >= 1);
  await app.telegram.flush();
  const m = sent(chatId).find(c => c.text.includes('Дубль в Telegram'));
  assert.ok(m, 'сообщение доставлено в нужный чат');
  assert.ok(m.text.includes(`Выполнено: «${task.title}»`));
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c, 0, 'очередь очищена');
  assert.ok((await dash(u)).notes.some(x => x.text.includes('Telegram: «Дубль в Telegram» сработала')));

  // тест из настроек
  reset();
  assert.equal((await u.api('POST', '/api/telegram/test')).status, 200);
  await app.telegram.flush();
  assert.match(lastText(chatId), /Тестовое сообщение/);
});

test('уведомления: выключено в настройках или чат не привязан = сообщение не уходит', async () => {
  const u = await newUser();
  upgrade(u);
  await u.api('POST', '/api/automations', { name: 'Тихое правило', trigger: 'Новая задача создана', action: 'Отправить уведомление в Telegram' });
  reset();
  await u.api('POST', '/api/tasks', { title: 'без привязки' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c, 0);
  assert.ok((await dash(u)).notes.some(x => /не подключён/.test(x.text)));

  const { chatId } = await link(u);
  await u.api('PATCH', '/api/prefs', { tg: false });
  await u.api('POST', '/api/tasks', { title: 'при выключенных' });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c, 0, 'настройка «Telegram: выкл» уважается');
  assert.equal((await u.api('POST', '/api/telegram/test')).status, 409);
  await u.api('PATCH', '/api/prefs', { tg: true });
  await u.api('POST', '/api/tasks', { title: 'при включённых' });
  // сработали два правила: образцовое «Уведомлять о новых задачах» и «Тихое правило»
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ? AND chat_id = ?').get(u.id, chatId).c, 2);
});

test('защита чата от потока сообщений: лимит уведомлений за 10 минут', async () => {
  const cfg = cfgFor({ tgMsgPer10Min: 3 });
  const db2 = openDb(':memory:');
  const x = createApp({ config: cfg, db: db2 });
  await new Promise(r => x.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${x.server.address().port}`;
  await x.telegram.init();
  try {
    const post = (p, body, h = {}) => fetch(b2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2, ...h }, body: JSON.stringify(body || {}) });
    const reg = await post('/api/register', { name: 'Иван Петров', email: 'flood@example.com', phone: '+7 700 123 45 67', password: 'Secret123' });
    upgrade({ id: db2.prepare("SELECT id FROM users WHERE email = 'flood@example.com'").get().id }, 'pro', db2);
    const cookie = reg.headers.get('set-cookie').split(';')[0], csrf = (await reg.json()).csrf, h = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const code = (await (await post('/api/telegram/connect', {}, h)).json()).pending.code;
    await x.telegram.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 7001, type: 'private' }, from: { id: 7001, is_bot: false }, text: `/start ${code}` } });
    await x.telegram.handleUpdate({ update_id: 2, callback_query: { id: 'c', from: { id: 7001, is_bot: false }, message: { message_id: 1, chat: { id: 7001, type: 'private' } }, data: `lk:y:${code}` } });
    await post('/api/automations', { name: 'Поток', trigger: 'Новая задача создана', action: 'Отправить уведомление в Telegram' }, h);
    for (let i = 0; i < 10; i++) await post('/api/tasks', { title: 'задача ' + i }, h);
    assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM telegram_outbox').get().c, 3, 'в очередь попало не больше лимита');
  } finally { x.server.closeAllConnections?.(); x.server.close(); }
});

test('отправка: бота заблокировали (403) = чат отвязывается; 429 = откладывается; сбой = повтор и отказ после 5 попыток', async () => {
  const u = await newUser();
  const { chatId } = await link(u);
  db.prepare('DELETE FROM telegram_outbox').run();      // очередь чистая: в ней нет сообщений из предыдущих тестов
  const enqueue = (text) => db.prepare('INSERT INTO telegram_outbox (user_id, chat_id, text, next_at, created_at) VALUES (?, ?, ?, ?, ?)').run(u.id, chatId, text, Date.now(), Date.now());

  // 429: сообщение остаётся в очереди и откладывается
  reset(); enqueue('первое'); fake.behavior.sendMessage = { code: 429, times: 1, retry: 3 };
  assert.equal(await app.telegram.flush(), 0);
  const row = db.prepare('SELECT next_at FROM telegram_outbox WHERE user_id = ?').get(u.id);
  assert.ok(row.next_at > Date.now() + 2000, 'учтён retry_after');
  assert.equal(await app.telegram.flush(), 0, 'пока рано, ничего не отправляется');
  db.prepare('UPDATE telegram_outbox SET next_at = 0 WHERE user_id = ?').run(u.id);
  assert.equal(await app.telegram.flush(), 1);

  // обычный сбой: увеличиваются попытки, после 5-й сообщение удаляется
  reset(); enqueue('второе'); fake.behavior.sendMessage = { code: 500, times: 99 };
  for (let i = 0; i < 5; i++) { db.prepare('UPDATE telegram_outbox SET next_at = 0 WHERE user_id = ?').run(u.id); await app.telegram.flush(); }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c, 0, 'сообщение не копится вечно');

  // старые сообщения не доставляются
  reset(); enqueue('старое');
  db.prepare('UPDATE telegram_outbox SET created_at = ? WHERE user_id = ?').run(Date.now() - 2 * 3600000, u.id);
  assert.equal(await app.telegram.flush(), 0);
  assert.equal(sent(chatId).length, 0);

  // 403: пользователь заблокировал бота
  reset(); enqueue('третье'); fake.behavior.sendMessage = { code: 403, times: 1, description: 'Forbidden: bot was blocked by the user' };
  await app.telegram.flush();
  assert.equal((await dash(u)).tg.on, false, 'чат отвязан автоматически');
  assert.ok((await dash(u)).feed.some(f => f.text === 'Telegram-бот отключён'));
});

test('отключение из кабинета: чат отвязан, прощальное сообщение отправлено, команды перестают работать', async () => {
  const u = await newUser();
  const { chatId } = await link(u);
  reset();
  const r = await u.api('POST', '/api/telegram/disconnect');
  assert.equal(r.status, 200); assert.equal(r.json.dashboard.tg.on, false);
  await app.telegram.flush();
  assert.match(lastText(chatId), /отключён от AutoFlow/);
  await say(chatId, '/tasks'); assert.match(lastText(chatId), /не подключён/);
  await say(chatId, '/add Должно не пройти');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE title = 'Должно не пройти'").get().c, 0);
  assert.equal((await u.api('POST', '/api/telegram/disconnect')).status, 200, 'повторное отключение безопасно');
});

test('удаление аккаунта удаляет привязку, коды и очередь', async () => {
  const u = await newUser();
  const { chatId } = await link(u);
  await u.api('POST', '/api/telegram/test');
  await u.api('POST', '/api/telegram/connect').catch(() => {});
  const del = await u.api('DELETE', '/api/me', { password: 'Secret123' });
  assert.equal(del.status, 200);
  for (const t of ['telegram_links', 'telegram_codes', 'telegram_outbox']) assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`).get(u.id).c, 0, t);
  reset(); await say(chatId, '/tasks'); assert.match(lastText(chatId), /не подключён/);
});

test('повторное подключение уже подключённого и ограничения частоты', async () => {
  const u = await newUser();
  await link(u);
  assert.equal((await u.api('POST', '/api/telegram/connect')).status, 409, 'уже подключён');
});

test('бот не настроен (нет токена): понятная ошибка вместо ссылки', async () => {
  const cfg = loadConfig({ dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' }, telegram: { token: '', poll: false },
    limits: { regPerHour: 1000, globalPerMin: 100000 } });
  const db2 = openDb(':memory:');
  const x = createApp({ config: cfg, db: db2 });
  await new Promise(r => x.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${x.server.address().port}`;
  try {
    const post = (p, body, h = {}) => fetch(b2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b2, ...h }, body: JSON.stringify(body || {}) });
    const reg = await post('/api/register', { name: 'Иван Петров', email: 'no@example.com', phone: '+7 700 123 45 67', password: 'Secret123' });
    const h = { Cookie: reg.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await reg.json()).csrf };
    assert.equal(await x.telegram.start(), false);
    const r = await post('/api/telegram/connect', {}, h);
    assert.equal(r.status, 503); assert.equal((await r.json()).error, 'bot_not_configured');
    const board = await (await fetch(b2 + '/api/dashboard', { headers: { Cookie: h.Cookie } })).json();
    assert.equal(board.dashboard.tg.configured, false);
  } finally { x.server.closeAllConnections?.(); x.server.close(); }
});

test('фоновый опрос: сообщения обрабатываются, смещение сохраняется, повторов нет', async () => {
  const cfg = loadConfig({ dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' },
    telegram: { token: TOKEN, apiBase: fake.url, poll: true }, limits: { regPerHour: 1000, globalPerMin: 100000 } });
  const db2 = openDb(':memory:');
  const x = createApp({ config: cfg, db: db2 });
  reset();
  assert.equal(await x.telegram.start(), true);
  fake.updates.push(msg(8001, '/help'), msg(8001, '/start'));
  const t0 = Date.now();
  while (sent(8001).length < 2 && Date.now() - t0 < 4000) await new Promise(r => setTimeout(r, 50));
  x.telegram.stop();
  assert.equal(sent(8001).length, 2);
  const off = db2.prepare("SELECT value FROM kv WHERE key = 'tg_offset'").get();
  assert.equal(Number(off.value), now + 1, 'смещение = последний update_id + 1');
  x.server.close();
});
