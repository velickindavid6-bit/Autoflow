/* AutoFlow demo: сервер в браузере. Файл собран автоматически (npm run build:demo), не редактируйте его вручную. */
(function () {
'use strict';
/* Тарифы. Единственный источник правды о ценах и ограничениях: клиент присылает только код тарифа, всё остальное берётся здесь. */
const PLANS = {
  start:    { id: 'start',    name: 'Старт',  price: 0,      automations: 3,   telegramNotify: false, rank: 0 },
  pro:      { id: 'pro',      name: 'Про',    price: 4900,   automations: 25,  telegramNotify: true,  rank: 1 },
  business: { id: 'business', name: 'Бизнес', price: 14900,  automations: 100, telegramNotify: true,  rank: 2 },
};
const PAID_PLANS = ['pro', 'business'];
const CURRENCY = 'KZT';
const PERIOD_DAYS = 30;          // длительность оплаченного периода
const ORDER_TTL_MIN = 30;        // сколько живёт неоплаченный заказ

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;

const str = (v) => (typeof v === 'string' ? v : '');

function cleanName(v) { return str(v).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim(); }
function cleanEmail(v) { return str(v).trim().toLowerCase(); }
function cleanPhone(v) { return str(v).replace(CTRL_RE, '').trim(); }

const checks = {
  name(v) {
    if (v.length > 100 || /[<>]/.test(v)) return 'Недопустимые символы в имени';
    return v.split(' ').filter(w => w.length > 1).length >= 2 ? '' : 'Укажите имя и фамилию';
  },
  email(v) {
    return v.length <= 254 && EMAIL_RE.test(v) ? '' : 'Введите корректный email';
  },
  phone(v, { required } = {}) {
    if (!v) return required ? 'Введите номер, например +7 700 123 45 67' : '';
    const digits = v.replace(/\D/g, '');
    return v.length <= 32 && /^[\d+\s()-]+$/.test(v) && digits.length >= 10 && digits.length <= 15
      ? '' : 'Введите номер, например +7 700 123 45 67';
  },
  password(v) {
    if (typeof v !== 'string' || v.length < 8) return 'Минимум 8 символов';
    if (v.length > 128) return 'Максимум 128 символов';
    if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) return 'Добавьте буквы и цифры';
    return '';
  },
};

const collect = (pairs) => {
  const errors = {};
  for (const [k, msg] of pairs) if (msg) errors[k] = msg;
  return errors;
};

function validateRegister(body) {
  const v = { name: cleanName(body.name), email: cleanEmail(body.email), phone: cleanPhone(body.phone), password: body.password };
  return {
    value: v,
    errors: collect([
      ['name', checks.name(v.name)],
      ['email', checks.email(v.email)],
      ['phone', checks.phone(v.phone, { required: true })],
      ['password', checks.password(v.password)],
    ]),
  };
}

function validateProfile(body) {
  const v = { name: cleanName(body.name), phone: cleanPhone(body.phone) };
  return { value: v, errors: collect([['name', checks.name(v.name)], ['phone', checks.phone(v.phone)]]) };
}

function validateContact(body) {
  const v = {
    name: cleanName(body.name),
    email: cleanEmail(body.email),
    message: str(body.message).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(),
  };
  const nameErr = v.name.length < 2 || v.name.length > 100 || /[<>]/.test(v.name) ? 'Укажите имя' : '';
  const msgErr = v.message.length < 10 ? 'Напишите хотя бы пару предложений (от 10 символов)'
    : v.message.length > 2000 ? 'Сообщение слишком длинное (максимум 2000 символов)' : '';
  return { value: v, errors: collect([['name', nameErr], ['email', checks.email(v.email)], ['message', msgErr]]) };
}

/* ==========================================================
   AutoFlow — «сервер в браузере» для демо-версии на GitHub Pages.

   GitHub Pages отдаёт только статические файлы, поэтому настоящий сервер (Node.js + SQLite) там не запустить.
   Этот файл повторяет логику сервера (src/data.js, src/billing.js, src/auth.js) внутри браузера:
   запросы к /api/* перехватываются и обрабатываются здесь, данные лежат в localStorage.

   Правила и цены берутся из тех же файлов, что и на сервере (src/plans.js, src/validation.js):
   при сборке они вставляются в начало этого файла. Совпадение поведения с настоящим сервером
   проверяют автотесты (test/demo-parity.test.js): один сценарий выполняется и там, и тут.

   ЭТО ДЕМО: пароли хешируются, но данные в localStorage не защищены, писем и Telegram на самом деле нет
   (они показываются в окне «Демо-почта»). Для настоящих пользователей используйте серверную версию.
   ========================================================== */
(function (root) {
  'use strict';

  const DAY = 86400000, MIN = 60000, HOUR = 3600000;
  const TRIGGERS = ['Новая задача создана', 'Задача выполнена', 'Каждый день в 09:00', 'Приходит новое письмо'];
  const ACTIONS = ['Отправить уведомление в Telegram', 'Создать задачу', 'Отправить email', 'Записать в журнал'];
  const PRIORITIES = ['low', 'mid', 'high'];
  const LIMITS = { tasks: 1000, automations: 200, notes: 100, feed: 100 };
  const TOKEN_TTL = { verify: 24 * HOUR, reset: 30 * MIN };
  const KEY = 'autoflow-demo:v1';

  class ApiError extends Error {
    constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
  }
  const bad = (field, message) => new ApiError(400, 'validation', { fields: { [field]: message } });
  const notFound = () => new ApiError(404, 'not_found');

  /* ---------- Проверка входных данных (как в src/data.js) ---------- */
  function cleanText(v, field, label, min, max) {
    if (typeof v !== 'string') throw bad(field, `${label}: введите текст`);
    const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length < min) throw bad(field, min <= 1 ? `${label}: поле не может быть пустым` : `${label}: минимум ${min} символа`);
    if (s.length > max) throw bad(field, `${label}: максимум ${max} символов`);
    return s;
  }
  function cleanDue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('due', 'Срок: неверный формат даты');
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) throw bad('due', 'Срок: такой даты не существует');
    return v;
  }
  const oneOf = (v, list, field, label) => { if (typeof v !== 'string' || !list.includes(v)) throw bad(field, `${label}: недопустимое значение`); return v; };
  const bool = (v, field) => { if (typeof v !== 'boolean') throw bad(field, 'Ожидается true или false'); return v; };
  const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

  function createEngine(opts) {
    const storage = opts.storage;
    const now = opts.now || (() => Date.now());
    const cryptoImpl = opts.crypto || root.crypto;
    const makeLink = opts.makeLink || ((page, token) => `${page}.html#token=${token}`);
    const paymentsMode = opts.paymentsMode || 'demo';
    const botName = opts.botName || 'autoflow_demo_bot';

    /* ---------- Случайность и хеширование ---------- */
    const randBytes = (n) => { const a = new Uint8Array(n); cryptoImpl.getRandomValues(a); return a; };
    const hex = (a) => [...a].map(b => b.toString(16).padStart(2, '0')).join('');
    const b64url = (a) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const enc = (s) => new TextEncoder().encode(s);

    async function hashPassword(password, salt) {
      try {
        const subtle = cryptoImpl && cryptoImpl.subtle;
        if (subtle) {
          const key = await subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
          const bits = await subtle.deriveBits({ name: 'PBKDF2', salt: enc(salt), iterations: 60000, hash: 'SHA-256' }, key, 256);
          return 'pbkdf2:' + hex(new Uint8Array(bits));
        }
      } catch (_) { /* ниже запасной вариант */ }
      // Запасной вариант, если crypto.subtle недоступен (небезопасный контекст): НЕ криптостойкий, только для демо
      let h = 2166136261;
      const s = salt + password;
      for (let r = 0; r < 2000; r++) for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return 'demo:' + h.toString(16);
    }

    /* ---------- Состояние ---------- */
    const fresh = () => ({ v: 1, seq: 100, users: {}, byEmail: {}, session: null, tokens: [], inbox: [], contact: [], data: {}, subs: {}, orders: [] });
    let state = (() => {
      try { const raw = storage.getItem(KEY); if (raw) { const s = JSON.parse(raw); if (s && s.v === 1) return s; } } catch (_) { /* повреждено: начинаем заново */ }
      return fresh();
    })();
    const save = () => { try { storage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* переполнено: демо продолжит работать в памяти */ } };
    const nextId = () => ++state.seq;
    const hits = {};                                     // временные счётчики лимитов (только в памяти)
    const hit = (key, windowMs) => { const t = now(); hits[key] = (hits[key] || []).filter(x => t - x < windowMs); hits[key].push(t); return hits[key].length; };
    const countHits = (key, windowMs) => (hits[key] || []).filter(x => now() - x < windowMs).length;
    const retryAfter = (key, windowMs) => { const a = hits[key] || []; return a.length ? Math.max(1, Math.ceil((a[0] + windowMs - now()) / 1000)) : 1; };
    const tooMany = (key, windowMs) => new ApiError(429, 'too_many_requests', { retryAfter: retryAfter(key, windowMs) });

    /* ---------- Пользователи и сессия ---------- */
    const publicUser = (u) => ({ id: u.publicId, name: u.name, email: u.email, phone: u.phone, emailVerified: !!u.verified });
    const userById = (id) => state.users[id];
    const startSession = (u) => { state.session = { userId: u.id, csrf: b64url(randBytes(32)) }; return state.session.csrf; };
    const currentUser = () => (state.session ? userById(state.session.userId) : null);

    function deleteUserData(uid) {
      const u = state.users[uid];
      if (u) delete state.byEmail[u.email];
      delete state.users[uid]; delete state.data[uid]; delete state.subs[uid];
      state.tokens = state.tokens.filter(t => t.userId !== uid);
      state.orders = state.orders.filter(o => o.userId !== uid);
      if (state.session && state.session.userId === uid) state.session = null;
    }

    /* ---------- Токены и «письма» ---------- */
    function issueToken(uid, purpose) {
      state.tokens = state.tokens.filter(t => !(t.userId === uid && t.purpose === purpose));      // новая ссылка отменяет прежние
      const token = b64url(randBytes(32));
      state.tokens.push({ token, userId: uid, purpose, expires: now() + TOKEN_TTL[purpose], used: false });
      return token;
    }
    const tokenOk = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 100;
    function consumeToken(token, purpose) {
      if (!tokenOk(token)) return null;
      const row = state.tokens.find(t => t.token === token && t.purpose === purpose && !t.used && t.expires > now());
      if (!row) return null;
      row.used = true;
      return row.userId;
    }
    const checkToken = (token, purpose) => tokenOk(token) && state.tokens.some(t => t.token === token && t.purpose === purpose && !t.used && t.expires > now());

    function pushInbox(entry) {
      state.inbox.unshift({ id: nextId(), time: now(), ...entry });
      state.inbox = state.inbox.slice(0, 60);
    }
    function sendMail(uid, kind) {
      const u = userById(uid);
      const first = u.name.split(' ')[0];
      const token = issueToken(uid, kind);
      if (kind === 'verify') {
        const link = makeLink('verify-email', token);
        pushInbox({ kind: 'mail', to: u.email, subject: 'Подтвердите email в AutoFlow', link, linkText: 'Подтвердить email',
          text: `${first}, добро пожаловать в AutoFlow!\n\nПодтвердите email, перейдя по ссылке (действует 24 ч.).\n\nЕсли вы не регистрировались, просто проигнорируйте это письмо.` });
      } else {
        const link = makeLink('reset-password', token);
        pushInbox({ kind: 'mail', to: u.email, subject: 'Сброс пароля в AutoFlow', link, linkText: 'Создать новый пароль',
          text: `${first}, мы получили запрос на сброс пароля.\n\nСоздайте новый пароль по ссылке (действует 30 мин.).\n\nЕсли это были не вы, ничего не делайте: пароль останется прежним.` });
      }
    }

    /* ---------- Данные кабинета ---------- */
    const dataOf = (uid) => state.data[uid];

    function addFeed(uid, text, sub, type) {
      const d = dataOf(uid);
      d.feed.unshift({ id: nextId(), text, sub: sub || '', type, time: now() });
      d.feed = d.feed.slice(0, LIMITS.feed);
    }
    function addNote(uid, text, type) {
      const d = dataOf(uid);
      d.notes.unshift({ id: nextId(), text: String(text).slice(0, 300), type, read: false, time: now() });
      d.notes = d.notes.slice(0, LIMITS.notes);
    }
    const insTask = (d, title, prio, due, done, doneAt, created) => d.tasks.push({ id: nextId(), title, prio, due, done: !!done, doneAt: doneAt || null, created });
    const insAuto = (d, name, trigger, action, on, runs, created) => d.autos.push({ id: nextId(), name, trigger, action, on: !!on, runs, created });

    function seed(uid, keepTg) {
      const t0 = now(), min = MIN, hr = HOUR;
      const d = {
        tasks: [], autos: [], notes: [], feed: [], runs: { ok: 49, total: 50 },
        tg: keepTg || { on: false, username: '', since: 0, pending: null }, prefs: { tg: true, email: false },
      };
      state.data[uid] = d;
      for (const [title, daysAgo] of [['Созвон с командой', 1], ['Оплатить сервер', 2], ['Составить план недели', 2], ['Разобрать входящие', 3], ['Подготовить отчёт', 4]]) {
        const t = t0 - daysAgo * DAY - hr;
        insTask(d, title, 'mid', null, true, t + 30 * min, t);
      }
      const dayStr = (off) => new Date(t0 + off * DAY).toISOString().slice(0, 10);
      insTask(d, 'Отчёт по проекту', 'high', dayStr(0), true, t0 - 30 * min, t0 - 5 * hr);
      insTask(d, 'Проверить почту', 'mid', null, false, null, t0 - 4 * hr);
      insTask(d, 'Подготовить презентацию к встрече', 'high', dayStr(2), false, null, t0 - 3 * hr);
      insTask(d, 'Обновить портфолио', 'low', dayStr(5), false, null, t0 - 2 * hr);
      insTask(d, 'Ответить клиенту', 'mid', dayStr(-1), false, null, t0 - 1 * hr);
      const autos = [
        ['Уведомлять о новых задачах', TRIGGERS[0], ACTIONS[0], 1, 12], ['Журнал выполненных задач', TRIGGERS[1], ACTIONS[3], 1, 23],
        ['Утренняя сводка', TRIGGERS[2], ACTIONS[2], 1, 15], ['Задача из письма', TRIGGERS[3], ACTIONS[1], 0, 0],
      ];
      autos.forEach(([name, trg, act, on, runs], i) => insAuto(d, name, trg, act, on, runs, t0 - (autos.length - i) * hr));
      for (const [text, type, ago, read] of [['Новая задача: Проверить почту', 'task', 3 * hr, true], ['Напоминание: встреча в 16:00', 'bell', 2 * hr, false], ['Задача выполнена: Отчёт по проекту', 'ok', 30 * min, false]]) {
        d.notes.unshift({ id: nextId(), text, type, read, time: t0 - ago });
      }
      for (const [text, sub, type, ago] of [['Новая задача создана', 'Проверить почту', 'task', 4 * hr], ['Уведомление отправлено', 'Напоминание о встрече', 'send', 2 * hr], ['Задача выполнена', 'Отчёт по проекту', 'ok', 30 * min]]) {
        d.feed.unshift({ id: nextId(), text, sub, type, time: t0 - ago });
      }
    }
    const ensureSeeded = (uid) => { if (!state.data[uid]) seed(uid); };

    /* ---------- Тарифы ---------- */
    const planIdOf = (uid) => { const s = state.subs[uid]; return s && s.plan !== 'start' && s.periodEnd > now() ? s.plan : 'start'; };
    const planOf = (uid) => PLANS[planIdOf(uid)];
    const enabledCount = (uid) => dataOf(uid).autos.filter(a => a.on).length;

    function syncPlan(uid) {
      const sub = state.subs[uid];
      if (!sub) return;
      if (sub.plan !== 'start' && sub.periodEnd <= now()) {
        state.subs[uid] = { plan: 'start', periodEnd: 0 };
        addNote(uid, `Срок тарифа «${PLANS[sub.plan].name}» закончился. Вы на тарифе «Старт»`, 'bell');
        addFeed(uid, 'Тариф закончился', 'Теперь «Старт»', 'bell');
      }
      const limit = planOf(uid).automations;
      if (enabledCount(uid) > limit) {
        const keep = dataOf(uid).autos.filter(a => a.on).sort((a, b) => a.created - b.created || a.id - b.id);
        const extra = keep.slice(limit);
        extra.forEach(a => { a.on = false; });
        if (extra.length) addNote(uid, `Тариф изменился: ${extra.length} автоматизаций приостановлено (доступно ${limit}). Остальные можно включить после смены тарифа`, 'bell');
      }
    }
    function planSummary(uid) {
      const p = planOf(uid), s = state.subs[uid], active = p.id !== 'start';
      return { id: p.id, name: p.name, price: p.price, periodEnd: active ? s.periodEnd : 0,
        limits: { automations: p.automations, telegramNotify: p.telegramNotify }, usage: { automations: enabledCount(uid) } };
    }
    function planLimitError(uid, field) {
      const p = planOf(uid), n = p.automations, last = n % 10, teen = n % 100 >= 11 && n % 100 <= 14;
      const what = last === 1 && !teen ? 'активная автоматизация' : last >= 2 && last <= 4 && !teen ? 'активные автоматизации' : 'активных автоматизаций';
      return new ApiError(402, 'plan_limit', { fields: { [field]: `На тарифе «${p.name}» доступно ${n} ${what}. Перейдите на другой тариф в разделе «Тариф».` } });
    }

    /* ---------- Telegram (имитация) ---------- */
    function telegramMessage(text) { pushInbox({ kind: 'telegram', to: '@demo_user', subject: 'Telegram', text }); }
    function settleTelegram(uid) {                          // «подтверждение в Telegram» наступает через пару секунд после создания ссылки
      const d = dataOf(uid);
      if (d.tg.pending && now() >= d.tg.pending.linkAt && now() < d.tg.pending.expiresAt) {
        d.tg = { on: true, username: 'demo_user', since: now(), pending: null };
        addFeed(uid, 'Telegram-бот подключён', '@demo_user', 'tg');
        addNote(uid, 'Telegram-бот подключён. Теперь уведомления будут приходить в чат', 'tg');
        telegramMessage('✅ Готово! Чат подключён к аккаунту.\n\n/tasks — активные задачи\n/add текст — добавить задачу\n/stop — отключить чат');
      } else if (d.tg.pending && now() >= d.tg.pending.expiresAt) d.tg.pending = null;
    }
    const tgStatus = (uid) => { const t = dataOf(uid).tg; return { configured: true, bot: botName, on: !!t.on, username: t.on ? t.username : '', since: t.on ? t.since : 0 }; };

    /* ---------- Автоматизации ---------- */
    function runAutomation(uid, a, context) {
      a.runs++;
      const d = dataOf(uid);
      d.runs.total++; d.runs.ok++;
      switch (a.action) {
        case 'Создать задачу':
          if (d.tasks.length < LIMITS.tasks) insTask(d, `Задача от «${a.name}»`.slice(0, 120), 'mid', null, false, null, now());
          break;
        case 'Отправить уведомление в Telegram':
          if (!planOf(uid).telegramNotify) { addNote(uid, `«${a.name}» сработала. Уведомления в Telegram доступны на тарифе «Про»`, 'bell'); break; }
          if (d.tg.on && d.prefs.tg) { telegramMessage(`⚡ Автоматизация «${a.name}»\n${context}`); addNote(uid, `Telegram: «${a.name}» сработала`, 'tg'); }
          else addNote(uid, `«${a.name}» сработала. Telegram не подключён или отключён в настройках, уведомление осталось здесь`, 'bell');
          break;
        case 'Отправить email':
          addNote(uid, `Email-уведомление: «${a.name}» (в демо-режиме письмо не отправляется)`, 'send');
          break;
        default: break;
      }
      addFeed(uid, 'Автоматизация выполнена', a.name, 'auto');
    }
    const fireTrigger = (uid, trigger, context) => dataOf(uid).autos.filter(a => a.on && a.trigger === trigger).sort((x, y) => x.id - y.id).forEach(a => runAutomation(uid, a, context));

    /* ---------- Кабинет ---------- */
    function dashboard(uid, tzIn) {
      ensureSeeded(uid); syncPlan(uid); settleTelegram(uid);
      const d = dataOf(uid);
      const tz = Math.max(-840, Math.min(840, Number.isFinite(tzIn) ? Math.trunc(tzIn) : 0));
      const nowLocal = now() - tz * 60000;
      const dayIdx = (new Date(nowLocal).getUTCDay() + 6) % 7;
      const weekStartLocal = Math.floor(nowLocal / DAY) * DAY - dayIdx * DAY;
      const week = [0, 0, 0, 0, 0, 0, 0];
      for (const t of d.tasks) {
        if (!t.done || t.doneAt == null || t.doneAt < weekStartLocal + tz * 60000) continue;
        const i = Math.floor((t.doneAt - tz * 60000 - weekStartLocal) / DAY);
        if (i >= 0 && i < 7) week[i]++;
      }
      return {
        tasks: [...d.tasks].sort((a, b) => b.created - a.created || b.id - a.id).map(t => ({ id: String(t.id), title: t.title, prio: t.prio, due: t.due || '', done: !!t.done, created: t.created })),
        autos: [...d.autos].sort((a, b) => b.created - a.created || b.id - a.id).map(a => ({ id: String(a.id), name: a.name, trigger: a.trigger, action: a.action, on: !!a.on, runs: a.runs })),
        notes: [...d.notes].sort((a, b) => b.id - a.id).map(n => ({ id: String(n.id), text: n.text, type: n.type, read: !!n.read, time: n.time })),
        feed: [...d.feed].sort((a, b) => b.id - a.id).slice(0, 30).map(f => ({ id: String(f.id), text: f.text, sub: f.sub, type: f.type, time: f.time })),
        week, plan: planSummary(uid), runs: { ok: d.runs.ok, total: d.runs.total }, prefs: { tg: !!d.prefs.tg, email: !!d.prefs.email },
        tg: tgStatus(uid),
      };
    }

    function createTask(uid, body) {
      const title = cleanText(body.title, 'title', 'Название', 1, 120);
      const prio = body.prio === undefined ? 'mid' : oneOf(body.prio, PRIORITIES, 'prio', 'Приоритет');
      const due = cleanDue(body.due);
      ensureSeeded(uid); syncPlan(uid);
      const d = dataOf(uid);
      if (d.tasks.length >= LIMITS.tasks) throw new ApiError(409, 'limit_reached', { fields: { title: `Достигнут предел: ${LIMITS.tasks} задач. Удалите ненужные.` } });
      insTask(d, title, prio, due, false, null, now());
      addFeed(uid, 'Новая задача создана', title, 'task');
      addNote(uid, `Новая задача: ${title}`, 'task');
      fireTrigger(uid, 'Новая задача создана', `Новая задача: «${title}»`);
    }
    function setTaskDone(uid, id, body) {
      const done = bool(body.done, 'done');
      const t = dataOf(uid).tasks.find(x => x.id === id);
      if (!t) throw notFound();
      if (!!t.done === done) return;
      syncPlan(uid);
      t.done = done; t.doneAt = done ? now() : null;
      if (done) {
        addFeed(uid, 'Задача выполнена', t.title, 'ok');
        addNote(uid, `Задача выполнена: ${t.title}`, 'ok');
        fireTrigger(uid, 'Задача выполнена', `Выполнено: «${t.title}»`);
      }
    }
    function deleteTask(uid, id) {
      const d = dataOf(uid), i = d.tasks.findIndex(x => x.id === id);
      if (i < 0) throw notFound();
      d.tasks.splice(i, 1);
    }
    function createAuto(uid, body) {
      const name = cleanText(body.name, 'name', 'Название', 3, 60);
      const trigger = oneOf(body.trigger, TRIGGERS, 'trigger', 'Триггер');
      const action = oneOf(body.action, ACTIONS, 'action', 'Действие');
      ensureSeeded(uid); syncPlan(uid);
      const d = dataOf(uid);
      if (enabledCount(uid) >= planOf(uid).automations) throw planLimitError(uid, 'name');
      if (d.autos.length >= LIMITS.automations) throw new ApiError(409, 'limit_reached', { fields: { name: `Достигнут предел: ${LIMITS.automations} автоматизаций.` } });
      insAuto(d, name, trigger, action, true, 0, now());
      addFeed(uid, 'Автоматизация создана', name, 'auto');
    }
    function setAutoEnabled(uid, id, body) {
      const enabled = bool(body.enabled, 'enabled');
      const a = dataOf(uid).autos.find(x => x.id === id);
      if (!a) throw notFound();
      syncPlan(uid);
      if (enabled && !a.on && enabledCount(uid) >= planOf(uid).automations) throw planLimitError(uid, 'enabled');
      a.on = enabled;
    }
    function deleteAuto(uid, id) {
      const d = dataOf(uid), i = d.autos.findIndex(x => x.id === id);
      if (i < 0) throw notFound();
      d.autos.splice(i, 1);
    }
    function runAuto(uid, id) {
      const a = dataOf(uid).autos.find(x => x.id === id);
      if (!a) throw notFound();
      syncPlan(uid);
      runAutomation(uid, a, 'Ручной запуск');
      return a.name;
    }
    function setNoteRead(uid, id, body) {
      const read = bool(body.read, 'read');
      const n = dataOf(uid).notes.find(x => x.id === id);
      if (!n) throw notFound();
      n.read = read;
    }
    function testTelegram(uid) {
      ensureSeeded(uid);
      const d = dataOf(uid);
      if (!d.tg.on) throw new ApiError(409, 'telegram_not_connected');
      if (!d.prefs.tg) throw new ApiError(409, 'telegram_disabled');
      telegramMessage('✅ Тестовое сообщение от AutoFlow. Уведомления работают!');
      addNote(uid, 'Тестовое сообщение отправлено в Telegram', 'tg');
      addFeed(uid, 'Уведомление отправлено', 'Тест Telegram', 'send');
    }
    function setPrefs(uid, body) {
      ensureSeeded(uid);
      const d = dataOf(uid);
      if (body.tg === undefined && body.email === undefined) throw bad('prefs', 'Нечего сохранять');
      const tg = body.tg === undefined ? !!d.prefs.tg : bool(body.tg, 'tg');
      const email = body.email === undefined ? !!d.prefs.email : bool(body.email, 'email');
      d.prefs = { tg, email };
    }
    function connectTelegram(uid) {
      ensureSeeded(uid);
      const d = dataOf(uid);
      if (d.tg.on) throw new ApiError(409, 'already_linked');
      const code = b64url(randBytes(16));
      d.tg.pending = { code, expiresAt: now() + 10 * MIN, linkAt: now() + 2500 };
      return { code, link: `https://t.me/${botName}?start=${code}`, expiresAt: d.tg.pending.expiresAt, bot: botName };
    }
    function disconnectTelegram(uid) {
      ensureSeeded(uid);
      const d = dataOf(uid);
      d.tg.pending = null;
      if (!d.tg.on) return;
      d.tg = { on: false, username: '', since: 0, pending: null };
      addFeed(uid, 'Telegram-бот отключён', '', 'tg');
      telegramMessage('Этот чат отключён от AutoFlow. Чтобы подключить снова: Настройки → Telegram.');
    }

    /* ---------- Оплата (демо) ---------- */
    const orderView = (o) => {
      const expiresAt = o.createdAt + ORDER_TTL_MIN * MIN, expired = o.status === 'pending' && expiresAt <= now();
      return { id: o.id, plan: o.plan, planName: PLANS[o.plan].name, amount: o.amount, currency: o.currency, status: expired ? 'expired' : o.status, createdAt: o.createdAt, paidAt: o.paidAt || 0, expiresAt };
    };
    const ownOrder = (uid, id) => { const o = typeof id === 'string' ? state.orders.find(x => x.id === id && x.userId === uid) : null; if (!o) throw notFound(); return o; };
    function billingOverview(uid) {
      ensureSeeded(uid); syncPlan(uid);
      return {
        mode: paymentsMode,
        catalog: Object.values(PLANS).map(p => ({ id: p.id, name: p.name, price: p.price, currency: CURRENCY, limits: { automations: p.automations, telegramNotify: p.telegramNotify } })),
        plan: planSummary(uid),
        orders: state.orders.filter(o => o.userId === uid && o.status !== 'canceled').sort((a, b) => b.seq - a.seq).slice(0, 20).map(orderView),
      };
    }
    function checkout(uid, body) {
      if (paymentsMode === 'off') throw new ApiError(503, 'payments_disabled');
      const planId = body && body.plan;
      if (typeof planId !== 'string' || !PAID_PLANS.includes(planId)) throw new ApiError(400, 'validation', { fields: { plan: 'Выберите тариф «Про» или «Бизнес»' } });
      ensureSeeded(uid); syncPlan(uid);
      if (PLANS[planId].rank < PLANS[planIdOf(uid)].rank) throw new ApiError(409, 'plan_downgrade', { fields: { plan: 'У вас уже действует более высокий тариф. Понизить его можно после окончания периода.' } });
      state.orders.forEach(o => { if (o.userId === uid && o.status === 'pending') o.status = 'canceled'; });
      const o = { id: b64url(randBytes(16)), seq: nextId(), userId: uid, plan: planId, amount: PLANS[planId].price, currency: CURRENCY, status: 'pending', createdAt: now(), paidAt: 0 };
      state.orders.push(o);
      return { order: orderView(o), url: `/checkout?order=${o.id}` };
    }
    function payDemo(uid, id) {
      if (paymentsMode !== 'demo') throw new ApiError(403, 'demo_disabled');
      const o = ownOrder(uid, id), status = orderView(o).status;
      if (status === 'paid') throw new ApiError(409, 'already_paid');
      if (status === 'canceled') throw new ApiError(409, 'order_canceled');
      if (status === 'expired') throw new ApiError(410, 'order_expired');
      o.status = 'paid'; o.paidAt = now();
      const sub = state.subs[uid], t = now();
      const end = sub && sub.plan === o.plan && sub.periodEnd > t ? sub.periodEnd + PERIOD_DAYS * DAY : t + PERIOD_DAYS * DAY;
      state.subs[uid] = { plan: o.plan, periodEnd: end };
      ensureSeeded(uid);
      addFeed(uid, `Тариф «${PLANS[o.plan].name}» активирован`, `до ${fmtDate(end)}`, 'ok');
      addNote(uid, `Тариф «${PLANS[o.plan].name}» активирован до ${fmtDate(end)}`, 'ok');
      return orderView(o);
    }

    /* ---------- Маршруты /api/* ---------- */
    async function route(method, rawUrl, body) {
      const url = new URL(rawUrl, 'http://demo.local');
      const p = url.pathname;
      const ok = (status, b) => ({ status, body: b });

      // --- публичные ---
      if (method === 'POST' && p === '/api/register') {
        const { value, errors } = validateRegister(body);
        if (Object.keys(errors).length) throw new ApiError(400, 'validation', { fields: errors });
        if (state.byEmail[value.email]) throw new ApiError(409, 'email_taken', { fields: { email: 'Этот email уже зарегистрирован' } });
        const salt = hex(randBytes(16));
        const u = { id: nextId(), publicId: hex(randBytes(8)), name: value.name, email: value.email, phone: value.phone, salt, passHash: await hashPassword(value.password, salt), verified: false, createdAt: now() };
        state.users[u.id] = u; state.byEmail[u.email] = u.id;
        const csrf = startSession(u);
        sendMail(u.id, 'verify');
        return ok(201, { user: publicUser(u), csrf });
      }
      if (method === 'POST' && p === '/api/login') {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
        const password = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
        const failKey = `login:fail:${email}`;
        if (countHits(failKey, 15 * MIN) >= 5) throw tooMany(failKey, 15 * MIN);
        const u = email && password && state.byEmail[email] ? userById(state.byEmail[email]) : null;
        const pass = u ? (await hashPassword(password, u.salt)) === u.passHash : false;
        if (!pass) { hit(failKey, 15 * MIN); throw new ApiError(401, 'invalid_credentials'); }
        hits[failKey] = [];
        return ok(200, { user: publicUser(u), csrf: startSession(u) });
      }
      if (method === 'GET' && p === '/api/session') {
        const u = currentUser();
        return ok(200, u ? { user: publicUser(u), csrf: state.session.csrf } : { user: null });
      }
      if (method === 'POST' && p === '/api/forgot-password') {
        const email = cleanEmail(body.email);
        if (checks.email(email)) throw new ApiError(400, 'validation', { fields: { email: 'Введите корректный email' } });
        const uid = hit(`forgot:email:${email}`, HOUR) <= 3 ? state.byEmail[email] : null;
        if (uid) sendMail(uid, 'reset');
        return ok(200, { ok: true });
      }
      if (method === 'POST' && (p === '/api/reset-password/check' || p === '/api/reset-password')) {
        if (p.endsWith('/check')) return ok(200, { valid: checkToken(body.token, 'reset') });
        const badPw = checks.password(body.password);
        if (badPw) throw new ApiError(400, 'validation', { fields: { password: badPw } });
        const uid = consumeToken(body.token, 'reset');
        if (!uid) throw new ApiError(400, 'invalid_token');
        const u = userById(uid);
        u.salt = hex(randBytes(16)); u.passHash = await hashPassword(body.password, u.salt); u.verified = true;
        if (state.session && state.session.userId === uid) state.session = null;     // все сессии завершаются
        return ok(200, { ok: true });
      }
      if (method === 'POST' && p === '/api/verify-email') {
        const uid = consumeToken(body.token, 'verify');
        if (!uid) throw new ApiError(400, 'invalid_token');
        userById(uid).verified = true;
        return ok(200, { ok: true });
      }
      if (method === 'POST' && p === '/api/contact') {
        if (hit('contact', HOUR) > 5) throw tooMany('contact', HOUR);
        if (typeof body.website === 'string' && body.website.trim()) return ok(201, { ok: true });
        const { value, errors } = validateContact(body);
        if (Object.keys(errors).length) throw new ApiError(400, 'validation', { fields: errors });
        state.contact.push({ ...value, time: now() });
        return ok(201, { ok: true });
      }

      // --- только с сессией ---
      const me = currentUser();
      if (!me) throw new ApiError(401, 'unauthorized');
      const uid = me.id;

      if (method === 'GET' && p === '/api/me') return ok(200, { user: publicUser(me), csrf: state.session.csrf });
      if (method === 'PATCH' && p === '/api/me') {
        const { value, errors } = validateProfile(body);
        if (Object.keys(errors).length) throw new ApiError(400, 'validation', { fields: errors });
        me.name = value.name; me.phone = value.phone;
        return ok(200, { user: publicUser(me) });
      }
      if (method === 'POST' && p === '/api/verify-email/send') {
        if (me.verified) return ok(200, { ok: true, alreadyVerified: true });
        if (hit(`vsend:${uid}`, HOUR) > 3) throw tooMany(`vsend:${uid}`, HOUR);
        sendMail(uid, 'verify');
        return ok(200, { ok: true });
      }
      if (method === 'POST' && p === '/api/change-password') {
        if (hit(`chpw:${uid}`, HOUR) > 10) throw tooMany(`chpw:${uid}`, HOUR);
        const current = typeof body.current === 'string' && (await hashPassword(body.current.slice(0, 128), me.salt)) === me.passHash;
        if (!current) throw new ApiError(403, 'invalid_password', { fields: { current: 'Неверный текущий пароль' } });
        const badPw = checks.password(body.password);
        if (badPw) throw new ApiError(400, 'validation', { fields: { password: badPw } });
        me.salt = hex(randBytes(16)); me.passHash = await hashPassword(body.password, me.salt);
        ensureSeeded(uid);
        addFeed(uid, 'Пароль изменён', 'Остальные устройства вышли из аккаунта', 'ok');
        return ok(200, { ok: true });
      }

      const tzNum = parseInt(url.searchParams.get('tz'), 10);
      const tz = Number.isFinite(tzNum) ? tzNum : 0;
      const fresh = (extra) => ok(200, { dashboard: dashboard(uid, tz), ...(extra || {}) });
      let m;

      if (method === 'GET' && p === '/api/dashboard') return fresh();

      if (method === 'GET' && p === '/api/billing') return ok(200, billingOverview(uid));
      if (method === 'POST' && p === '/api/billing/checkout') { if (hit(`checkout:${uid}`, HOUR) > 10) throw tooMany(`checkout:${uid}`, HOUR); return ok(200, checkout(uid, body)); }
      if ((m = p.match(/^\/api\/billing\/orders\/([A-Za-z0-9_-]{16,40})(\/pay|\/cancel)?$/))) {
        if (method === 'GET' && !m[2]) return ok(200, { order: orderView(ownOrder(uid, m[1])) });
        if (method === 'POST' && m[2] === '/pay') { const order = payDemo(uid, m[1]); return ok(200, { order, billing: billingOverview(uid) }); }
        if (method === 'POST' && m[2] === '/cancel') { const o = ownOrder(uid, m[1]); if (o.status === 'pending') o.status = 'canceled'; return ok(200, { order: orderView(o) }); }
      }

      if (method === 'POST' && p === '/api/tasks') { createTask(uid, body); return fresh(); }
      if ((m = p.match(/^\/api\/tasks\/(\d{1,15})$/))) {
        if (method === 'PATCH') { ensureSeeded(uid); setTaskDone(uid, Number(m[1]), body); return fresh(); }
        if (method === 'DELETE') { ensureSeeded(uid); deleteTask(uid, Number(m[1])); return fresh(); }
      }
      if (method === 'POST' && p === '/api/automations') { createAuto(uid, body); return fresh(); }
      if ((m = p.match(/^\/api\/automations\/(\d{1,15})$/))) {
        if (method === 'PATCH') { ensureSeeded(uid); setAutoEnabled(uid, Number(m[1]), body); return fresh(); }
        if (method === 'DELETE') { ensureSeeded(uid); deleteAuto(uid, Number(m[1])); return fresh(); }
      }
      if (method === 'POST' && (m = p.match(/^\/api\/automations\/(\d{1,15})\/run$/))) { ensureSeeded(uid); const name = runAuto(uid, Number(m[1])); return fresh({ name }); }

      if (method === 'POST' && p === '/api/notifications/read-all') { ensureSeeded(uid); dataOf(uid).notes.forEach(n => { n.read = true; }); return fresh(); }
      if (method === 'DELETE' && p === '/api/notifications') { ensureSeeded(uid); dataOf(uid).notes = []; return fresh(); }
      if (method === 'PATCH' && (m = p.match(/^\/api\/notifications\/(\d{1,15})$/))) { ensureSeeded(uid); setNoteRead(uid, Number(m[1]), body); return fresh(); }

      if (method === 'POST' && p === '/api/telegram/connect') { if (hit(`tglink:${uid}`, HOUR) > 10) throw tooMany(`tglink:${uid}`, HOUR); const pending = connectTelegram(uid); return fresh({ pending }); }
      if (method === 'POST' && p === '/api/telegram/disconnect') { disconnectTelegram(uid); return fresh(); }
      if (method === 'POST' && p === '/api/telegram/test') { testTelegram(uid); return fresh(); }
      if (method === 'PATCH' && p === '/api/prefs') { setPrefs(uid, body); return fresh(); }
      if (method === 'POST' && p === '/api/demo/reset') {
        if (hit(`reset-demo:${uid}`, HOUR) > 10) throw tooMany(`reset-demo:${uid}`, HOUR);
        ensureSeeded(uid);
        const keep = dataOf(uid).tg;
        seed(uid, keep);
        return fresh();
      }
      if (method === 'POST' && p === '/api/logout') { state.session = null; return ok(200, { ok: true }); }
      if (method === 'DELETE' && p === '/api/me') {
        if (hit(`del:${uid}`, HOUR) > 5) throw tooMany(`del:${uid}`, HOUR);
        const good = typeof body.password === 'string' && (await hashPassword(body.password.slice(0, 128), me.salt)) === me.passHash;
        if (!good) throw new ApiError(403, 'invalid_password');
        deleteUserData(uid);
        return ok(200, { ok: true });
      }
      throw notFound();
    }

    /* ---------- Точка входа: запрос → ответ, с откатом при ошибке (как транзакция) ---------- */
    async function handle(method, rawUrl, body) {
      const snapshot = JSON.stringify(state);
      try {
        const r = await route(String(method).toUpperCase(), rawUrl, body && typeof body === 'object' && !Array.isArray(body) ? body : (body === undefined ? {} : { __invalid: true }));
        save();
        return r;
      } catch (e) {
        if (e instanceof ApiError) {
          state = JSON.parse(snapshot);
          save();
          return { status: e.status, body: { error: e.code, ...(e.extra || {}) } };
        }
        state = JSON.parse(snapshot);
        throw e;
      }
    }

    return {
      handle,
      inbox: () => state.inbox,
      markInboxRead: () => { state.inbox.forEach(x => { x.read = true; }); save(); },
      clearInbox: () => { state.inbox = []; save(); },
      resetAll: () => { state = fresh(); save(); },
      state: () => state,
    };
  }

  root.AutoFlowDemoEngine = { createEngine, TRIGGERS, ACTIONS, LIMITS };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/* ==========================================================
   Демо-версия: подключение «сервера в браузере» к страницам.
   • перехватывает запросы fetch('/api/...') и отвечает на них из engine.js;
   • подменяет afUrl(), чтобы переходы вели на login.html, dashboard.html и т.д.;
   • показывает окно «Демо-почта»: письма и сообщения Telegram, которые на настоящем сервере ушли бы наружу;
   • показывает плашку «Демо» со ссылкой на исходный код.
   ========================================================== */
(function () {
  'use strict';
  const CFG = {"repoUrl":"","paymentsMode":"demo"};
  const ROUTES = {"/":"index.html","/login":"login.html","/register":"register.html","/dashboard":"dashboard.html","/forgot-password":"forgot-password.html","/reset-password":"reset-password.html","/verify-email":"verify-email.html","/terms":"terms.html","/privacy":"privacy.html","/checkout":"checkout.html"};

  window.afUrl = function (p) {
    const m = String(p).match(/^(\/[^?#]*)([?#].*)?$/);
    if (!m || !Object.prototype.hasOwnProperty.call(ROUTES, m[1])) return p;
    return ROUTES[m[1]] + (m[2] || '');
  };

  // localStorage может быть недоступен (приватный режим, запрет cookies): тогда демо работает в памяти страницы
  const memory = {};
  const storage = (() => {
    try { const k = '__af_probe__'; window.localStorage.setItem(k, '1'); window.localStorage.removeItem(k); return window.localStorage; }
    catch (_) { return { getItem: (k) => (k in memory ? memory[k] : null), setItem: (k, v) => { memory[k] = String(v); }, removeItem: (k) => { delete memory[k]; } }; }
  })();

  const engine = window.AutoFlowDemoEngine.createEngine({
    storage,
    paymentsMode: CFG.paymentsMode || 'demo',
    makeLink: (page, token) => new URL(`${page}.html#token=${token}`, location.href).href,
  });

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^\/api\//.test(url)) return realFetch ? realFetch(input, init) : Promise.reject(new Error('fetch недоступен'));
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    let body;
    if (typeof init.body === 'string' && init.body) { try { body = JSON.parse(init.body); } catch (_) { body = { __invalid: true }; } }
    await sleep(30 + Math.random() * 70);                  // небольшая задержка, как у сети
    const r = await engine.handle(method, url, body);
    refreshInbox();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };

  /* ---------- Окно «Демо-почта» ---------- */
  let btn, badge, panel, list;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (t) => { const s = Math.floor((Date.now() - t) / 1000); return s < 60 ? 'только что' : s < 3600 ? `${Math.floor(s / 60)} мин назад` : new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };

  function render() {
    if (!list) return;
    const items = engine.inbox();
    list.textContent = '';
    if (!items.length) { list.appendChild(el('p', 'af-empty', 'Пока пусто. Зарегистрируйтесь или запросите сброс пароля, и письмо появится здесь.')); return; }
    for (const m of items) {
      const card = el('article', `af-msg af-msg--${m.kind}${m.read ? '' : ' af-new'}`);
      const head = el('header');
      head.appendChild(el('strong', '', m.kind === 'telegram' ? '✈ Telegram-бот' : `✉ ${m.subject}`));
      head.appendChild(el('time', '', ago(m.time)));
      card.appendChild(head);
      if (m.kind === 'mail') card.appendChild(el('small', '', `Кому: ${m.to}`));
      card.appendChild(el('p', '', m.text));
      if (m.link) { const a = el('a', 'af-link', m.linkText + ' →'); a.href = m.link; card.appendChild(a); }
      list.appendChild(card);
    }
  }
  function refreshInbox() {
    if (!btn) return;
    const unread = engine.inbox().filter(m => !m.read).length;
    badge.textContent = unread; badge.hidden = !unread;
    btn.classList.toggle('af-pulse', unread > 0);
    if (!panel.hidden) render();
  }
  function openPanel(open) {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { render(); engine.markInboxRead(); refreshInbox(); }
  }

  function mount() {
    btn = el('button', 'af-mail-btn'); btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Демо-почта');
    btn.appendChild(el('span', '', '✉ Демо-почта'));
    badge = el('b', 'af-badge', '0'); badge.hidden = true; btn.appendChild(badge);
    btn.addEventListener('click', () => openPanel(panel.hidden));

    panel = el('section', 'af-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Демо-почта и Telegram');
    const head = el('header', 'af-panel__head');
    head.appendChild(el('strong', '', 'Демо-почта и Telegram'));
    const close = el('button', 'af-x', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Закрыть'); close.addEventListener('click', () => openPanel(false));
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('p', 'af-hint', 'Письма и сообщения никуда не отправляются: здесь видно, что получил бы пользователь. На настоящем сервере они уходят на почту и в Telegram.'));
    list = el('div', 'af-list'); panel.appendChild(list);
    const foot = el('footer', 'af-panel__foot');
    const clear = el('button', 'af-btn', 'Очистить'); clear.type = 'button';
    clear.addEventListener('click', () => { engine.clearInbox(); refreshInbox(); render(); });
    const reset = el('button', 'af-btn af-btn--danger', 'Сбросить все демо-данные'); reset.type = 'button';
    reset.addEventListener('click', () => { if (confirm('Удалить все аккаунты и данные демо в этом браузере?')) { engine.resetAll(); location.href = window.afUrl('/'); } });
    foot.appendChild(clear); foot.appendChild(reset); panel.appendChild(foot);

    const pill = el('div', 'af-pill');
    pill.appendChild(el('span', '', 'Демо-версия · данные в вашем браузере'));
    if (CFG.repoUrl) { const a = el('a', '', 'Исходный код →'); a.href = CFG.repoUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; pill.appendChild(a); }

    const dock = el('div', 'af-dock');          // правый нижний угол: слева плашка, справа кнопка почты (левый угол занят меню кабинета)
    dock.append(pill, btn);
    document.body.append(dock, panel);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) openPanel(false); });
    refreshInbox();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();

})();
