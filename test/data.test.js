import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { LIMITS } from '../src/data.js';

process.env.LOG_REQUESTS = '0';
let app, db, base;

before(async () => {
  const config = loadConfig({
    dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' },
    limits: { regPerHour: 1000, loginPerIp10Min: 1000, globalPerMin: 100000, writesPerMin: 100000 },
  });
  db = openDb(':memory:');
  app = createApp({ config, db });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function call(method, path, { body, cookie, csrf } = {}) {
  const h = { Origin: base };
  if (body !== undefined || method !== 'GET') h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  const sc = r.headers.get('set-cookie');
  return { status: r.status, json, cookie: sc ? sc.split(';')[0] : null };
}
let n = 0;
async function newUser() {
  n++;
  const r = await call('POST', '/api/register', { body: { name: 'Иван Петров', email: `u${n}@example.com`, phone: '+7 700 123 45 67', password: 'Secret123' } });
  assert.equal(r.status, 201);
  // id в ответе API публичный (случайная строка), внутренний номер в базе наружу не отдаётся
  const dbId = db.prepare('SELECT id FROM users WHERE public_id = ?').get(r.json.user.id).id;
  const user = { cookie: r.cookie, csrf: r.json.csrf, id: dbId };
  user.api = (method, path, body) => call(method, path, { body, cookie: user.cookie, csrf: user.csrf });
  return user;
}
// Выдать платный тариф напрямую в БД (в тестах оплату не проходим)
const upgrade = (u, plan = 'pro') => db.prepare(`INSERT INTO subscriptions (user_id, plan, period_end, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, period_end = excluded.period_end`).run(u.id, plan, Date.now() + 30 * 86400000, Date.now());
const dash = async (u) => (await u.api('GET', '/api/dashboard')).json.dashboard;

test('новый аккаунт получает набор образцов, без чужих данных', async () => {
  const a = await newUser();
  const d = await dash(a);
  assert.ok(d.tasks.length >= 8 && d.autos.length === 4 && d.notes.length === 3 && d.feed.length === 3);
  assert.deepEqual(d.runs, { ok: 49, total: 50 });
  assert.equal(d.week.length, 7);
  assert.ok(d.tasks.every(t => typeof t.id === 'string'), 'id приходят строками');
  const b = await newUser();
  const ids = new Set((await dash(b)).tasks.map(t => t.id));
  assert.ok(d.tasks.every(t => !ids.has(t.id)), 'у каждого пользователя свои записи');
});

test('без сессии и без CSRF-токена данные недоступны', async () => {
  assert.equal((await call('GET', '/api/dashboard')).status, 401);
  assert.equal((await call('POST', '/api/tasks', { body: { title: 'x' } })).status, 401);
  const a = await newUser();
  const noCsrf = await call('POST', '/api/tasks', { body: { title: 'Без токена' }, cookie: a.cookie });
  assert.equal(noCsrf.status, 403);
  assert.equal((await dash(a)).tasks.some(t => t.title === 'Без токена'), false);
});

test('ИЗОЛЯЦИЯ: пользователь Б не видит, не меняет и не удаляет данные пользователя А (по подбору id)', async () => {
  const a = await newUser(), b = await newUser();
  const da = await dash(a);
  const taskId = da.tasks.find(t => !t.done).id, autoId = da.autos[0].id, noteId = da.notes[0].id;

  // Б не получает чужие записи в списках
  const db_ = await dash(b);
  for (const t of da.tasks) assert.ok(!db_.tasks.some(x => x.id === t.id));

  // Любая попытка трогать чужое = 404 (как будто записи нет)
  const attempts = [
    ['PATCH', `/api/tasks/${taskId}`, { done: true }], ['DELETE', `/api/tasks/${taskId}`],
    ['PATCH', `/api/automations/${autoId}`, { enabled: false }], ['DELETE', `/api/automations/${autoId}`],
    ['POST', `/api/automations/${autoId}/run`], ['PATCH', `/api/notifications/${noteId}`, { read: true }],
  ];
  for (const [m, p, body] of attempts) assert.equal((await b.api(m, p, body)).status, 404, `${m} ${p}`);

  // Подмена владельца в теле запроса не работает (mass assignment)
  const evil = await b.api('POST', '/api/tasks', { title: 'Моя задача', user_id: a.id, userId: a.id, id: 1, done: true });
  assert.equal(evil.status, 200);
  assert.ok((await dash(a)).tasks.every(t => t.title !== 'Моя задача'), 'задача не попала к А');
  assert.ok((await dash(b)).tasks.some(t => t.title === 'Моя задача' && !t.done));

  // Перебор id подряд: ни одна чужая запись не меняется
  for (let id = 1; id <= 80; id++) {
    const r = await b.api('DELETE', `/api/tasks/${id}`);
    assert.ok([200, 404].includes(r.status));
  }
  const aAfter = await dash(a);
  assert.equal(aAfter.tasks.length, da.tasks.length, 'у А ничего не пропало');
  assert.equal(aAfter.autos.length, da.autos.length);
  assert.equal(aAfter.notes.length, da.notes.length);
});

test('ИЗОЛЯЦИЯ: массовые операции затрагивают только своего пользователя', async () => {
  const a = await newUser(), b = await newUser();
  const beforeNotes = (await dash(a)).notes.length;
  await b.api('DELETE', '/api/notifications');
  await b.api('POST', '/api/notifications/read-all');
  await b.api('POST', '/api/demo/reset');
  const after = await dash(a);
  assert.equal(after.notes.length, beforeNotes);
  assert.ok(after.notes.some(x => !x.read), 'непрочитанные у А остались');
  assert.equal((await dash(b)).notes.length, 3, 'у Б после сброса снова образцы');
});

test('задачи: создание, выполнение, повторное выполнение не дублирует события, удаление', async () => {
  const u = await newUser();
  let r = await u.api('POST', '/api/tasks', { title: '  Купить   молоко ', prio: 'high', due: '2030-05-17' });
  assert.equal(r.status, 200);
  const t = r.json.dashboard.tasks.find(x => x.title === 'Купить молоко');
  assert.equal(t.prio, 'high'); assert.equal(t.due, '2030-05-17'); assert.equal(t.done, false);

  const feedBefore = (await dash(u)).feed.length;
  const weekBefore = (await dash(u)).week.reduce((a, b) => a + b, 0);
  r = await u.api('PATCH', `/api/tasks/${t.id}`, { done: true });
  assert.equal(r.json.dashboard.tasks.find(x => x.id === t.id).done, true);
  assert.equal(r.json.dashboard.week.reduce((a, b) => a + b, 0), weekBefore + 1, 'в график недели попала выполненная задача');
  const feedAfter = r.json.dashboard.feed.length;
  assert.ok(feedAfter > feedBefore);
  r = await u.api('PATCH', `/api/tasks/${t.id}`, { done: true });
  assert.equal(r.json.dashboard.feed.length, feedAfter, 'повтор ничего не добавляет');

  r = await u.api('PATCH', `/api/tasks/${t.id}`, { done: false });
  assert.equal(r.json.dashboard.tasks.find(x => x.id === t.id).done, false);
  assert.equal((await u.api('DELETE', `/api/tasks/${t.id}`)).status, 200);
  assert.equal((await u.api('DELETE', `/api/tasks/${t.id}`)).status, 404, 'повторное удаление = 404');
});

test('проверка входных данных: типы, длина, формат, перечисления', async () => {
  const u = await newUser();
  const bad = [
    {}, { title: '' }, { title: '   ' }, { title: 123 }, { title: ['a'] }, { title: { a: 1 } }, { title: null }, { title: 'x'.repeat(121) },
    { title: 'ok', prio: 'urgent' }, { title: 'ok', prio: 5 }, { title: 'ok', due: '2030-13-45' }, { title: 'ok', due: '30-01-2030' },
    { title: 'ok', due: '2030-02-30' }, { title: 'ok', due: 20300101 }, { title: 'ok', due: '1999-01-01' },
  ];
  for (const body of bad) {
    const r = await u.api('POST', '/api/tasks', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.json.fields, 'есть подсказка по полю');
  }
  assert.equal((await u.api('PATCH', '/api/tasks/1', { done: 'yes' })).status, 400);
  const id = (await dash(u)).tasks[0].id;
  for (const done of ['true', 1, null, undefined]) assert.equal((await u.api('PATCH', `/api/tasks/${id}`, { done })).status, 400);

  const autoBad = [
    { name: 'ab', trigger: 'Задача выполнена', action: 'Создать задачу' },
    { name: 'Нормально', trigger: 'Что угодно', action: 'Создать задачу' },
    { name: 'Нормально', trigger: 'Задача выполнена', action: 'rm -rf /' },
    { name: ['Нормально'], trigger: 'Задача выполнена', action: 'Создать задачу' },
    { name: 'x'.repeat(61), trigger: 'Задача выполнена', action: 'Создать задачу' },
  ];
  for (const body of autoBad) assert.equal((await u.api('POST', '/api/automations', body)).status, 400, JSON.stringify(body));
  assert.equal((await u.api('PATCH', '/api/prefs', {})).status, 400);
  assert.equal((await u.api('PATCH', '/api/prefs', { tg: 'да' })).status, 400);
});

test('необычные адреса: нечисловые и огромные id, чужие методы', async () => {
  const u = await newUser();
  for (const p of ['/api/tasks/abc', '/api/tasks/-1', '/api/tasks/1.5', '/api/tasks/99999999999999999999', '/api/tasks/1%20OR%201=1', '/api/tasks/../automations']) {
    const r = await u.api('DELETE', p);
    assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await u.api('PUT', '/api/tasks/1', { done: true })).status, 404);
  assert.equal((await u.api('GET', '/api/tasks')).status, 404);
});

test('автоматизации срабатывают на события, действия не зацикливаются', async () => {
  const u = await newUser();
  upgrade(u);
  // правило: на «Новая задача создана» создавать задачу. Если бы действия порождали события, был бы бесконечный цикл
  let r = await u.api('POST', '/api/automations', { name: 'Копия задачи', trigger: 'Новая задача создана', action: 'Создать задачу' });
  const rule = r.json.dashboard.autos.find(a => a.name === 'Копия задачи');
  assert.equal(rule.on, true); assert.equal(rule.runs, 0);
  const before = (await dash(u)).tasks.length;
  r = await u.api('POST', '/api/tasks', { title: 'Триггер' });
  const d = r.json.dashboard;
  assert.equal(d.tasks.length, before + 2, 'создана своя задача и одна от правила (без цикла)');
  assert.ok(d.tasks.some(t => t.title === 'Задача от «Копия задачи»'));
  assert.equal(d.autos.find(a => a.id === rule.id).runs, 1);
  assert.equal(d.runs.total, 50 + 2, 'счётчик запусков: образцовое правило «Уведомлять о новых» тоже сработало');

  // выключенное правило не срабатывает
  await u.api('PATCH', `/api/automations/${rule.id}`, { enabled: false });
  const n1 = (await dash(u)).tasks.length;
  await u.api('POST', '/api/tasks', { title: 'Без правила' });
  assert.equal((await dash(u)).tasks.length, n1 + 1);
  // ручной запуск работает и у выключенного
  r = await u.api('POST', `/api/automations/${rule.id}/run`);
  assert.equal(r.status, 200); assert.equal(r.json.name, 'Копия задачи');
  assert.equal(r.json.dashboard.autos.find(a => a.id === rule.id).runs, 2);
});

test('настройки: предпочтения сохраняются, тест Telegram без подключения невозможен', async () => {
  const u = await newUser();
  assert.equal((await u.api('POST', '/api/telegram/test')).status, 409, 'без подключённого чата тест невозможен');
  let r = await u.api('PATCH', '/api/prefs', { email: true });
  assert.deepEqual(r.json.dashboard.prefs, { tg: true, email: true });
  r = await u.api('PATCH', '/api/prefs', { tg: false });
  assert.deepEqual(r.json.dashboard.prefs, { tg: false, email: true });
  assert.equal((await dash(u)).tg.on, false);
});

test('уведомления: прочитать, прочитать все, очистить', async () => {
  const u = await newUser();
  let d = await dash(u);
  const unread = d.notes.find(x => !x.read);
  let r = await u.api('PATCH', `/api/notifications/${unread.id}`, { read: true });
  assert.equal(r.json.dashboard.notes.find(x => x.id === unread.id).read, true);
  r = await u.api('POST', '/api/notifications/read-all');
  assert.ok(r.json.dashboard.notes.every(x => x.read));
  r = await u.api('DELETE', '/api/notifications');
  assert.equal(r.json.dashboard.notes.length, 0);
});

test('лимиты: задач не больше предела, журнал и уведомления не растут бесконечно', async () => {
  const u = await newUser();
  const have = (await dash(u)).tasks.length;
  // заполняем базу напрямую, чтобы не делать тысячу запросов
  const ins = db.prepare("INSERT INTO tasks (user_id, title, prio, done, created_at) VALUES (?, 'x', 'mid', 0, ?)");
  db.exec('BEGIN');
  try { for (let i = have; i < LIMITS.tasks; i++) ins.run(u.id, Date.now() + i); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  const r = await u.api('POST', '/api/tasks', { title: 'Лишняя' });
  assert.equal(r.status, 409); assert.equal(r.json.error, 'limit_reached');

  // уведомления и журнал обрезаются
  const u2 = await newUser();
  await u2.api('POST', '/api/tasks', { title: 'a' });
  for (let i = 0; i < 130; i++) await u2.api('POST', '/api/telegram/test').catch(() => {});
  await u2.api('POST', '/api/telegram/connect');
  for (let i = 0; i < 130; i++) await u2.api('POST', '/api/telegram/test');
  const notes = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(u2.id).c;
  const feed = db.prepare('SELECT COUNT(*) AS c FROM activity WHERE user_id = ?').get(u2.id).c;
  assert.ok(notes <= LIMITS.notes, `уведомлений: ${notes}`);
  assert.ok(feed <= LIMITS.feed, `записей журнала: ${feed}`);
});

test('лимит частоты записи на пользователя', async () => {
  const cfg = loadConfig({ dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' },
    limits: { regPerHour: 1000, globalPerMin: 100000, writesPerMin: 5 } });
  const dbx = openDb(':memory:'); const x = createApp({ config: cfg, db: dbx });
  await new Promise(r => x.server.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${x.server.address().port}`;
  try {
    const reg = await fetch(b + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b },
      body: JSON.stringify({ name: 'Иван Петров', email: 'rl@example.com', phone: '+7 700 123 45 67', password: 'Secret123' }) });
    const cookie = reg.headers.get('set-cookie').split(';')[0]; const csrf = (await reg.json()).csrf;
    let last;
    for (let i = 0; i < 8; i++) {
      last = await fetch(b + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b, Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ title: 't' + i }) });
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally { x.server.closeAllConnections?.(); x.server.close(); }
});

test('удаление аккаунта удаляет все его данные, у других ничего не пропадает', async () => {
  const a = await newUser(), b = await newUser();
  await dash(a); await dash(b);
  const count = (table, uid) => db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE user_id = ?`).get(uid).c;
  assert.ok(count('tasks', a.id) > 0 && count('automations', a.id) > 0);
  const del = await a.api('DELETE', '/api/me', { password: 'Secret123' });
  assert.equal(del.status, 200);
  for (const t of ['tasks', 'automations', 'notifications', 'activity', 'user_state', 'sessions']) assert.equal(count(t, a.id), 0, t);
  assert.ok(count('tasks', b.id) > 0, 'данные другого пользователя целы');
});

test('смена пароля попадает в журнал, XSS-строки хранятся как текст', async () => {
  const u = await newUser();
  const xss = '<img src=x onerror=alert(1)>';
  const r = await u.api('POST', '/api/tasks', { title: xss });
  assert.ok(r.json.dashboard.tasks.some(t => t.title === xss), 'сервер хранит текст как есть, экранирует клиент');
  const ch = await u.api('POST', '/api/change-password', { current: 'Secret123', password: 'NewSecret456' });
  assert.equal(ch.status, 200);
  assert.ok((await dash(u)).feed.some(f => f.text === 'Пароль изменён'));
});
