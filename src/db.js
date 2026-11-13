import { DatabaseSync } from 'node:sqlite';

// Миграции: добавляйте новые элементы в конец массива, существующие не меняйте.
const MIGRATIONS = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY,
     public_id     TEXT    NOT NULL UNIQUE,
     email         TEXT    NOT NULL UNIQUE,
     name          TEXT    NOT NULL,
     phone         TEXT    NOT NULL DEFAULT '',
     password_hash TEXT    NOT NULL,
     email_verified INTEGER NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     id         TEXT    PRIMARY KEY,           -- sha256 токена (сам токен в БД не хранится)
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf       TEXT    NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     last_seen  INTEGER NOT NULL,
     ip         TEXT,
     ua         TEXT
   );
   CREATE INDEX idx_sessions_user    ON sessions(user_id);
   CREATE INDEX idx_sessions_expires ON sessions(expires_at);`,

  // Этап 3: одноразовые токены из писем (подтверждение email, сброс пароля) и сообщения из формы «Контакты»
  `CREATE TABLE email_tokens (
     id         INTEGER PRIMARY KEY,
     token_hash TEXT    NOT NULL UNIQUE,          -- sha256 токена (сам токен в БД не хранится)
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     purpose    TEXT    NOT NULL CHECK (purpose IN ('verify', 'reset')),
     expires_at INTEGER NOT NULL,
     used_at    INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_email_tokens_user ON email_tokens(user_id, purpose);
   CREATE TABLE contact_messages (
     id         INTEGER PRIMARY KEY,
     name       TEXT    NOT NULL,
     email      TEXT    NOT NULL,
     message    TEXT    NOT NULL,
     ip         TEXT,
     created_at INTEGER NOT NULL
   );`,

  // Этап 5: данные кабинета на сервере. У каждой записи есть user_id; при удалении аккаунта всё удаляется каскадом
  `CREATE TABLE tasks (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title      TEXT    NOT NULL,
     prio       TEXT    NOT NULL CHECK (prio IN ('low', 'mid', 'high')),
     due        TEXT,
     done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
     done_at    INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_tasks_user ON tasks(user_id, created_at);
   CREATE TABLE automations (
     id           INTEGER PRIMARY KEY,
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name         TEXT    NOT NULL,
     trigger_type TEXT    NOT NULL,
     action_type  TEXT    NOT NULL,
     enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
     runs         INTEGER NOT NULL DEFAULT 0,
     created_at   INTEGER NOT NULL
   );
   CREATE INDEX idx_automations_user ON automations(user_id, trigger_type);
   CREATE TABLE notifications (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text       TEXT    NOT NULL,
     type       TEXT    NOT NULL,
     read       INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_notifications_user ON notifications(user_id, id);
   CREATE TABLE activity (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     text       TEXT    NOT NULL,
     sub        TEXT    NOT NULL DEFAULT '',
     type       TEXT    NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_activity_user ON activity(user_id, id);
   CREATE TABLE user_state (
     user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     runs_ok     INTEGER NOT NULL DEFAULT 0,
     runs_total  INTEGER NOT NULL DEFAULT 0,
     tg_on       INTEGER NOT NULL DEFAULT 0,
     tg_code     TEXT    NOT NULL DEFAULT '',
     pref_tg     INTEGER NOT NULL DEFAULT 1,
     pref_email  INTEGER NOT NULL DEFAULT 0
   );`,

  // Этап 4: Telegram-бот. Привязка чата к аккаунту, одноразовые коды привязки, очередь исходящих сообщений
  `CREATE TABLE telegram_links (
     user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     chat_id   INTEGER NOT NULL UNIQUE,            -- один Telegram-чат = один аккаунт
     username  TEXT,
     linked_at INTEGER NOT NULL
   );
   CREATE TABLE telegram_codes (
     code_hash  TEXT PRIMARY KEY,                  -- sha256 кода; сам код в БД не хранится
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL,
     used_at    INTEGER
   );
   CREATE TABLE telegram_outbox (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     chat_id    INTEGER NOT NULL,
     text       TEXT    NOT NULL,
     attempts   INTEGER NOT NULL DEFAULT 0,
     next_at    INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX idx_outbox_due ON telegram_outbox(next_at);
   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,

  // Этап 6: тарифы и заказы (заглушка оплаты). Нет строки в subscriptions = тариф «Старт»
  `CREATE TABLE subscriptions (
     user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     plan       TEXT    NOT NULL CHECK (plan IN ('start', 'pro', 'business')),
     period_end INTEGER NOT NULL,                       -- конец оплаченного периода; автопродления нет
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE orders (
     id           INTEGER PRIMARY KEY,
     public_id    TEXT    NOT NULL UNIQUE,                    -- случайный адрес заказа (внутренний номер наружу не отдаётся)
     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     plan         TEXT    NOT NULL CHECK (plan IN ('pro', 'business')),
     amount       INTEGER NOT NULL,                            -- сумма фиксируется при создании заказа, на сервере
     currency     TEXT    NOT NULL DEFAULT 'KZT',
     status       TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'canceled')),
     provider     TEXT    NOT NULL,
     provider_ref TEXT,
     created_at   INTEGER NOT NULL,
     paid_at      INTEGER
   );
   CREATE INDEX idx_orders_user ON orders(user_id, id);`,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}
