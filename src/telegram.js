import crypto from 'node:crypto';
import { HttpError } from './http.js';

/* ==========================================================
   Telegram-бот без внешних библиотек (long polling).

   Безопасность:
   • токен берётся только из .env и нигде не выводится (ошибки очищаются от него);
   • привязка чата к аккаунту: одноразовый код (хранится только хеш, живёт 10 минут)
     + обязательное подтверждение кнопкой «Да» в самом Telegram, чтобы чужая ссылка
     не привязала ваш чат к чужому аккаунту;
   • бот работает только в личных чатах и только с привязанными пользователями;
   • каждое действие над задачей проверяется на принадлежность аккаунту этого чата;
   • сообщения отправляются обычным текстом (без разметки), поэтому текст задач не может «сломать» сообщение.
   ========================================================== */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MIN = 60000;

class TgError extends Error {
  constructor(message, code = 0, retryAfter = 0) { super(message); this.code = code; this.retryAfter = retryAfter; }
}

const maskEmail = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, 1)}***@${d || ''}`; };
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const HELP = [
  'Я бот AutoFlow. Что умею:',
  '',
  '/tasks — активные задачи (кнопкой ✅ отмечаются выполненными)',
  '/add текст — добавить задачу, например: /add Купить молоко',
  '/stop — отключить этот чат от AutoFlow',
  '/help — эта подсказка',
  '',
  'Уведомления о событиях и автоматизациях приходят сюда сами.',
].join('\n');

const NOT_LINKED = 'Этот чат не подключён к аккаунту. Откройте AutoFlow → Настройки → Telegram и нажмите «Подключить».';

export function createTelegram({ db, config, data, limiter, logger = console }) {
  const cfg = config.telegram;
  const token = cfg.token;
  let enabled = false, botName = '', running = false, pollTimer = null;

  // Любой вывод очищаем от токена (он входит в адрес запросов к Telegram)
  const clean = (v) => (token ? String(v).split(token).join('***') : String(v));
  const info = (m) => logger.log(`[telegram] ${clean(m)}`);
  const warn = (m) => logger.warn(`[telegram] ${clean(m)}`);

  const q = {
    link: db.prepare('SELECT user_id, chat_id, username, linked_at FROM telegram_links WHERE user_id = ?'),
    linkByChat: db.prepare('SELECT user_id, chat_id FROM telegram_links WHERE chat_id = ?'),
    upsertLink: db.prepare('INSERT INTO telegram_links (user_id, chat_id, username, linked_at) VALUES (?, ?, ?, ?)'),
    delLink: db.prepare('DELETE FROM telegram_links WHERE user_id = ?'),
    dropCodes: db.prepare('DELETE FROM telegram_codes WHERE user_id = ?'),
    insCode: db.prepare('INSERT INTO telegram_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    codeByHash: db.prepare('SELECT user_id, expires_at, used_at FROM telegram_codes WHERE code_hash = ?'),
    useCode: db.prepare('UPDATE telegram_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id'),
    burnCode: db.prepare('UPDATE telegram_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL'),
    oldCodes: db.prepare('DELETE FROM telegram_codes WHERE expires_at < ?'),
    user: db.prepare('SELECT id, name, email FROM users WHERE id = ?'),
    due: db.prepare('SELECT id, user_id, chat_id, text, attempts FROM telegram_outbox WHERE next_at <= ? ORDER BY id LIMIT 20'),
    delOut: db.prepare('DELETE FROM telegram_outbox WHERE id = ?'),
    delOutChat: db.prepare('DELETE FROM telegram_outbox WHERE chat_id = ?'),
    defer: db.prepare('UPDATE telegram_outbox SET next_at = ? WHERE id = ?'),
    retry: db.prepare('UPDATE telegram_outbox SET attempts = ?, next_at = ? WHERE id = ?'),
    insOut: db.prepare('INSERT INTO telegram_outbox (user_id, chat_id, text, next_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    staleOut: db.prepare('DELETE FROM telegram_outbox WHERE created_at < ?'),
    getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
    setKv: db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  /* ---------- Запросы к Telegram ---------- */
  async function api(method, params = {}, timeoutMs = 15000) {
    let res;
    try {
      res = await fetch(`${cfg.apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TgError('нет связи с Telegram', 0);          // исходную ошибку не пробрасываем: в ней может быть адрес с токеном
    }
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) throw new TgError(json && json.description ? json.description : `HTTP ${res.status}`, (json && json.error_code) || res.status, json && json.parameters && json.parameters.retry_after);
    return json.result;
  }
  const reply = (chatId, text, extra = {}) =>
    api('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true, ...extra })
      .catch((e) => warn(`не удалось ответить в чат: ${e.message}`));

  /* ---------- Запуск ---------- */
  async function init() {
    if (!token) return false;
    if (!TOKEN_RE.test(token)) { warn('TELEGRAM_BOT_TOKEN выглядит неверно (ожидается вид 123456789:AAH...). Бот не запущен.'); return false; }
    try {
      const me = await api('getMe');
      botName = me.username || '';
      enabled = !!botName;
      if (enabled) info(`бот @${botName} готов к работе`);
    } catch (e) {
      warn(e.code === 401 ? 'Telegram не принял токен (401). Проверьте TELEGRAM_BOT_TOKEN. Бот не запущен.' : `не удалось связаться с Telegram: ${e.message}. Бот не запущен.`);
      enabled = false;
    }
    return enabled;
  }

  /* ---------- Привязка чата к аккаунту ---------- */
  const status = (userId) => {
    const l = q.link.get(userId);
    return { configured: enabled, bot: botName, on: !!l, username: l ? l.username || '' : '', since: l ? l.linked_at : 0 };
  };

  function startLink(userId) {
    if (!enabled) throw new HttpError(503, 'bot_not_configured');
    if (q.link.get(userId)) throw new HttpError(409, 'already_linked');
    const code = crypto.randomBytes(16).toString('base64url');            // 22 символа, подобрать нельзя
    const expiresAt = Date.now() + cfg.codeMinutes * MIN;
    q.dropCodes.run(userId);                                               // новый код отменяет прежние
    q.insCode.run(sha256(code), userId, expiresAt);
    return { code, link: `https://t.me/${botName}?start=${code}`, expiresAt, bot: botName };
  }

  function unlink(userId) {
    const l = q.link.get(userId);
    q.dropCodes.run(userId);
    if (!l) return;
    q.delLink.run(userId);
    data.log(userId, 'Telegram-бот отключён', '', 'tg');
    q.insOut.run(userId, l.chat_id, 'Этот чат отключён от AutoFlow. Чтобы подключить снова: Настройки → Telegram.', Date.now(), Date.now());
  }

  function unlinkChat(chatId) {
    const l = q.linkByChat.get(chatId);
    if (!l) return null;
    q.delLink.run(l.user_id);
    q.delOutChat.run(chatId);
    data.log(l.user_id, 'Telegram-бот отключён', 'Чат остановил бота', 'tg');
    return l.user_id;
  }

  async function requestLink(chatId, code) {
    const row = CODE_RE.test(code) ? q.codeByHash.get(sha256(code)) : null;
    if (!row || row.used_at || row.expires_at <= Date.now()) {
      return reply(chatId, 'Ссылка недействительна или устарела. Создайте новую: AutoFlow → Настройки → Telegram → Подключить.');
    }
    const existing = q.linkByChat.get(chatId);
    if (existing) {
      return reply(chatId, existing.user_id === row.user_id
        ? 'Этот чат уже подключён к вашему аккаунту. Команды: /help'
        : 'Этот Telegram уже привязан к другому аккаунту AutoFlow. Отправьте /stop, чтобы отвязать его, и повторите.');
    }
    const u = q.user.get(row.user_id);
    if (!u) return reply(chatId, 'Аккаунт не найден.');
    // Подтверждение обязательно: без него чужая ссылка привязала бы ваш чат к чужому аккаунту
    return reply(chatId, `Подключить этот чат к аккаунту ${u.name.split(' ')[0]} (${maskEmail(u.email)})?\n\nЕсли вы не создавали эту ссылку, нажмите «Нет».`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Да, подключить', callback_data: `lk:y:${code}` }, { text: '❌ Нет', callback_data: `lk:n:${code}` }]] },
    });
  }

  async function confirmLink(cb, chatId, yes, code) {
    const hash = sha256(code);
    if (!yes) {
      q.burnCode.run(Date.now(), hash);
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Отменено' }).catch(() => {});
      return reply(chatId, 'Отменено. Ссылка больше не действует.');
    }
    if (q.linkByChat.get(chatId)) {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Уже подключено' }).catch(() => {});
      return;
    }
    const used = q.useCode.get(Date.now(), hash, Date.now());               // атомарно: один код = одна привязка
    if (!used) {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ссылка устарела' }).catch(() => {});
      return reply(chatId, 'Ссылка устарела или уже использована. Создайте новую в кабинете.');
    }
    try {
      q.upsertLink.run(used.user_id, chatId, cb.from.username ? String(cb.from.username).slice(0, 64) : null, Date.now());
    } catch {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Не удалось подключить' }).catch(() => {});
      return reply(chatId, 'Не удалось подключить: аккаунт или чат уже связаны. Отправьте /stop и повторите.');
    }
    data.log(used.user_id, 'Telegram-бот подключён', cb.from.username ? `@${cb.from.username}` : '', 'tg');
    data.addNote(used.user_id, 'Telegram-бот подключён. Теперь уведомления будут приходить в чат', 'tg');
    await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Подключено ✅' }).catch(() => {});
    await reply(chatId, `✅ Готово! Чат подключён к аккаунту.\n\n${HELP}`);
  }

  /* ---------- Команды ---------- */
  const linkedUser = (chatId) => { const l = q.linkByChat.get(chatId); return l ? l.user_id : null; };

  function tasksMessage(userId) {
    const tasks = data.listActiveTasks(userId, 10);
    if (!tasks.length) return { text: 'Активных задач нет 🎉\n\nДобавить: /add текст', reply_markup: { inline_keyboard: [] } };
    return {
      text: `📋 Активные задачи (${tasks.length}):\n\n${tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')}`,
      reply_markup: { inline_keyboard: tasks.map((t, i) => [{ text: `✅ ${i + 1}. ${short(t.title, 40)}`, callback_data: `done:${t.id}` }]) },
    };
  }

  async function onCommand(chatId, from, cmd, arg) {
    switch (cmd) {
      case 'start': {
        if (arg) return requestLink(chatId, arg);
        return reply(chatId, linkedUser(chatId) ? `С возвращением!\n\n${HELP}` : `Привет! Я бот AutoFlow.\n\n${NOT_LINKED}`);
      }
      case 'help': return reply(chatId, linkedUser(chatId) ? HELP : NOT_LINKED);
      case 'stop': {
        const uid = unlinkChat(chatId);
        return reply(chatId, uid ? 'Чат отключён от AutoFlow. Уведомления приходить не будут.' : 'Чат и так не подключён.');
      }
      case 'tasks': {
        const uid = linkedUser(chatId);
        if (!uid) return reply(chatId, NOT_LINKED);
        const { text, reply_markup } = tasksMessage(uid);
        return reply(chatId, text, { reply_markup });
      }
      case 'add': {
        const uid = linkedUser(chatId);
        if (!uid) return reply(chatId, NOT_LINKED);
        if (!arg || !arg.trim()) return reply(chatId, 'Напишите текст задачи, например:\n/add Купить молоко');
        try {
          data.createTask(uid, { title: arg });
          return reply(chatId, `✅ Задача добавлена: ${short(arg.replace(/\s+/g, ' ').trim(), 120)}`);
        } catch (e) {
          if (e instanceof HttpError && e.extra && e.extra.fields) return reply(chatId, `⚠️ ${Object.values(e.extra.fields)[0]}`);
          warn(`ошибка /add: ${e.message}`);
          return reply(chatId, 'Не удалось добавить задачу. Попробуйте позже.');
        }
      }
      default:
        return reply(chatId, 'Не понял команду. Список команд: /help');
    }
  }

  async function onCallback(cb) {
    const msg = cb.message;
    const chatId = msg && msg.chat && msg.chat.id;
    // только личный чат и только сам пользователь
    if (!chatId || msg.chat.type !== 'private' || !cb.from || cb.from.is_bot || cb.from.id !== chatId || typeof cb.data !== 'string' || cb.data.length > 64) {
      return api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
    }
    if (limiter.hit(`tgchat:${chatId}`, MIN) > config.limits.tgChatPerMin) return api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Слишком часто' }).catch(() => {});

    let m;
    if ((m = cb.data.match(/^lk:([yn]):([A-Za-z0-9_-]{16,64})$/))) return confirmLink(cb, chatId, m[1] === 'y', m[2]);

    if ((m = cb.data.match(/^done:(\d{1,15})$/))) {
      const uid = linkedUser(chatId);
      if (!uid) return api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Чат не подключён' }).catch(() => {});
      try {
        data.setTaskDone(uid, Number(m[1]), { done: true });          // чужая задача = 404: проверка владельца внутри
        await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Готово ✅' }).catch(() => {});
      } catch (e) {
        await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Задача не найдена' }).catch(() => {});
      }
      const { text, reply_markup } = tasksMessage(uid);
      return api('editMessageText', { chat_id: chatId, message_id: msg.message_id, text, reply_markup }).catch(() => {});
    }
    return api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  }

  async function handleUpdate(update) {
    if (!enabled || !update) return;
    if (update.callback_query) return onCallback(update.callback_query);
    const m = update.message;
    if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;   // группы, каналы и боты игнорируются
    const chatId = m.chat.id;
    if (limiter.hit(`tgchat:${chatId}`, MIN) > config.limits.tgChatPerMin) return;
    if (typeof m.text !== 'string') return reply(chatId, 'Я понимаю только текст. Список команд: /help');
    const text = m.text.slice(0, 4096).trim();
    const cmd = text.match(/^\/([A-Za-z_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (!cmd) return reply(chatId, linkedUser(chatId) ? 'Не понял. Чтобы добавить задачу: /add текст. Все команды: /help' : NOT_LINKED);
    return onCommand(chatId, m.from, cmd[1].toLowerCase(), (cmd[2] || '').trim());
  }

  /* ---------- Очередь исходящих сообщений ---------- */
  let flushing = false;
  async function flush() {
    if (!enabled || flushing) return 0;
    flushing = true;
    let sent = 0;
    try {
      q.staleOut.run(Date.now() - 3600000);                             // сообщения старше часа уже не нужны
      for (const r of q.due.all(Date.now())) {
        try {
          await api('sendMessage', { chat_id: r.chat_id, text: r.text, disable_web_page_preview: true });
          q.delOut.run(r.id); sent++;
        } catch (e) {
          if (e.code === 403 || (e.code === 400 && /chat not found|deactivated/i.test(e.message))) {
            q.delOut.run(r.id); unlinkChat(r.chat_id);                  // бота заблокировали: отвязываем
          } else if (e.code === 429) {
            q.defer.run(Date.now() + (e.retryAfter || 5) * 1000 + 500, r.id); break;
          } else {
            const attempts = r.attempts + 1;
            if (attempts >= 5) q.delOut.run(r.id);
            else q.retry.run(attempts, Date.now() + Math.min(300000, 5000 * 2 ** attempts), r.id);
            warn(`сообщение не отправлено (попытка ${attempts}): ${e.message}`);
          }
        }
      }
    } finally { flushing = false; }
    return sent;
  }

  /* ---------- Фоновые циклы ---------- */
  async function pollLoop() {
    let backoff = 1000;
    while (running) {
      try {
        const offset = Number(q.getKv.get('tg_offset')?.value || 0);
        const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
        backoff = 1000;
        for (const u of updates) {
          try { await handleUpdate(u); } catch (e) { warn(`ошибка обработки сообщения: ${e.message}`); }
          q.setKv.run('tg_offset', String(u.update_id + 1));            // подтверждаем после обработки: повторов не будет
        }
      } catch (e) {
        if (!running) break;
        if (e.code === 409) warn('Telegram: бот уже опрашивается другим процессом. Запускайте только один экземпляр сервера.');
        else if (e.code === 401) { warn('токен отозван или неверен. Бот остановлен.'); enabled = false; running = false; break; }
        else warn(`опрос Telegram: ${e.message}`);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  async function start() {
    if (!(await init())) return false;
    if (!cfg.poll) return true;
    running = true;
    pollLoop();
    pollTimer = setInterval(() => {
      flush().catch((e) => warn(`очередь сообщений: ${e.message}`));
      try { q.oldCodes.run(Date.now() - 86400000); } catch { /* ignore */ }
    }, 1500);
    return true;
  }
  function stop() { running = false; if (pollTimer) clearInterval(pollTimer); }

  return { init, start, stop, status, startLink, unlink, handleUpdate, flush, isEnabled: () => enabled, botName: () => botName };
}
