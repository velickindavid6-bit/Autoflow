import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { PLANS } from './plans.js';

/* ==========================================================
   Данные кабинета: задачи, автоматизации, уведомления, журнал.

   ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ: каждая функция получает userId
   из серверной сессии и добавляет «AND user_id = ?» в любой
   запрос. Идентификатор владельца никогда не берётся из запроса,
   а чужая запись выглядит как несуществующая (404).
   ========================================================== */

export const TRIGGERS = ['Новая задача создана', 'Задача выполнена', 'Каждый день в 09:00', 'Приходит новое письмо'];
export const ACTIONS = ['Отправить уведомление в Telegram', 'Создать задачу', 'Отправить email', 'Записать в журнал'];
export const PRIORITIES = ['low', 'mid', 'high'];
export const LIMITS = { tasks: 1000, automations: 200, notes: 100, feed: 100 };   // automations: всего (включая выключенные), активных ограничивает тариф

const DAY = 86400000;
const bad = (field, message) => new HttpError(400, 'validation', { fields: { [field]: message } });
const notFound = () => new HttpError(404, 'not_found');

/* ---------- Проверка входных данных ---------- */
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
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) {
    throw bad('due', 'Срок: такой даты не существует');
  }
  return v;
}

const oneOf = (v, list, field, label) => {
  if (typeof v !== 'string' || !list.includes(v)) throw bad(field, `${label}: недопустимое значение`);
  return v;
};
const bool = (v, field) => {
  if (typeof v !== 'boolean') throw bad(field, 'Ожидается true или false');
  return v;
};

export function createData(db, config = { limits: {} }) {
  const q = {
    countTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?'),
    countAutos: db.prepare('SELECT COUNT(*) AS n FROM automations WHERE user_id = ?'),
    countEnabled: db.prepare('SELECT COUNT(*) AS n FROM automations WHERE user_id = ? AND enabled = 1'),
    getSub: db.prepare('SELECT plan, period_end FROM subscriptions WHERE user_id = ?'),
    resetSub: db.prepare("UPDATE subscriptions SET plan = 'start', period_end = 0, updated_at = ? WHERE user_id = ?"),
    disableExtra: db.prepare('UPDATE automations SET enabled = 0 WHERE id IN (SELECT id FROM automations WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC, id ASC LIMIT -1 OFFSET ?)'),
    tasks: db.prepare('SELECT id, title, prio, due, done, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
    autos: db.prepare('SELECT id, name, trigger_type, action_type, enabled, runs FROM automations WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
    notes: db.prepare('SELECT id, text, type, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC'),
    feed: db.prepare('SELECT id, text, sub, type, created_at FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT 30'),
    doneSince: db.prepare('SELECT done_at FROM tasks WHERE user_id = ? AND done = 1 AND done_at >= ?'),
    state: db.prepare('SELECT * FROM user_state WHERE user_id = ?'),
    insState: db.prepare('INSERT OR IGNORE INTO user_state (user_id, runs_ok, runs_total) VALUES (?, ?, ?)'),

    insTask: db.prepare('INSERT INTO tasks (user_id, title, prio, due, done, done_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getTask: db.prepare('SELECT id, title, done FROM tasks WHERE id = ? AND user_id = ?'),
    setTaskDone: db.prepare('UPDATE tasks SET done = ?, done_at = ? WHERE id = ? AND user_id = ?'),
    delTask: db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?'),

    insAuto: db.prepare('INSERT INTO automations (user_id, name, trigger_type, action_type, enabled, runs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getAuto: db.prepare('SELECT id, name, trigger_type, action_type, enabled FROM automations WHERE id = ? AND user_id = ?'),
    autosByTrigger: db.prepare('SELECT id, name, trigger_type, action_type, enabled FROM automations WHERE user_id = ? AND enabled = 1 AND trigger_type = ? ORDER BY id'),
    setAutoEnabled: db.prepare('UPDATE automations SET enabled = ? WHERE id = ? AND user_id = ?'),
    bumpRuns: db.prepare('UPDATE automations SET runs = runs + 1 WHERE id = ? AND user_id = ?'),
    delAuto: db.prepare('DELETE FROM automations WHERE id = ? AND user_id = ?'),

    insNote: db.prepare('INSERT INTO notifications (user_id, text, type, read, created_at) VALUES (?, ?, ?, 0, ?)'),
    trimNotes: db.prepare(`DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ${LIMITS.notes})`),
    setNoteRead: db.prepare('UPDATE notifications SET read = ? WHERE id = ? AND user_id = ?'),
    readAll: db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?'),
    clearNotes: db.prepare('DELETE FROM notifications WHERE user_id = ?'),

    insFeed: db.prepare('INSERT INTO activity (user_id, text, sub, type, created_at) VALUES (?, ?, ?, ?, ?)'),
    trimFeed: db.prepare(`DELETE FROM activity WHERE user_id = ? AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ${LIMITS.feed})`),

    countRun: db.prepare('UPDATE user_state SET runs_total = runs_total + 1, runs_ok = runs_ok + 1 WHERE user_id = ?'),
    tgLink: db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?'),
    insOutbox: db.prepare('INSERT INTO telegram_outbox (user_id, chat_id, text, next_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    activeTasks: db.prepare('SELECT id, title FROM tasks WHERE user_id = ? AND done = 0 ORDER BY created_at DESC, id DESC LIMIT ?'),
    setPrefs: db.prepare('UPDATE user_state SET pref_tg = ?, pref_email = ? WHERE user_id = ?'),
    wipe: [
      db.prepare('DELETE FROM tasks WHERE user_id = ?'), db.prepare('DELETE FROM automations WHERE user_id = ?'),
      db.prepare('DELETE FROM notifications WHERE user_id = ?'), db.prepare('DELETE FROM activity WHERE user_id = ?'),
      db.prepare('DELETE FROM user_state WHERE user_id = ?'),
    ],
  };

  // Транзакция: либо все изменения запроса сохраняются, либо ни одно
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  /* ---------- Журнал и уведомления ---------- */
  const addFeed = (userId, text, sub, type) => {
    q.insFeed.run(userId, text, sub || '', type, Date.now());
    q.trimFeed.run(userId, userId);
  };
  const addNote = (userId, text, type) => {
    q.insNote.run(userId, text.slice(0, 300), type, Date.now());
    q.trimNotes.run(userId, userId);
  };

  /* ---------- Тариф ---------- */
  // Чтение без побочных эффектов: просроченный платный тариф считается «Стартом»
  function planIdOf(userId) {
    const sub = q.getSub.get(userId);
    return sub && sub.plan !== 'start' && sub.period_end > Date.now() ? sub.plan : 'start';
  }
  const planOf = (userId) => PLANS[planIdOf(userId)];

  // Применение истечения: возвращаем «Старт» и отключаем автоматизации сверх лимита (самые новые). Вызывается вне транзакций.
  function syncPlan(userId) {
    const sub = q.getSub.get(userId);
    if (!sub) return;
    const expired = sub.plan !== 'start' && sub.period_end <= Date.now();
    if (expired) {
      tx(() => {
        q.resetSub.run(Date.now(), userId);
        addNote(userId, `Срок тарифа «${PLANS[sub.plan].name}» закончился. Вы на тарифе «Старт»`, 'bell');
        addFeed(userId, 'Тариф закончился', `Теперь «Старт»`, 'bell');
      });
    }
    const limit = planOf(userId).automations;
    if (q.countEnabled.get(userId).n > limit) {
      tx(() => {
        const r = q.disableExtra.run(userId, limit);
        if (r.changes) addNote(userId, `Тариф изменился: ${r.changes} автоматизаций приостановлено (доступно ${limit}). Остальные можно включить после смены тарифа`, 'bell');
      });
    }
  }
  function planSummary(userId) {
    const p = planOf(userId), sub = q.getSub.get(userId);
    const active = p.id !== 'start';
    return {
      id: p.id, name: p.name, price: p.price,
      periodEnd: active ? sub.period_end : 0,
      limits: { automations: p.automations, telegramNotify: p.telegramNotify },
      usage: { automations: q.countEnabled.get(userId).n },
    };
  }
  const planLimitError = (userId, field) => {
    const p = planOf(userId);
    const n = p.automations, last = n % 10, teen = n % 100 >= 11 && n % 100 <= 14;
    const what = last === 1 && !teen ? 'активная автоматизация' : last >= 2 && last <= 4 && !teen ? 'активные автоматизации' : 'активных автоматизаций';
    return new HttpError(402, 'plan_limit', { fields: { [field]: `На тарифе «${p.name}» доступно ${n} ${what}. Перейдите на другой тариф в разделе «Тариф».` } });
  };

  /* ---------- Исходящие сообщения в Telegram ---------- */
  // Сообщение кладётся в очередь (в той же транзакции), а отправляет его фоновый обработчик бота.
  // Лимит защищает чат пользователя от потока сообщений, если правила зациклены на частых событиях.
  const sent = new Map();
  const allowTg = (userId) => {
    const cap = (config.limits && config.limits.tgMsgPer10Min) || 30, now = Date.now();
    const list = (sent.get(userId) || []).filter(t => now - t < 600000);
    if (list.length >= cap) { sent.set(userId, list); return false; }
    list.push(now); sent.set(userId, list);
    return true;
  };
  function queueTelegram(userId, text) {
    const link = q.tgLink.get(userId);
    const st = q.state.get(userId);
    if (!link || !st || !st.pref_tg) return false;
    if (!allowTg(userId)) return false;
    q.insOutbox.run(userId, link.chat_id, String(text).slice(0, 3500), Date.now(), Date.now());
    return true;
  }

  /* ---------- Образцы данных для нового аккаунта ---------- */
  function seed(userId) {
    const now = Date.now(), min = 60000, hr = 3600000;
    q.insState.run(userId, 49, 50);
    // выполненные задачи прошлых дней: график недели не пустой, а данные честные (это обычные записи)
    const done = [['Созвон с командой', 1], ['Оплатить сервер', 2], ['Составить план недели', 2], ['Разобрать входящие', 3], ['Подготовить отчёт', 4]];
    for (const [title, daysAgo] of done) {
      const t = now - daysAgo * DAY - hr;
      q.insTask.run(userId, title, 'mid', null, 1, t + 30 * min, t);
    }
    const dayStr = (off) => new Date(now + off * DAY).toISOString().slice(0, 10);
    q.insTask.run(userId, 'Отчёт по проекту', 'high', dayStr(0), 1, now - 30 * min, now - 5 * hr);
    q.insTask.run(userId, 'Проверить почту', 'mid', null, 0, null, now - 4 * hr);
    q.insTask.run(userId, 'Подготовить презентацию к встрече', 'high', dayStr(2), 0, null, now - 3 * hr);
    q.insTask.run(userId, 'Обновить портфолио', 'low', dayStr(5), 0, null, now - 2 * hr);
    q.insTask.run(userId, 'Ответить клиенту', 'mid', dayStr(-1), 0, null, now - 1 * hr);

    const autos = [
      ['Уведомлять о новых задачах', TRIGGERS[0], ACTIONS[0], 1, 12],
      ['Журнал выполненных задач', TRIGGERS[1], ACTIONS[3], 1, 23],
      ['Утренняя сводка', TRIGGERS[2], ACTIONS[2], 1, 15],
      ['Задача из письма', TRIGGERS[3], ACTIONS[1], 0, 0],
    ];
    autos.forEach(([name, trg, act, on, runs], i) => q.insAuto.run(userId, name, trg, act, on, runs, now - (autos.length - i) * hr));

    q.insNote.run(userId, 'Новая задача: Проверить почту', 'task', now - 3 * hr);
    q.insNote.run(userId, 'Напоминание: встреча в 16:00', 'bell', now - 2 * hr);
    q.insNote.run(userId, 'Задача выполнена: Отчёт по проекту', 'ok', now - 30 * min);
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND text LIKE ?').run(userId, 'Новая задача%');
    q.insFeed.run(userId, 'Новая задача создана', 'Проверить почту', 'task', now - 4 * hr);
    q.insFeed.run(userId, 'Уведомление отправлено', 'Напоминание о встрече', 'send', now - 2 * hr);
    q.insFeed.run(userId, 'Задача выполнена', 'Отчёт по проекту', 'ok', now - 30 * min);
  }
  const ensureSeeded = (userId) => {
    if (!q.state.get(userId)) tx(() => seed(userId));
  };

  /* ---------- Движок автоматизаций ---------- */
  function runAutomation(userId, a, context = 'Ручной запуск') {
    q.bumpRuns.run(a.id, userId);
    q.countRun.run(userId);
    switch (a.action_type) {
      case 'Создать задачу':
        if (q.countTasks.get(userId).n < LIMITS.tasks) q.insTask.run(userId, `Задача от «${a.name}»`.slice(0, 120), 'mid', null, 0, null, Date.now());
        break;
      case 'Отправить уведомление в Telegram':
        if (!planOf(userId).telegramNotify) {
          addNote(userId, `«${a.name}» сработала. Уведомления в Telegram доступны на тарифе «Про»`, 'bell');
          break;
        }
        if (queueTelegram(userId, `⚡ Автоматизация «${a.name}»\n${context}`)) addNote(userId, `Telegram: «${a.name}» сработала`, 'tg');
        else addNote(userId, `«${a.name}» сработала. Telegram не подключён или отключён в настройках, уведомление осталось здесь`, 'bell');
        break;
      case 'Отправить email':
        addNote(userId, `Email-уведомление: «${a.name}» (в демо-режиме письмо не отправляется)`, 'send');
        break;
      default: break;
    }
    addFeed(userId, 'Автоматизация выполнена', a.name, 'auto');
  }
  // Срабатывание по событию. Действия автоматизаций сами новых событий не порождают, поэтому цикла быть не может.
  const fireTrigger = (userId, trigger, context) => q.autosByTrigger.all(userId, trigger).forEach(a => runAutomation(userId, a, context));

  /* ---------- Чтение всего кабинета ---------- */
  function dashboard(userId, tzOffsetMin = 0) {
    ensureSeeded(userId);
    syncPlan(userId);
    const st = q.state.get(userId);
    const tz = Math.max(-840, Math.min(840, Number.isFinite(tzOffsetMin) ? Math.trunc(tzOffsetMin) : 0));

    // Неделя считается по времени пользователя (понедельник = 0). tz — как у Date.getTimezoneOffset(): UTC минус местное, в минутах
    const nowLocal = Date.now() - tz * 60000;
    const dayIdx = (new Date(nowLocal).getUTCDay() + 6) % 7;
    const weekStartLocal = Math.floor(nowLocal / DAY) * DAY - dayIdx * DAY;
    const week = [0, 0, 0, 0, 0, 0, 0];
    for (const { done_at } of q.doneSince.all(userId, weekStartLocal + tz * 60000)) {
      const i = Math.floor((done_at - tz * 60000 - weekStartLocal) / DAY);
      if (i >= 0 && i < 7) week[i]++;
    }

    return {
      tasks: q.tasks.all(userId).map(t => ({ id: String(t.id), title: t.title, prio: t.prio, due: t.due || '', done: !!t.done, created: t.created_at })),
      autos: q.autos.all(userId).map(a => ({ id: String(a.id), name: a.name, trigger: a.trigger_type, action: a.action_type, on: !!a.enabled, runs: a.runs })),
      notes: q.notes.all(userId).map(n => ({ id: String(n.id), text: n.text, type: n.type, read: !!n.read, time: n.created_at })),
      feed: q.feed.all(userId).map(f => ({ id: String(f.id), text: f.text, sub: f.sub, type: f.type, time: f.created_at })),
      week,
      plan: planSummary(userId),
      runs: { ok: st.runs_ok, total: st.runs_total },
      prefs: { tg: !!st.pref_tg, email: !!st.pref_email },
    };
  }

  /* ---------- Задачи ---------- */
  function createTask(userId, body) {
    const title = cleanText(body.title, 'title', 'Название', 1, 120);
    const prio = body.prio === undefined ? 'mid' : oneOf(body.prio, PRIORITIES, 'prio', 'Приоритет');
    const due = cleanDue(body.due);
    ensureSeeded(userId);
    syncPlan(userId);
    if (q.countTasks.get(userId).n >= LIMITS.tasks) throw new HttpError(409, 'limit_reached', { fields: { title: `Достигнут предел: ${LIMITS.tasks} задач. Удалите ненужные.` } });
    tx(() => {
      q.insTask.run(userId, title, prio, due, 0, null, Date.now());
      addFeed(userId, 'Новая задача создана', title, 'task');
      addNote(userId, `Новая задача: ${title}`, 'task');
      fireTrigger(userId, 'Новая задача создана', `Новая задача: «${title}»`);
    });
  }

  function setTaskDone(userId, id, body) {
    const done = bool(body.done, 'done');
    const t = q.getTask.get(id, userId);
    if (!t) throw notFound();
    if (!!t.done === done) return;                     // ничего не изменилось: события не дублируем
    syncPlan(userId);
    tx(() => {
      q.setTaskDone.run(done ? 1 : 0, done ? Date.now() : null, id, userId);
      if (done) {
        addFeed(userId, 'Задача выполнена', t.title, 'ok');
        addNote(userId, `Задача выполнена: ${t.title}`, 'ok');
        fireTrigger(userId, 'Задача выполнена', `Выполнено: «${t.title}»`);
      }
    });
  }

  function deleteTask(userId, id) {
    if (q.delTask.run(id, userId).changes === 0) throw notFound();
  }

  /* ---------- Автоматизации ---------- */
  function createAuto(userId, body) {
    const name = cleanText(body.name, 'name', 'Название', 3, 60);
    const trigger = oneOf(body.trigger, TRIGGERS, 'trigger', 'Триггер');
    const action = oneOf(body.action, ACTIONS, 'action', 'Действие');
    ensureSeeded(userId);
    syncPlan(userId);
    if (q.countEnabled.get(userId).n >= planOf(userId).automations) throw planLimitError(userId, 'name');
    if (q.countAutos.get(userId).n >= LIMITS.automations) throw new HttpError(409, 'limit_reached', { fields: { name: `Достигнут предел: ${LIMITS.automations} автоматизаций.` } });
    tx(() => {
      q.insAuto.run(userId, name, trigger, action, 1, 0, Date.now());
      addFeed(userId, 'Автоматизация создана', name, 'auto');
    });
  }

  function setAutoEnabled(userId, id, body) {
    const enabled = bool(body.enabled, 'enabled');
    const a = q.getAuto.get(id, userId);
    if (!a) throw notFound();
    syncPlan(userId);
    if (enabled && !a.enabled && q.countEnabled.get(userId).n >= planOf(userId).automations) throw planLimitError(userId, 'enabled');
    q.setAutoEnabled.run(enabled ? 1 : 0, id, userId);
  }

  function deleteAuto(userId, id) {
    if (q.delAuto.run(id, userId).changes === 0) throw notFound();
  }

  function runAuto(userId, id) {
    const a = q.getAuto.get(id, userId);
    if (!a) throw notFound();
    syncPlan(userId);
    tx(() => runAutomation(userId, a));
    return a.name;
  }

  /* ---------- Уведомления ---------- */
  function setNoteRead(userId, id, body) {
    const read = bool(body.read, 'read');
    if (q.setNoteRead.run(read ? 1 : 0, id, userId).changes === 0) throw notFound();
  }
  const readAllNotes = (userId) => { q.readAll.run(userId); };
  const clearNotes = (userId) => { q.clearNotes.run(userId); };

  /* ---------- Telegram и настройки ---------- */
  function testTelegram(userId) {
    ensureSeeded(userId);
    if (!q.tgLink.get(userId)) throw new HttpError(409, 'telegram_not_connected');
    tx(() => {
      if (!queueTelegram(userId, '✅ Тестовое сообщение от AutoFlow. Уведомления работают!')) throw new HttpError(409, 'telegram_disabled');
      addNote(userId, 'Тестовое сообщение отправлено в Telegram', 'tg');
      addFeed(userId, 'Уведомление отправлено', 'Тест Telegram', 'send');
    });
  }
  const listActiveTasks = (userId, limit = 10) => q.activeTasks.all(userId, limit).map(t => ({ id: t.id, title: t.title }));
  function setPrefs(userId, body) {
    ensureSeeded(userId);
    const st = q.state.get(userId);
    if (body.tg === undefined && body.email === undefined) throw bad('prefs', 'Нечего сохранять');
    const tg = body.tg === undefined ? !!st.pref_tg : bool(body.tg, 'tg');
    const email = body.email === undefined ? !!st.pref_email : bool(body.email, 'email');
    q.setPrefs.run(tg ? 1 : 0, email ? 1 : 0, userId);
  }

  function log(userId, text, sub, type) {
    ensureSeeded(userId);
    addFeed(userId, text, sub, type);
  }

  function resetDemo(userId) {
    tx(() => { q.wipe.forEach(s => s.run(userId)); seed(userId); });
  }

  return {
    dashboard, createTask, setTaskDone, deleteTask, createAuto, setAutoEnabled, deleteAuto, runAuto,
    setNoteRead, readAllNotes, clearNotes, testTelegram, setPrefs, resetDemo, log, ensureSeeded, listActiveTasks, addNote, addFeed, queueTelegram, planSummary, syncPlan, planIdOf, tx,
  };
}
