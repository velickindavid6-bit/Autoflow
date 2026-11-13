import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Минимальный разбор .env (без зависимостей)
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env необязателен */ }

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);

export function loadConfig(overrides = {}) {
  const isProd = (env.NODE_ENV || 'development') === 'production';
  const port = int(env.PORT, 3000);
  const host = env.HOST || '127.0.0.1';
  const base = {
    isProd,
    port,
    host,
    trustProxy: bool(env.TRUST_PROXY, false),
    sessionDays: int(env.SESSION_DAYS, 7),
    sessionMaxDays: 30,               // абсолютный предел жизни сессии
    dbFile: path.join(ROOT, 'data', 'autoflow.db'),
    publicDir: path.join(ROOT, 'public'),
    // Адрес сайта для ссылок в письмах. Берётся ТОЛЬКО из настроек (не из заголовка Host: его может подделать клиент)
    appUrl: (env.APP_URL || '').trim().replace(/\/+$/, ''),
    tokens: { verifyHours: 24, resetMinutes: 30 },
    billing: {
      // off — оплата выключена (безопасно по умолчанию в production), demo — заглушка: деньги не списываются, тариф выдаётся бесплатно
      mode: env.PAYMENTS_MODE || (isProd ? 'off' : 'demo'),
    },
    telegram: {
      token: (env.TELEGRAM_BOT_TOKEN || '').trim(),
      apiBase: (!isProd && env.TELEGRAM_API_BASE) || 'https://api.telegram.org',   // чужой адрес допускается только вне production (для тестов)
      codeMinutes: 10,                              // срок жизни кода привязки
      poll: true,                                   // false = не запускать фоновые циклы (тесты)
    },
    mail: {
      transport: env.MAIL_TRANSPORT || 'console',   // console | smtp | resend | memory (тесты)
      from: env.MAIL_FROM || 'AutoFlow <no-reply@localhost>',
      resendKey: env.RESEND_API_KEY || '',
      resendUrl: 'https://api.resend.com/emails',
      contactTo: env.CONTACT_TO || '',              // куда пересылать сообщения из формы «Контакты»
      smtp: {
        host: env.SMTP_HOST || '', port: int(env.SMTP_PORT, 465),
        secure: bool(env.SMTP_SECURE, int(env.SMTP_PORT, 465) === 465),
        user: env.SMTP_USER || '', pass: env.SMTP_PASS || '',
      },
    },
    limits: {
      regPerHour: 10, loginPerIp10Min: 30, loginFailsPerEmail: 5, globalPerMin: 600,
      forgotPerIpHour: 5, forgotPerEmailHour: 3, verifySendPerHour: 3,
      tokenPerIp10Min: 30, changePwPerHour: 10, contactPerHour: 5, writesPerMin: 120, resetDemoPerHour: 10, tgLinkPerHour: 10, checkoutPerHour: 10, tgChatPerMin: 30, tgMsgPer10Min: 30,
    },
  };
  const cfg = {
    ...base, ...overrides,
    tokens: { ...base.tokens, ...overrides.tokens },
    telegram: { ...base.telegram, ...overrides.telegram },
    billing: { ...base.billing, ...overrides.billing },
    mail: { ...base.mail, ...overrides.mail, smtp: { ...base.mail.smtp, ...(overrides.mail && overrides.mail.smtp) } },
    limits: { ...base.limits, ...overrides.limits },
  };
  if (!['off', 'demo'].includes(cfg.billing.mode)) throw new Error('PAYMENTS_MODE должен быть off или demo (реальная оплата подключается отдельным этапом)');
  if (!cfg.appUrl) {
    if (cfg.isProd) throw new Error('В production необходимо задать APP_URL, например https://autoflow.kz');
    cfg.appUrl = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`;
  }
  return cfg;
}
