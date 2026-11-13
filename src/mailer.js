import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

/* ==========================================================
   Отправка писем без внешних зависимостей.
   Транспорты (MAIL_TRANSPORT):
     console — письмо печатается в консоль сервера (для разработки)
     smtp    — реальная отправка через SMTP (Gmail, Яндекс, Mail.ru, Brevo и т.д.)
     resend  — отправка через HTTPS API сервиса resend.com (нужен только API-ключ и подтверждённый домен)
     memory  — складывает письма в массив (для тестов)
   ========================================================== */

const CRLF = '\r\n';
const clean = (s) => String(s ?? '').replace(/[\r\n\u0000]+/g, ' ').trim();   // защита от внедрения заголовков
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => (s.match(/.{1,76}/g) || ['']).join(CRLF);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isLoopback = (h) => /^(localhost|127\.\d+\.\d+\.\d+|::1)$/i.test(h);

const addrOf = (s) => { const m = String(s).match(/<([^<>\s]+)>/); return clean(m ? m[1] : s); };

function encodeHeader(s) {
  s = clean(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // RFC 2047: кусками, чтобы каждое «encoded-word» не превышало 75 символов
  const chars = [...s], parts = [];
  for (let i = 0; i < chars.length; i += 12) parts.push(`=?UTF-8?B?${b64(chars.slice(i, i + 12).join(''))}?=`);
  return parts.join(CRLF + ' ');
}

function formatAddr(s) {
  const m = String(s).match(/^(.*)<([^<>]+)>\s*$/);
  if (!m) return clean(s);
  const name = clean(m[1]).replace(/^"|"$/g, '');
  return name ? `${encodeHeader(name)} <${clean(m[2])}>` : clean(m[2]);
}

export function buildMessage({ from, to, subject, text, html, replyTo }) {
  const boundary = '=_af_' + crypto.randomBytes(12).toString('hex');
  const domain = (addrOf(from).split('@')[1] || 'localhost').replace(/[^\w.-]/g, '');
  const headers = [
    `From: ${formatAddr(from)}`,
    `To: ${formatAddr(to)}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (replyTo) headers.push(`Reply-To: ${formatAddr(replyTo)}`);

  if (!html) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return headers.join(CRLF) + CRLF + CRLF + wrap76(b64(text)) + CRLF;
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type, body) => [
    `--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body)),
  ].join(CRLF);
  return headers.join(CRLF) + CRLF + CRLF + part('text/plain', text) + CRLF + part('text/html', html) + CRLF + `--${boundary}--` + CRLF;
}

/* ---------- Минимальный SMTP-клиент ---------- */
class Conn {
  constructor(socket, timeoutMs = 15000) {
    this.s = socket; this.buf = ''; this.lines = []; this.replies = []; this.waiters = []; this.err = null;
    socket.setEncoding('utf8');
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.fail(new Error('SMTP: соединение закрыто')));
    socket.setTimeout(timeoutMs, () => { this.fail(new Error('SMTP: таймаут')); socket.destroy(); });
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      if (/^\d{3}( |$)/.test(line)) {                       // последняя строка ответа: «250 ...», а не «250-...»
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply); else this.replies.push(reply);
      }
    }
  }
  fail(e) {
    if (this.err) return;
    this.err = e;
    this.waiters.splice(0).forEach(w => w.reject(e));
  }
  reply() {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async expect(ok) {
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code}: ${r.lines.join(' ').slice(0, 200)}`);
    return r;
  }
  async cmd(line, ok) { this.s.write(line + CRLF); return this.expect(ok); }
  close() { try { this.s.destroy(); } catch { /* ignore */ } }
}

async function smtpSend(smtp, { from, to, raw }) {
  if (!smtp.host) throw new Error('SMTP_HOST не задан');
  const encrypted = !!smtp.secure;
  if (!encrypted && !isLoopback(smtp.host) && smtp.user) {
    throw new Error('Пароль нельзя отправлять по незащищённому соединению. Используйте SMTP_PORT=465 и SMTP_SECURE=true');
  }
  const socket = encrypted
    ? tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host, rejectUnauthorized: smtp.rejectUnauthorized !== false })
    : net.connect({ host: smtp.host, port: smtp.port });
  const conn = new Conn(socket);
  try {
    await conn.expect([220]);
    const hello = (os.hostname() || 'localhost').replace(/[^\w.-]/g, '') || 'localhost';
    const caps = (await conn.cmd(`EHLO ${hello}`, [250])).lines.join(' ').toUpperCase();

    if (smtp.user) {
      if (/AUTH[^\n]*PLAIN/.test(caps) || !/AUTH[^\n]*LOGIN/.test(caps)) {
        await conn.cmd('AUTH PLAIN ' + b64(`\u0000${smtp.user}\u0000${smtp.pass}`), [235]);
      } else {
        await conn.cmd('AUTH LOGIN', [334]);
        await conn.cmd(b64(smtp.user), [334]);
        await conn.cmd(b64(smtp.pass), [235]);
      }
    }
    await conn.cmd(`MAIL FROM:<${addrOf(from)}>`, [250]);
    await conn.cmd(`RCPT TO:<${addrOf(to)}>`, [250, 251]);
    await conn.cmd('DATA', [354]);
    conn.s.write(raw.replace(/^\./gm, '..') + '.' + CRLF);       // «dot-stuffing» и завершающая точка
    await conn.expect([250]);
    try { await conn.cmd('QUIT', [221]); } catch { /* уже отправлено */ }
  } finally { conn.close(); }
}

/* ---------- Публичный интерфейс ---------- */
export function createMailer(config) {
  const { transport, from, smtp, resendKey, resendUrl } = config.mail;
  const outbox = [];

  async function send({ to, subject, text, html, replyTo }) {
    to = clean(to);
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) throw new Error('Некорректный адрес получателя');
    const msg = { from, to, subject: clean(subject), text, html, replyTo: replyTo ? clean(replyTo) : undefined };

    if (transport === 'memory') { outbox.push({ ...msg, time: Date.now() }); return; }
    if (transport === 'console') {
      // В production ссылки с токенами в лог не пишем
      console.log(config.isProd
        ? `[mail:console] «${msg.subject}» → ${to} (письмо НЕ отправлено: задайте MAIL_TRANSPORT=smtp)`
        : `\n──────── письмо → ${to} ────────\nТема: ${msg.subject}\n\n${text}\n────────────────────────────────\n`);
      return;
    }
    if (transport === 'smtp') return smtpSend(smtp, { from, to, raw: buildMessage(msg) });
    if (transport === 'resend') {
      if (!resendKey) throw new Error('RESEND_API_KEY не задан');
      const r = await fetch(resendUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: msg.subject, text, html, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`Почтовый сервис Resend ответил ${r.status}`);   // ключ и тело письма в ошибку не попадают
      return;
    }
    throw new Error(`Неизвестный MAIL_TRANSPORT: ${transport}`);
  }
  return { send, outbox, transport };
}

/* ---------- Шаблоны писем ---------- */
const layout = (title, bodyHtml, buttonText, link, footer) => `<!doctype html>
<html lang="ru"><body style="margin:0;padding:24px;background:#0b1030;font-family:Arial,Helvetica,sans-serif;color:#e8ecff">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="520" cellspacing="0" cellpadding="0" style="max-width:520px;background:#121a52;border-radius:20px;padding:32px">
<tr><td style="font-size:22px;font-weight:700;color:#ffffff;padding-bottom:6px">⚡ AutoFlow</td></tr>
<tr><td style="font-size:20px;font-weight:700;color:#ffffff;padding:18px 0 10px">${esc(title)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#c9d2f5;padding-bottom:24px">${bodyHtml}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${esc(link)}" style="display:inline-block;background:#4f7bff;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:999px">${esc(buttonText)}</a></td></tr>
<tr><td style="font-size:12.5px;line-height:1.6;color:#8f9cc9">Если кнопка не работает, скопируйте ссылку в браузер:<br><span style="word-break:break-all;color:#a98bff">${esc(link)}</span></td></tr>
<tr><td style="font-size:12.5px;line-height:1.6;color:#8f9cc9;padding-top:16px">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;

export const templates = {
  verify({ name, link, hours }) {
    const first = clean(name).split(' ')[0] || 'Здравствуйте';
    return {
      subject: 'Подтвердите email в AutoFlow',
      text: `${first}, добро пожаловать в AutoFlow!\n\nПодтвердите email, перейдя по ссылке (действует ${hours} ч.):\n${link}\n\nЕсли вы не регистрировались, просто проигнорируйте это письмо.`,
      html: layout('Подтвердите email', `${esc(first)}, добро пожаловать в AutoFlow! Нажмите кнопку, чтобы подтвердить адрес почты. Ссылка действует ${hours} ч.`,
        'Подтвердить email', link, 'Если вы не регистрировались в AutoFlow, просто проигнорируйте это письмо.'),
    };
  },
  reset({ name, link, minutes }) {
    const first = clean(name).split(' ')[0] || 'Здравствуйте';
    return {
      subject: 'Сброс пароля в AutoFlow',
      text: `${first}, мы получили запрос на сброс пароля.\n\nСоздайте новый пароль по ссылке (действует ${minutes} мин.):\n${link}\n\nЕсли это были не вы, ничего не делайте: пароль останется прежним.`,
      html: layout('Сброс пароля', `${esc(first)}, мы получили запрос на сброс пароля. Нажмите кнопку, чтобы создать новый. Ссылка действует ${minutes} мин.`,
        'Создать новый пароль', link, 'Если это были не вы, ничего не делайте: пароль останется прежним.'),
    };
  },
  contact({ name, email, message }) {
    return {
      subject: 'Новое сообщение с сайта AutoFlow',
      text: `Имя: ${clean(name)}\nEmail: ${clean(email)}\n\n${String(message).replace(/\u0000/g, '')}`,
    };
  },
};
