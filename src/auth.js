import { hashPassword, verifyPassword, DUMMY_HASH, newToken, sha256, publicId, safeEqual } from './security.js';
import { parseCookies, setCookie } from './http.js';

const DAY = 86400000;

export function createAuth({ db, config }) {
  const COOKIE = config.isProd ? '__Host-af_sid' : 'af_sid';
  const cookieOpts = (maxAge) => ({ maxAge, secure: config.isProd });

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (public_id, email, name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (id, user_id, csrf, created_at, expires_at, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    sessionById: db.prepare(`SELECT s.id AS sid, s.csrf, s.created_at AS s_created, s.expires_at, s.last_seen,
                                    u.id AS uid, u.public_id, u.email, u.name, u.phone, u.email_verified
                             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
    touch: db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?'),
    delSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
    delExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    updProfile: db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?'),
    delUser: db.prepare('DELETE FROM users WHERE id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    // --- одноразовые токены из писем ---
    insToken: db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)'),
    dropOldTokens: db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?'),
    // атомарно «гасим» токен: два параллельных запроса с одним токеном не пройдут оба
    useToken: db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id'),
    peekToken: db.prepare('SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?'),
    delExpiredTokens: db.prepare('DELETE FROM email_tokens WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?'),
    setVerified: db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?'),
    setHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?'),
  };

  const sweep = setInterval(() => {
    try { q.delExpired.run(Date.now()); q.delExpiredTokens.run(Date.now(), Date.now() - DAY); } catch { /* ignore */ }
  }, 10 * 60000);
  sweep.unref();

  const toPublic = (u) => ({
    id: u.public_id, name: u.name, email: u.email, phone: u.phone, emailVerified: !!u.email_verified,
  });

  async function createUser({ name, email, phone, password }) {
    const hash = await hashPassword(password);
    try {
      const r = q.insertUser.run(publicId(), email, name, phone, hash, Date.now());
      return q.userById.get(Number(r.lastInsertRowid));
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return null; // email уже занят
      throw e;
    }
  }

  async function checkCredentials(email, password) {
    const user = q.userByEmail.get(email);
    // всегда считаем хеш — время ответа не выдаёт, существует ли аккаунт
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    return user && ok ? user : null;
  }

  function startSession(res, user, req, ip) {
    const token = newToken(), csrf = newToken(24), now = Date.now();
    q.insertSession.run(sha256(token), user.id, csrf, now, now + config.sessionDays * DAY, now, ip || '',
      String(req.headers['user-agent'] || '').slice(0, 200));
    setCookie(res, COOKIE, token, cookieOpts(config.sessionDays * 86400));
    return csrf;
  }

  // Возвращает { user, csrf, sid } или null. Личность определяется ТОЛЬКО по cookie.
  function getSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token || token.length > 100) return null;
    const row = q.sessionById.get(sha256(token));
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now || row.s_created + config.sessionMaxDays * DAY < now) { q.delSession.run(row.sid); return null; }
    if (now - row.last_seen > 5 * 60000) {
      q.touch.run(now, Math.min(now + config.sessionDays * DAY, row.s_created + config.sessionMaxDays * DAY), row.sid);
    }
    return {
      sid: row.sid, csrf: row.csrf, userId: row.uid,
      user: toPublic({ public_id: row.public_id, email: row.email, name: row.name, phone: row.phone, email_verified: row.email_verified }),
    };
  }

  function endSession(res, sid) {
    if (sid) q.delSession.run(sid);
    setCookie(res, COOKIE, '', cookieOpts(0));
  }

  /* ---------- Одноразовые токены (подтверждение email, сброс пароля) ---------- */
  // В БД хранится только sha256 токена: утечка базы не даёт готовых ссылок.
  function issueToken(userId, purpose, ttlMs) {
    q.dropOldTokens.run(userId, purpose);               // новая ссылка отменяет предыдущие
    const token = newToken(32), now = Date.now();
    q.insToken.run(sha256(token), userId, purpose, now + ttlMs, now);
    return token;
  }
  const tokenOk = (t) => typeof t === 'string' && t.length >= 20 && t.length <= 100;
  function consumeToken(token, purpose) {
    if (!tokenOk(token)) return null;
    const row = q.useToken.get(Date.now(), sha256(token), purpose, Date.now());
    return row ? row.user_id : null;
  }
  const checkToken = (token, purpose) => tokenOk(token) && !!q.peekToken.get(sha256(token), purpose, Date.now());

  // Смена пароля: все остальные сессии завершаются (если украли cookie — вор вылетит)
  async function setPassword(userId, password, keepSid = null) {
    const hash = await hashPassword(password);
    q.setHash.run(hash, userId);
    if (keepSid) q.delOtherSessions.run(userId, keepSid); else q.delUserSessions.run(userId);
  }

  const csrfOk = (req, session) => !!session && safeEqual(req.headers['x-csrf-token'] || '', session.csrf);

  return {
    issueToken, consumeToken, checkToken, setPassword,
    markVerified: (userId) => q.setVerified.run(userId),
    userByEmail: (email) => q.userByEmail.get(email),
    toPublic, createUser, checkCredentials, startSession, getSession, endSession, csrfOk,
    updateProfile: (userId, name, phone) => q.updProfile.run(name, phone, userId),
    userById: (id) => q.userById.get(id),
    deleteUser: (id) => q.delUser.run(id), // сессии удаляются каскадом
  };
}
