import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { TRIGGERS, ACTIONS, LIMITS } from '../src/data.js';
import { engineBundle } from '../scripts/build-demo.mjs';

process.env.LOG_REQUESTS = '0';

/* ==========================================================
   Один и тот же сценарий выполняется на НАСТОЯЩЕМ сервере (Node + SQLite)
   и на демо-движке (то, что работает в браузере на GitHub Pages).
   Статусы и тела ответов должны совпасть. Так демо не расходится с продуктом.
   ========================================================== */

/* ---------- Клиент настоящего сервера ---------- */
async function realClient() {
  const config = loadConfig({
    dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' }, billing: { mode: 'demo' }, telegram: { token: '', poll: false },
    limits: { regPerHour: 1000, loginPerIp10Min: 1000, globalPerMin: 100000, writesPerMin: 100000, tokenPerIp10Min: 1000, forgotPerIpHour: 1000, contactPerHour: 1000, resetDemoPerHour: 1000, changePwPerHour: 1000 },
  });
  const app = createApp({ config, db: openDb(':memory:') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '', csrf = '';
  return {
    name: 'сервер',
    async call(method, path, body) {
      const headers = { Origin: base, 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      if (csrf) headers['X-CSRF-Token'] = csrf;
      const r = await fetch(base + path, { method, headers, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
      const sc = r.headers.get('set-cookie');
      if (sc) { const v = sc.split(';')[0]; cookie = /=$/.test(v) ? '' : v; }
      const json = await r.json().catch(() => null);
      if (json && json.csrf) csrf = json.csrf;
      if (path === '/api/logout' && r.ok) { cookie = ''; csrf = ''; }
      return { status: r.status, body: json };
    },
    token(kind, email) {                                    // ссылка из письма
      const subject = kind === 'verify' ? 'Подтвердите' : 'Сброс';
      const mail = [...app.mailer.outbox].reverse().find(m => m.to === email && m.subject.includes(subject));
      return mail ? new URLSearchParams(new URL(mail.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get('token') : null;
    },
    close() { app.server.closeAllConnections?.(); app.server.close(); },
  };
}

/* ---------- Клиент демо-движка ---------- */
function demoClient() {
  const sandbox = { crypto: webcrypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(engineBundle(), sandbox);
  const store = new Map();
  const engine = sandbox.AutoFlowDemoEngine.createEngine({
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, crypto: webcrypto, paymentsMode: 'demo',
  });
  return {
    name: 'демо',
    async call(method, path, body) {
      const r = await engine.handle(method, path, body);
      return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) };      // в «родной» мир Node (разные Object.prototype)
    },
    token(kind, email) {
      const mail = engine.inbox().find(m => m.kind === 'mail' && m.to === email && m.subject.includes(kind === 'verify' ? 'Подтвердите' : 'Сброс'));
      return mail ? new URLSearchParams(new URL(mail.link, 'http://x/').hash.slice(1)).get('token') : null;
    },
    close() {},
  };
}

/* ---------- Нормализация: убираем то, что по природе разное (случайные id, время) ---------- */
const TIME_KEYS = new Set(['time', 'created', 'createdAt', 'paidAt', 'expiresAt', 'periodEnd', 'since']);
const MASK_KEYS = new Set(['id', 'csrf', 'code', 'token', 'retryAfter']);
function normalize(v, key) {
  if (Array.isArray(v)) return v.map(x => normalize(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) { if (k === 'tg') continue; o[k] = normalize(v[k], k); }   // состояние Telegram у них намеренно разное (в демо бот «настроен»)
    return o;
  }
  if (MASK_KEYS.has(key)) return `<${key}>`;
  if (TIME_KEYS.has(key)) return v ? '<время>' : v;
  if (typeof v === 'string') return v.replace(/order=[\w-]+/g, 'order=<id>').replace(/\d{4}-\d{2}-\d{2}/g, (d, off, s) => (s.includes('активирован до') ? '<дата>' : d));
  return v;
}

/* ---------- Сценарий ---------- */
const PASS = 'Secret123';
const USER = { name: 'Иван Петров', email: 'ivan@mail.kz', phone: '+7 700 123 45 67', password: PASS };

async function scenario(c) {
  const log = [];
  const step = async (label, method, path, body) => { const r = await c.call(method, path, body); log.push([label, r.status, normalize(r.body)]); return r; };
  const dash = async () => (await c.call('GET', '/api/dashboard')).body.dashboard;

  // 1. Гость
  await step('гость: session', 'GET', '/api/session');
  await step('гость: me', 'GET', '/api/me');
  await step('гость: dashboard', 'GET', '/api/dashboard');
  await step('гость: создать задачу', 'POST', '/api/tasks', { title: 'x' });
  await step('гость: billing', 'GET', '/api/billing');

  // 2. Регистрация
  await step('регистрация: пусто', 'POST', '/api/register', {});
  await step('регистрация: слабый пароль', 'POST', '/api/register', { ...USER, password: '12345678' });
  await step('регистрация: телефон', 'POST', '/api/register', { ...USER, phone: 'abc' });
  await step('регистрация: имя', 'POST', '/api/register', { ...USER, name: '<b>X</b>' });
  await step('регистрация: ок', 'POST', '/api/register', { ...USER, email: '  IVAN@Mail.kz ' });
  await step('регистрация: дубль', 'POST', '/api/register', { ...USER, email: 'ivan@mail.kz' });
  await step('session после входа', 'GET', '/api/session');
  await step('me', 'GET', '/api/me');

  // 3. Профиль и подтверждение email
  await step('профиль: ошибка', 'PATCH', '/api/me', { name: 'Один', phone: '' });
  await step('профиль: ок', 'PATCH', '/api/me', { name: 'Иван  Сидоров', phone: '+7 701 000 11 22' });
  await step('verify/send', 'POST', '/api/verify-email/send', {});
  await step('verify: мусор', 'POST', '/api/verify-email', { token: 'x'.repeat(40) });
  await step('verify: нет токена', 'POST', '/api/verify-email', {});
  const vt = c.token('verify', 'ivan@mail.kz');
  assert.ok(vt, 'письмо с подтверждением получено');
  await step('verify: ок', 'POST', '/api/verify-email', { token: vt });
  await step('verify: повтор', 'POST', '/api/verify-email', { token: vt });
  await step('verify/send уже подтверждён', 'POST', '/api/verify-email/send', {});
  await step('session: подтверждён', 'GET', '/api/session');

  // 4. Кабинет
  await step('dashboard: образцы', 'GET', '/api/dashboard');
  await step('dashboard: tz', 'GET', '/api/dashboard?tz=-300');

  // 5. Задачи
  for (const [i, body] of [{}, { title: '' }, { title: 123 }, { title: 'x'.repeat(121) }, { title: 'ok', prio: 'urgent' }, { title: 'ok', due: '2030-02-30' }, { title: 'ok', due: '1999-01-01' }].entries()) {
    await step(`задача: ошибка ${i}`, 'POST', '/api/tasks', body);
  }
  await step('задача: создать', 'POST', '/api/tasks', { title: '  Купить   молоко ', prio: 'high', due: '2030-05-17' });
  let tasks = (await dash()).tasks;
  const milk = tasks.find(t => t.title === 'Купить молоко');
  await step('задача: выполнить', 'PATCH', `/api/tasks/${milk.id}`, { done: true });
  await step('задача: выполнить повторно', 'PATCH', `/api/tasks/${milk.id}`, { done: true });
  await step('задача: неверное done', 'PATCH', `/api/tasks/${milk.id}`, { done: 'yes' });
  await step('задача: вернуть', 'PATCH', `/api/tasks/${milk.id}`, { done: false });
  await step('задача: удалить', 'DELETE', `/api/tasks/${milk.id}`);
  await step('задача: удалить снова', 'DELETE', `/api/tasks/${milk.id}`);
  for (const p of ['/api/tasks/abc', '/api/tasks/99999999999999999999', '/api/tasks/0']) await step(`задача: адрес ${p}`, 'DELETE', p);
  await step('задачи: метод PUT', 'PUT', '/api/tasks/1', { done: true });
  await step('задачи: GET списка', 'GET', '/api/tasks');

  // 6. Автоматизации и лимит тарифа «Старт»
  for (const [i, body] of [{ name: 'ab', trigger: TRIGGERS[0], action: ACTIONS[0] }, { name: 'Нормально', trigger: 'что угодно', action: ACTIONS[0] }, { name: 'Нормально', trigger: TRIGGERS[0], action: 'rm -rf /' }, { name: ['a'], trigger: TRIGGERS[0], action: ACTIONS[0] }].entries()) {
    await step(`автоматизация: ошибка ${i}`, 'POST', '/api/automations', body);
  }
  await step('автоматизация: лимит «Старт»', 'POST', '/api/automations', { name: 'Четвёртая', trigger: TRIGGERS[1], action: ACTIONS[3] });
  let autos = (await dash()).autos;
  const disabled = autos.find(a => !a.on), enabled = autos.find(a => a.on);
  await step('автоматизация: включить четвёртую', 'PATCH', `/api/automations/${disabled.id}`, { enabled: true });
  await step('автоматизация: выключить', 'PATCH', `/api/automations/${enabled.id}`, { enabled: false });
  await step('автоматизация: включить после освобождения', 'PATCH', `/api/automations/${disabled.id}`, { enabled: true });
  await step('автоматизация: неверное значение', 'PATCH', `/api/automations/${enabled.id}`, { enabled: 'да' });
  await step('автоматизация: запустить', 'POST', `/api/automations/${enabled.id}/run`);
  await step('автоматизация: запустить чужое', 'POST', '/api/automations/999999/run');
  await step('автоматизация: удалить', 'DELETE', `/api/automations/${enabled.id}`);
  await step('автоматизация: удалить снова', 'DELETE', `/api/automations/${enabled.id}`);

  // 7. Правила реагируют на события
  await step('правила: новая задача', 'POST', '/api/tasks', { title: 'Событие 1' });
  tasks = (await dash()).tasks;
  await step('правила: выполнить', 'PATCH', `/api/tasks/${tasks.find(t => t.title === 'Событие 1').id}`, { done: true });

  // 8. Уведомления и настройки
  let notes = (await dash()).notes;
  const unread = notes.find(n => !n.read);
  await step('уведомление: прочитано', 'PATCH', `/api/notifications/${unread.id}`, { read: true });
  await step('уведомление: неверное', 'PATCH', `/api/notifications/${unread.id}`, { read: 1 });
  await step('уведомление: чужое', 'PATCH', '/api/notifications/999999', { read: true });
  await step('уведомления: прочитать все', 'POST', '/api/notifications/read-all');
  await step('уведомления: очистить', 'DELETE', '/api/notifications');
  await step('настройки: пусто', 'PATCH', '/api/prefs', {});
  await step('настройки: неверно', 'PATCH', '/api/prefs', { tg: 'да' });
  await step('настройки: ок', 'PATCH', '/api/prefs', { email: true });
  await step('telegram: тест без подключения', 'POST', '/api/telegram/test');

  // 9. Тарифы и оплата
  await step('billing: обзор', 'GET', '/api/billing');
  for (const [i, plan] of ['start', 123, undefined].entries()) await step(`checkout: неверный тариф ${i}`, 'POST', '/api/billing/checkout', { plan });
  const co = await step('checkout: Про', 'POST', '/api/billing/checkout', { plan: 'pro', amount: 1, userId: 5 });
  const orderId = co.body.order.id;
  await step('заказ: получить', 'GET', `/api/billing/orders/${orderId}`);
  await step('заказ: чужой/мусорный', 'GET', '/api/billing/orders/AAAAAAAAAAAAAAAAAAAAAA');
  await step('заказ: слишком короткий адрес', 'GET', '/api/billing/orders/abc');
  await step('заказ: оплатить', 'POST', `/api/billing/orders/${orderId}/pay`);
  await step('заказ: оплатить повторно', 'POST', `/api/billing/orders/${orderId}/pay`);
  await step('billing: после оплаты', 'GET', '/api/billing');
  await step('dashboard: тариф Про', 'GET', '/api/dashboard');
  let added = 0;
  while ((await dash()).plan.usage.automations < 25) { const r = await c.call('POST', '/api/automations', { name: `Правило ${added++}`, trigger: TRIGGERS[1], action: ACTIONS[3] }); assert.equal(r.status, 200); }
  await step('автоматизация: лимит «Про» (25)', 'POST', '/api/automations', { name: 'Двадцать шестая', trigger: TRIGGERS[1], action: ACTIONS[3] });
  const biz = await step('checkout: Бизнес', 'POST', '/api/billing/checkout', { plan: 'business' });
  await step('заказ Бизнес: оплатить', 'POST', `/api/billing/orders/${biz.body.order.id}/pay`);
  await step('автоматизация: после «Бизнес»', 'POST', '/api/automations', { name: 'Двадцать шестая', trigger: TRIGGERS[1], action: ACTIONS[3] });
  await step('checkout: понижение', 'POST', '/api/billing/checkout', { plan: 'pro' });
  const old = await step('checkout: новый заказ', 'POST', '/api/billing/checkout', { plan: 'business' });
  const old2 = await step('checkout: ещё заказ (отменяет прежний)', 'POST', '/api/billing/checkout', { plan: 'business' });
  await step('заказ: отменённый прежним', 'POST', `/api/billing/orders/${old.body.order.id}/pay`);
  await step('заказ: отмена', 'POST', `/api/billing/orders/${old2.body.order.id}/cancel`);
  await step('заказ: оплатить отменённый', 'POST', `/api/billing/orders/${old2.body.order.id}/pay`);
  for (let i = 0; i < 3; i++) await step(`checkout: лимит в час ${i + 1}`, 'POST', '/api/billing/checkout', { plan: 'business' });   // десятый ещё проходит, одиннадцатый нет
  await step('billing: история', 'GET', '/api/billing');

  // 10. Смена пароля
  await step('пароль: неверный текущий', 'POST', '/api/change-password', { current: 'wrong', password: 'NewPass456' });
  await step('пароль: слабый новый', 'POST', '/api/change-password', { current: PASS, password: '123' });
  await step('пароль: ок', 'POST', '/api/change-password', { current: PASS, password: 'NewPass456' });

  // 11. Контакты
  await step('контакты: пусто', 'POST', '/api/contact', {});
  await step('контакты: бот', 'POST', '/api/contact', { name: 'Бот', email: 'b@x.kz', message: 'Купите срочно наши товары', website: 'http://spam' });
  await step('контакты: ок', 'POST', '/api/contact', { name: 'Анна', email: 'anna@x.kz', message: 'Здравствуйте! Хочу узнать про тарифы.' });

  // 12. Сброс данных образцов
  await step('образцы: сброс', 'POST', '/api/demo/reset');

  // 13. Выход, вход, блокировка перебора
  await step('выход', 'POST', '/api/logout');
  await step('после выхода: session', 'GET', '/api/session');
  await step('вход: старый пароль', 'POST', '/api/login', { email: 'ivan@mail.kz', password: PASS });
  await step('вход: пусто', 'POST', '/api/login', {});
  await step('вход: ок', 'POST', '/api/login', { email: ' IVAN@mail.kz', password: 'NewPass456' });
  await step('после входа: тариф сохранился', 'GET', '/api/dashboard');
  await step('выход 2', 'POST', '/api/logout');
  for (let i = 0; i < 5; i++) await step(`перебор ${i + 1}`, 'POST', '/api/login', { email: 'ghost@mail.kz', password: 'whatever1' });
  await step('перебор: блокировка', 'POST', '/api/login', { email: 'ghost@mail.kz', password: 'whatever1' });

  // 14. Сброс пароля
  await step('сброс: пустой email', 'POST', '/api/forgot-password', {});
  await step('сброс: плохой email', 'POST', '/api/forgot-password', { email: 'not-an-email' });
  await step('сброс: нет такого', 'POST', '/api/forgot-password', { email: 'nobody@mail.kz' });
  await step('сброс: есть такой', 'POST', '/api/forgot-password', { email: 'IVAN@mail.kz' });
  const rt = c.token('reset', 'ivan@mail.kz');
  assert.ok(rt, 'письмо со сбросом получено');
  await step('сброс: check мусор', 'POST', '/api/reset-password/check', { token: 'nope' });
  await step('сброс: check ок', 'POST', '/api/reset-password/check', { token: rt });
  await step('сброс: слабый пароль', 'POST', '/api/reset-password', { token: rt, password: '12345678' });
  await step('сброс: check после слабого', 'POST', '/api/reset-password/check', { token: rt });
  await step('сброс: ок', 'POST', '/api/reset-password', { token: rt, password: 'Brand-New789' });
  await step('сброс: повтор ссылки', 'POST', '/api/reset-password', { token: rt, password: 'Another789' });
  await step('вход: после сброса старый', 'POST', '/api/login', { email: 'ivan@mail.kz', password: 'NewPass456' });
  await step('вход: после сброса новый', 'POST', '/api/login', { email: 'ivan@mail.kz', password: 'Brand-New789' });

  // 15. Удаление аккаунта
  await step('удаление: без пароля', 'DELETE', '/api/me', {});
  await step('удаление: неверный пароль', 'DELETE', '/api/me', { password: 'wrong' });
  await step('удаление: ок', 'DELETE', '/api/me', { password: 'Brand-New789' });
  await step('после удаления: session', 'GET', '/api/session');
  await step('после удаления: вход', 'POST', '/api/login', { email: 'ivan@mail.kz', password: 'Brand-New789' });
  await step('неизвестный адрес API', 'GET', '/api/unknown');
  return log;
}

test('ПАРИТЕТ: демо отвечает на запросы так же, как настоящий сервер (≈150 запросов подряд)', async () => {
  const real = await realClient();
  try {
    const [a, b] = [await scenario(real), await scenario(demoClient())];
    assert.equal(a.length, b.length);
    const diffs = [];
    for (let i = 0; i < a.length; i++) {
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) diffs.push(`#${i} «${a[i][0]}»\n   сервер: ${JSON.stringify(a[i].slice(1)).slice(0, 700)}\n   демо:   ${JSON.stringify(b[i].slice(1)).slice(0, 700)}`);
    }
    assert.equal(diffs.length, 0, `Расхождения (${diffs.length} из ${a.length}):\n${diffs.slice(0, 6).join('\n')}`);
    assert.ok(a.length > 130, `шагов: ${a.length}`);
  } finally { real.close(); }
});

test('ПАРИТЕТ: списки триггеров, действий и лимитов совпадают с серверными', () => {
  const sandbox = { crypto: webcrypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(engineBundle(), sandbox);
  const d = sandbox.AutoFlowDemoEngine;
  assert.deepEqual([...d.TRIGGERS], TRIGGERS);
  assert.deepEqual([...d.ACTIONS], ACTIONS);
  assert.deepEqual({ ...d.LIMITS }, { ...LIMITS });
});

test('демо: данные переживают перезагрузку страницы, повреждённое хранилище не ломает работу', async () => {
  const sandbox = { crypto: webcrypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(engineBundle(), sandbox);
  const store = new Map();
  const mk = () => sandbox.AutoFlowDemoEngine.createEngine({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, crypto: webcrypto });
  const e1 = mk();
  assert.equal((await e1.handle('POST', '/api/register', USER)).status, 201);
  await e1.handle('POST', '/api/tasks', { title: 'Сохранится после перезагрузки' });
  const e2 = mk();                                                       // «перезагрузка»: новый движок с тем же хранилищем
  assert.equal((await e2.handle('GET', '/api/session')).body.user.email, 'ivan@mail.kz');
  assert.ok((await e2.handle('GET', '/api/dashboard')).body.dashboard.tasks.some(t => t.title === 'Сохранится после перезагрузки'));
  store.set([...store.keys()][0], '{битый json');
  const e3 = mk();
  assert.equal((await e3.handle('GET', '/api/session')).body.user, null, 'повреждённые данные = чистый старт');
  assert.equal((await e3.handle('POST', '/api/register', USER)).status, 201);
});

test('демо: ошибка внутри запроса откатывает все его изменения (как транзакция на сервере)', async () => {
  const sandbox = { crypto: webcrypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(engineBundle(), sandbox);
  const store = new Map();
  const e = sandbox.AutoFlowDemoEngine.createEngine({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, crypto: webcrypto });
  await e.handle('POST', '/api/register', USER);
  await e.handle('GET', '/api/dashboard');
  const before = JSON.stringify(e.state().data);
  const r = await e.handle('POST', '/api/automations', { name: 'Четвёртая', trigger: TRIGGERS[0], action: ACTIONS[0] });
  assert.equal(r.status, 402);
  assert.equal(JSON.stringify(e.state().data), before, 'ничего не изменилось');
});

test('демо: Telegram и «почта» (имитация): ссылка → подключение → сообщения от правил → отключение', async () => {
  const sandbox = { crypto: webcrypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(engineBundle(), sandbox);
  let t = 1_700_000_000_000;
  const store = new Map();
  const e = sandbox.AutoFlowDemoEngine.createEngine({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, crypto: webcrypto, now: () => t });
  await e.handle('POST', '/api/register', USER);
  const dash = async () => (await e.handle('GET', '/api/dashboard')).body.dashboard;
  assert.deepEqual({ ...(await dash()).tg, since: 0 }, { configured: true, bot: 'autoflow_demo_bot', on: false, username: '', since: 0 });
  const c = (await e.handle('POST', '/api/telegram/connect')).body;
  assert.match(c.pending.link, /^https:\/\/t\.me\/autoflow_demo_bot\?start=[\w-]{22}$/);
  assert.equal((await dash()).tg.on, false, 'сразу после создания ссылки ещё не подключено');
  t += 3000;
  assert.equal((await dash()).tg.on, true, 'через пару секунд подтверждение «пришло»');
  assert.equal((await e.handle('POST', '/api/telegram/connect')).status, 409);
  // правило «Новая задача → Telegram» есть в образцах, но на «Старт» не доставляется
  await e.handle('POST', '/api/tasks', { title: 'на старте' });
  assert.ok(!e.inbox().some(m => m.kind === 'telegram' && m.text.includes('Уведомлять о новых задачах')));
  await e.handle('POST', '/api/billing/checkout', { plan: 'pro' });
  const order = (await e.handle('GET', '/api/billing')).body.orders[0];
  await e.handle('POST', `/api/billing/orders/${order.id}/pay`);
  await e.handle('POST', '/api/tasks', { title: 'на Про' });
  assert.ok(e.inbox().some(m => m.kind === 'telegram' && m.text.includes('Новая задача: «на Про»')), 'на «Про» сообщение попадает в «Telegram»');
  assert.equal((await e.handle('POST', '/api/telegram/test')).status, 200);
  await e.handle('POST', '/api/telegram/disconnect');
  assert.equal((await dash()).tg.on, false);
  assert.equal((await e.handle('POST', '/api/telegram/test')).status, 409);
});
