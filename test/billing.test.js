import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { PLANS, PERIOD_DAYS } from '../src/plans.js';

process.env.LOG_REQUESTS = '0';
const DAY = 86400000;

/* ---------- Стенд: два приложения (оплата в демо-режиме и выключенная) ---------- */
async function makeApp(mode, limits = {}) {
  const config = loadConfig({
    dbFile: ':memory:', appUrl: 'https://autoflow.test', mail: { transport: 'memory' }, billing: { mode },
    limits: { regPerHour: 1000, loginPerIp10Min: 1000, globalPerMin: 100000, writesPerMin: 100000, checkoutPerHour: 1000, ...limits },
  });
  const db = openDb(':memory:');
  const app = createApp({ config, db });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let n = 0;
  const call = async (method, path, { body, cookie, csrf } = {}) => {
    const h = { Origin: base, 'Content-Type': 'application/json' };
    if (cookie) h.Cookie = cookie;
    if (csrf) h['X-CSRF-Token'] = csrf;
    const r = await fetch(base + path, { method, headers: h, body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body) });
    const json = await r.json().catch(() => null);
    const sc = r.headers.get('set-cookie');
    return { status: r.status, json, cookie: sc ? sc.split(';')[0] : null, headers: r.headers };
  };
  const newUser = async () => {
    n++;
    const r = await call('POST', '/api/register', { body: { name: 'Иван Петров', email: `b${n}@example.com`, phone: '+7 700 123 45 67', password: 'Secret123' } });
    const id = db.prepare('SELECT id FROM users WHERE public_id = ?').get(r.json.user.id).id;
    const u = { id, cookie: r.cookie, csrf: r.json.csrf };
    u.api = (m, p, b) => call(m, p, { body: b, cookie: u.cookie, csrf: u.csrf });
    return u;
  };
  const close = () => { app.server.closeAllConnections?.(); app.server.close(); };
  return { app, db, base, call, newUser, close };
}

let demo, off;
before(async () => { demo = await makeApp('demo'); off = await makeApp('off'); });
after(() => { demo.close(); off.close(); });

const planOf = async (u) => (await u.api('GET', '/api/dashboard')).json.dashboard.plan;
const buy = async (u, plan = 'pro') => {
  const co = await u.api('POST', '/api/billing/checkout', { plan });
  assert.equal(co.status, 200, 'checkout');
  const id = co.json.order.id;
  const pay = await u.api('POST', `/api/billing/orders/${id}/pay`);
  assert.equal(pay.status, 200, 'pay');
  return id;
};
const setPlan = (ctx, u, plan, periodEnd) => ctx.db.prepare(`INSERT INTO subscriptions (user_id, plan, period_end, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, period_end = excluded.period_end`).run(u.id, plan, periodEnd, Date.now());

test('настройки: режим оплаты проверяется, в production по умолчанию оплата выключена', () => {
  assert.equal(loadConfig({ appUrl: 'https://x.kz' }).billing.mode, 'demo');
  const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    assert.equal(loadConfig({ appUrl: 'https://x.kz' }).billing.mode, 'off', 'без явной настройки платный тариф получить нельзя');
    assert.throws(() => loadConfig({ appUrl: 'https://x.kz', billing: { mode: 'live' } }), /PAYMENTS_MODE/);
    assert.throws(() => loadConfig({ appUrl: 'https://x.kz', billing: { mode: 'free' } }), /PAYMENTS_MODE/);
  } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
});

test('оплата ВЫКЛЮЧЕНА: платный тариф получить невозможно никакими запросами', async () => {
  const u = await off.newUser();
  assert.equal((await u.api('POST', '/api/billing/checkout', { plan: 'pro' })).status, 503);
  // поддельные идентификаторы заказа и попытки «оплатить» чужое или несуществующее
  assert.equal((await u.api('POST', '/api/billing/orders/AAAAAAAAAAAAAAAAAAAAAA/pay')).status, 403);
  // даже если заказ вручную появился в БД, в режиме off оплатить его нельзя
  off.db.prepare("INSERT INTO orders (public_id, user_id, plan, amount, status, provider, created_at) VALUES ('ORDERORDERORDER0001', ?, 'pro', 4900, 'pending', 'demo', ?)").run(u.id, Date.now());
  assert.equal((await u.api('POST', '/api/billing/orders/ORDERORDERORDER0001/pay')).status, 403);
  assert.equal((await planOf(u)).id, 'start');
  assert.equal(off.db.prepare('SELECT COUNT(*) AS c FROM subscriptions WHERE user_id = ?').get(u.id).c, 0);
  const ov = await u.api('GET', '/api/billing');
  assert.equal(ov.json.mode, 'off');
});

test('доступ: без сессии 401, без CSRF-токена 403, неверные тарифы 400', async () => {
  assert.equal((await demo.call('GET', '/api/billing')).status, 401);
  assert.equal((await demo.call('POST', '/api/billing/checkout', { body: { plan: 'pro' } })).status, 401);
  const u = await demo.newUser();
  assert.equal((await demo.call('POST', '/api/billing/checkout', { body: { plan: 'pro' }, cookie: u.cookie })).status, 403);
  for (const plan of ['start', 'enterprise', 'PRO', '', 123, null, ['pro'], { id: 'pro' }, undefined]) {
    const r = await u.api('POST', '/api/billing/checkout', { plan });
    assert.equal(r.status, 400, JSON.stringify(plan));
    assert.ok(r.json.fields.plan);
  }
  assert.equal((await u.api('POST', '/api/billing/checkout', undefined)).status, 400);
  assert.equal((await planOf(u)).id, 'start');
});

test('каталог тарифов и состояние приходят с сервера и совпадают с plans.js', async () => {
  const u = await demo.newUser();
  const r = await u.api('GET', '/api/billing');
  assert.equal(r.status, 200); assert.equal(r.json.mode, 'demo');
  assert.deepEqual(r.json.catalog.map(p => [p.id, p.price, p.limits.automations]), Object.values(PLANS).map(p => [p.id, p.price, p.automations]));
  assert.equal(r.json.plan.id, 'start'); assert.deepEqual(r.json.plan.usage, { automations: 3 });
  assert.deepEqual(r.json.orders, []);
});

test('оплата (демо): заказ → оплата → тариф активирован на 30 дней, событие в журнале', async () => {
  const u = await demo.newUser();
  const co = await u.api('POST', '/api/billing/checkout', { plan: 'pro' });
  assert.equal(co.json.order.amount, 4900); assert.equal(co.json.order.currency, 'KZT'); assert.equal(co.json.order.status, 'pending');
  assert.match(co.json.url, /^\/checkout\?order=[A-Za-z0-9_-]{22}$/);
  const id = co.json.order.id;
  assert.equal((await planOf(u)).id, 'start', 'пока не оплачено, тариф не меняется');

  const got = await u.api('GET', `/api/billing/orders/${id}`);
  assert.equal(got.json.order.planName, 'Про');

  const before = Date.now();
  const pay = await u.api('POST', `/api/billing/orders/${id}/pay`);
  assert.equal(pay.status, 200); assert.equal(pay.json.order.status, 'paid');
  const plan = await planOf(u);
  assert.equal(plan.id, 'pro'); assert.equal(plan.limits.automations, 25); assert.equal(plan.limits.telegramNotify, true);
  assert.ok(Math.abs(plan.periodEnd - (before + PERIOD_DAYS * DAY)) < 5000, 'период около 30 дней');
  const d = (await u.api('GET', '/api/dashboard')).json.dashboard;
  assert.ok(d.feed.some(f => f.text === 'Тариф «Про» активирован'));
  assert.ok(d.notes.some(n => n.text.startsWith('Тариф «Про» активирован до')));
  assert.equal(pay.json.billing.orders[0].status, 'paid');
});

test('ЗАЩИТА ЦЕНЫ: сумма, тариф и владелец заказа берутся только на сервере', async () => {
  const a = await demo.newUser(), b = await demo.newUser();
  const r = await a.api('POST', '/api/billing/checkout', { plan: 'business', amount: 1, price: 0, currency: 'USD', userId: b.id, user_id: b.id, status: 'paid' });
  assert.equal(r.status, 200);
  assert.equal(r.json.order.amount, 14900); assert.equal(r.json.order.currency, 'KZT'); assert.equal(r.json.order.status, 'pending');
  const row = demo.db.prepare('SELECT user_id, amount, status FROM orders WHERE public_id = ?').get(r.json.order.id);
  assert.equal(row.user_id, a.id); assert.equal(row.amount, 14900);
  assert.equal((await planOf(a)).id, 'start'); assert.equal((await planOf(b)).id, 'start');
  // тело запроса оплаты ничего не решает
  await a.api('POST', `/api/billing/orders/${r.json.order.id}/pay`, { plan: 'start', amount: 0, userId: b.id });
  assert.equal((await planOf(a)).id, 'business', 'тариф из заказа, а не из запроса');
  assert.equal((await planOf(b)).id, 'start', 'чужой аккаунт не затронут');
});

test('ИЗОЛЯЦИЯ: чужой заказ нельзя ни посмотреть, ни оплатить, ни отменить', async () => {
  const a = await demo.newUser(), b = await demo.newUser();
  const id = (await a.api('POST', '/api/billing/checkout', { plan: 'pro' })).json.order.id;
  assert.equal((await b.api('GET', `/api/billing/orders/${id}`)).status, 404);
  assert.equal((await b.api('POST', `/api/billing/orders/${id}/pay`)).status, 404);
  assert.equal((await b.api('POST', `/api/billing/orders/${id}/cancel`)).status, 404);
  assert.equal((await planOf(b)).id, 'start');
  assert.deepEqual((await b.api('GET', '/api/billing')).json.orders, [], 'список заказов только свой');
  assert.equal((await a.api('GET', `/api/billing/orders/${id}`)).json.order.status, 'pending', 'заказ владельца не тронут');
  for (const bad of ['1', 'abc', '../x', 'A'.repeat(100), '%00']) assert.equal((await b.api('GET', `/api/billing/orders/${bad}`)).status, 404, bad);
});

test('двойная оплата и гонка: тариф продлевается только один раз', async () => {
  const u = await demo.newUser();
  const id = (await u.api('POST', '/api/billing/checkout', { plan: 'pro' })).json.order.id;
  const results = await Promise.all([1, 2, 3, 4].map(() => u.api('POST', `/api/billing/orders/${id}/pay`)));
  assert.equal(results.filter(r => r.status === 200).length, 1, 'ровно одна оплата прошла');
  assert.ok(results.filter(r => r.status === 409).length === 3);
  const end = (await planOf(u)).periodEnd;
  assert.equal((await u.api('POST', `/api/billing/orders/${id}/pay`)).status, 409, 'повтор отклонён');
  assert.equal((await planOf(u)).periodEnd, end, 'срок не изменился');
  // идемпотентность самой функции (так будут приходить повторные webhook)
  const orderId = demo.db.prepare('SELECT id FROM orders WHERE public_id = ?').get(id).id;
  assert.equal(demo.app.billing.applyPayment(orderId), null);
});

test('продление, повышение и запрет понижения тарифа', async () => {
  const u = await demo.newUser();
  await buy(u, 'pro');
  const end1 = (await planOf(u)).periodEnd;
  await buy(u, 'pro');
  assert.equal((await planOf(u)).periodEnd, end1 + PERIOD_DAYS * DAY, 'тот же тариф: срок прибавляется');
  await buy(u, 'business');
  const p = await planOf(u);
  assert.equal(p.id, 'business'); assert.ok(p.periodEnd < Date.now() + PERIOD_DAYS * DAY + 5000, 'повышение: новый период от сегодня');
  const down = await u.api('POST', '/api/billing/checkout', { plan: 'pro' });
  assert.equal(down.status, 409); assert.equal(down.json.error, 'plan_downgrade');
  assert.equal((await planOf(u)).id, 'business');
});

test('заказы: новый заказ отменяет прежние неоплаченные, просроченный оплатить нельзя, отмена работает', async () => {
  const u = await demo.newUser();
  const first = (await u.api('POST', '/api/billing/checkout', { plan: 'pro' })).json.order.id;
  const second = (await u.api('POST', '/api/billing/checkout', { plan: 'business' })).json.order.id;
  assert.equal((await u.api('POST', `/api/billing/orders/${first}/pay`)).status, 409, 'первый заказ отменён вторым');
  assert.equal((await u.api('GET', `/api/billing/orders/${first}`)).json.order.status, 'canceled');

  demo.db.prepare('UPDATE orders SET created_at = ? WHERE public_id = ?').run(Date.now() - 31 * 60000, second);
  assert.equal((await u.api('GET', `/api/billing/orders/${second}`)).json.order.status, 'expired');
  assert.equal((await u.api('POST', `/api/billing/orders/${second}/pay`)).status, 410);
  assert.equal((await planOf(u)).id, 'start');

  const third = (await u.api('POST', '/api/billing/checkout', { plan: 'pro' })).json.order.id;
  assert.equal((await u.api('POST', `/api/billing/orders/${third}/cancel`)).json.order.status, 'canceled');
  assert.equal((await u.api('POST', `/api/billing/orders/${third}/pay`)).status, 409);
});

test('ЛИМИТЫ ТАРИФА: «Старт» = 3 активные автоматизации, «Про» = 25, «Бизнес» = 100', async () => {
  const u = await demo.newUser();
  const mk = (name) => u.api('POST', '/api/automations', { name, trigger: 'Задача выполнена', action: 'Записать в журнал' });
  let r = await mk('Четвёртая');
  assert.equal(r.status, 402); assert.equal(r.json.error, 'plan_limit');
  assert.match(r.json.fields.name, /«Старт».*3/);
  // включить четвёртую (выключенную образцовую) тоже нельзя
  const off4 = (await u.api('GET', '/api/dashboard')).json.dashboard.autos.find(a => !a.on);
  r = await u.api('PATCH', `/api/automations/${off4.id}`, { enabled: true });
  assert.equal(r.status, 402);
  // выключить можно всегда, а освободившееся место сразу занимается
  const on1 = (await u.api('GET', '/api/dashboard')).json.dashboard.autos.find(a => a.on);
  assert.equal((await u.api('PATCH', `/api/automations/${on1.id}`, { enabled: false })).status, 200);
  assert.equal((await u.api('PATCH', `/api/automations/${off4.id}`, { enabled: true })).status, 200);

  await buy(u, 'pro');
  assert.equal((await mk('Новая 1')).status, 200);
  const db_ = () => demo.db.prepare('SELECT COUNT(*) AS c FROM automations WHERE user_id = ? AND enabled = 1').get(u.id).c;
  while (db_() < 25) assert.equal((await mk('Правило ' + db_())).status, 200);
  assert.equal((await mk('Двадцать шестая')).status, 402, 'на «Про» предел 25');
  await buy(u, 'business');
  assert.equal((await mk('Двадцать шестая')).status, 200, 'на «Бизнесе» предел выше');
  assert.equal((await u.api('GET', '/api/dashboard')).json.dashboard.plan.limits.automations, 100);
});

test('Telegram-уведомления от автоматизаций только на платных тарифах', async () => {
  const u = await demo.newUser();
  demo.db.prepare('INSERT INTO telegram_links (user_id, chat_id, username, linked_at) VALUES (?, ?, ?, ?)').run(u.id, 424242, 'x', Date.now());
  const outbox = () => demo.db.prepare('SELECT COUNT(*) AS c FROM telegram_outbox WHERE user_id = ?').get(u.id).c;
  // образцовое правило «Уведомлять о новых задачах» шлёт в Telegram
  await u.api('POST', '/api/tasks', { title: 'на старте' });
  assert.equal(outbox(), 0, 'на «Старт» сообщение не уходит');
  assert.ok((await u.api('GET', '/api/dashboard')).json.dashboard.notes.some(n => n.text.includes('доступны на тарифе «Про»')));
  assert.equal((await u.api('POST', '/api/telegram/test')).status, 200, 'проверка связи доступна всем');
  const afterTest = outbox();
  await buy(u, 'pro');
  await u.api('POST', '/api/tasks', { title: 'на «Про»' });
  assert.equal(outbox(), afterTest + 1, 'на «Про» сообщение ушло в очередь');
});

test('окончание тарифа: возврат к «Старт», лишние автоматизации приостанавливаются один раз', async () => {
  const u = await demo.newUser();
  await buy(u, 'business');
  for (let i = 0; i < 12; i++) await u.api('POST', '/api/automations', { name: 'Доп ' + i, trigger: 'Задача выполнена', action: 'Записать в журнал' });
  const enabled = () => demo.db.prepare('SELECT COUNT(*) AS c FROM automations WHERE user_id = ? AND enabled = 1').get(u.id).c;
  assert.equal(enabled(), 15);

  demo.db.prepare('UPDATE subscriptions SET period_end = ? WHERE user_id = ?').run(Date.now() - 1000, u.id);
  const d = (await u.api('GET', '/api/dashboard')).json.dashboard;
  assert.equal(d.plan.id, 'start'); assert.equal(d.plan.periodEnd, 0);
  assert.equal(enabled(), 3, 'осталось по лимиту «Старт»');
  const kept = demo.db.prepare('SELECT name FROM automations WHERE user_id = ? AND enabled = 1 ORDER BY created_at, id').all(u.id).map(r => r.name);
  assert.ok(!kept.some(n => n.startsWith('Доп ')), 'сохранены самые старые (образцовые)');
  const notes = d.notes.filter(n => /Срок тарифа|Тариф изменился/.test(n.text)).length;
  assert.equal(notes, 2);
  await u.api('GET', '/api/dashboard'); await u.api('GET', '/api/dashboard');
  assert.equal((await u.api('GET', '/api/dashboard')).json.dashboard.notes.filter(n => /Срок тарифа|Тариф изменился/.test(n.text)).length, 2, 'повторно уведомления не создаются');
  assert.equal((await u.api('POST', '/api/automations', { name: 'Снова лимит', trigger: 'Задача выполнена', action: 'Записать в журнал' })).status, 402);
  await buy(u, 'pro');
  assert.equal((await planOf(u)).id, 'pro', 'после новой оплаты тариф снова действует');
});

test('просроченный платный тариф не даёт преимуществ даже без обращения к кабинету', async () => {
  const u = await demo.newUser();
  setPlan(demo, u, 'business', Date.now() - 1000);
  const r = await u.api('POST', '/api/automations', { name: 'Не должно пройти', trigger: 'Задача выполнена', action: 'Записать в журнал' });
  assert.equal(r.status, 402, 'лимит считается по действующему тарифу, а не по записи в таблице');
});

test('лимит частоты оформления заказов', async () => {
  const x = await makeApp('demo', { checkoutPerHour: 3 });
  try {
    const u = await x.newUser();
    let last;
    for (let i = 0; i < 5; i++) last = await u.api('POST', '/api/billing/checkout', { plan: 'pro' });
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally { x.close(); }
});

test('страница оплаты: только для вошедших', async () => {
  const guest = await fetch(demo.base + '/checkout', { redirect: 'manual' });
  assert.equal(guest.status, 302); assert.equal(guest.headers.get('location'), '/login');
  const u = await demo.newUser();
  const ok = await fetch(demo.base + '/checkout?order=x', { headers: { Cookie: u.cookie } });
  assert.equal(ok.status, 200);
});

test('удаление аккаунта удаляет заказы и подписку', async () => {
  const u = await demo.newUser();
  await buy(u, 'pro');
  assert.equal(demo.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE user_id = ?').get(u.id).c, 1);
  assert.equal((await u.api('DELETE', '/api/me', { password: 'Secret123' })).status, 200);
  for (const t of ['orders', 'subscriptions']) assert.equal(demo.db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE user_id = ?`).get(u.id).c, 0, t);
});
