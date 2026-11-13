/* ==========================================================
   Демо-версия: подключение «сервера в браузере» к страницам.
   • перехватывает запросы fetch('/api/...') и отвечает на них из engine.js;
   • подменяет afUrl(), чтобы переходы вели на login.html, dashboard.html и т.д.;
   • показывает окно «Демо-почта»: письма и сообщения Telegram, которые на настоящем сервере ушли бы наружу;
   • показывает плашку «Демо» со ссылкой на исходный код.
   ========================================================== */
(function () {
  'use strict';
  const CFG = /*__CONFIG__*/ {};
  const ROUTES = /*__ROUTES__*/ {};

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
