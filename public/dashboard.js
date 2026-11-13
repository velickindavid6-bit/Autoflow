/* ==========================================================
   AutoFlow — личный кабинет
   Все данные (задачи, автоматизации, уведомления) хранятся на сервере
   и привязаны к аккаунту. Здесь только отображение и запросы к API.
   ========================================================== */
(async () => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Хранилище ---------- */
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
  };
  const readJSON = (k) => { try { return JSON.parse(ls.get(k)); } catch (_) { return null; } };

  /* ---------- Сессия (проверяется сервером) ---------- */
  let csrf = '';
  const apiCall = async (method, url, body) => {
    try {
      const r = await fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = {};
      try { data = await r.json(); } catch (_) {}
      if (r.status === 401) { location.replace(afUrl('/login')); }
      return { ok: r.ok, status: r.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: {} };
    }
  };

  let session;
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok) { location.replace(afUrl('/login')); return; }
    const me = await r.json();
    csrf = me.csrf;
    session = me.user;
  } catch (_) { location.replace(afUrl('/login')); return; }

  // Раньше демо-данные лежали в браузере и оставались там после выхода. Теперь они на сервере, поэтому старые копии удаляем.
  try {
    Object.keys(localStorage).filter(k => /^autoflow:/.test(k)).forEach(k => localStorage.removeItem(k));
  } catch (_) {}

  /* ---------- Утилиты ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayIdx = () => (new Date().getDay() + 6) % 7; // Пн = 0
  const fmtDue = (s) => { const [, m, d] = s.split('-').map(Number); return `до ${d} ${MONTHS[m - 1]}`; };
  const PRIO = { high: 'Высокий', mid: 'Средний', low: 'Низкий' };

  const timeAgo = (ts) => {
    const diff = Date.now() - ts, m = Math.floor(diff / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const d = new Date(ts), t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime()) return `сегодня, ${t}`;
    if (ts >= today.getTime() - 864e5) return `вчера, ${t}`;
    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${t}`;
  };

  const PATHS = {
    task:  '<path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h9"/>',
    bolt:  '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    bell:  '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>',
    tg:    '<path d="M21.5 3.2 2.6 10.5c-1 .4-.9 1.2-.2 1.4l4.8 1.5 1.9 5.8c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3-14.6c.3-1.2-.4-1.8-1.2-1.4z"/>',
    mail:  '<path d="M3 6h18v12H3zM3 7l9 6 9-6"/>',
    play:  '<path d="M7 4.5l12 7.5-12 7.5z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  };
  const ico = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${PATHS[n]}</svg>`;
  const TYPES = {
    ok:   { c: '#19c3a0', i: 'check' },
    send: { c: '#2b8bff', i: 'mail' },
    task: { c: '#f0506e', i: 'task' },
    auto: { c: '#8a3ffc', i: 'bolt' },
    tg:   { c: '#2aabee', i: 'tg' },
    bell: { c: '#ffb23e', i: 'bell' },
  };

  /* ---------- Данные кабинета (приходят с сервера) ---------- */
  const emptyData = () => ({
    tasks: [], autos: [], notes: [], feed: [], week: [0, 0, 0, 0, 0, 0, 0],
    runs: { ok: 0, total: 0 }, tg: { on: false, code: '' }, prefs: { tg: true, email: false },
  });
  const tz = new Date().getTimezoneOffset();       // нужен серверу, чтобы посчитать неделю по вашему времени
  let data = { ...emptyData(), profile: { name: session.name || '', phone: session.phone || '' } };
  const applyDashboard = (d) => { data = { ...d, profile: { name: session.name || '', phone: session.phone || '' } }; };

  const errMsg = (res) => {
    const f = res.data && res.data.fields;
    if (f) return Object.values(f)[0];
    if (res.status === 429) return 'Слишком много действий. Подождите минуту.';
    if (res.status === 404) return 'Запись не найдена. Обновите страницу.';
    if (res.status === 0) return 'Нет соединения с сервером.';
    return 'Что-то пошло не так. Попробуйте ещё раз.';
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Запрос, меняющий данные: сервер возвращает свежее состояние кабинета целиком
  const mutate = async (method, url, body, { minMs = 0 } = {}) => {
    const [res] = await Promise.all([apiCall(method, `${url}?tz=${tz}`, body), reduce ? 0 : sleep(minMs)]);
    if (res.ok && res.data.dashboard) { applyDashboard(res.data.dashboard); renderAll(); }
    return res;
  };
  const refresh = async () => {
    const res = await apiCall('GET', `/api/dashboard?tz=${tz}`);
    if (res.ok) { applyDashboard(res.data.dashboard); renderAll(); }
    return res;
  };

  const state = { filter: 'all' };
  const seen = { feed: new Set(), tasks: new Set(), notes: new Set() };

  /* ---------- Тост ---------- */
  const toastEl = $('#toast');
  let toastTimer;
  const toast = (text) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  };

  /* ---------- Анимация чисел ---------- */
  const tween = (el, to, suffix = '') => {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (reduce || from === to) { el.textContent = to + suffix; return; }
    const t0 = performance.now(), dur = 800;
    const step = (n) => {
      const p = Math.min((n - t0) / dur, 1);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  /* ---------- Профиль / шапка ---------- */
  const initials = (name) => (name || session.email).trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  const firstName = () => (data.profile.name || session.email.split('@')[0]).trim().split(/\s+/)[0];

  const renderUser = () => {
    const name = data.profile.name || session.email.split('@')[0];
    $('#userName').textContent = name;
    $('#userEmail').textContent = session.email;
    $('#userAvatar').textContent = initials(data.profile.name);
    $('#topAvatar').textContent = initials(data.profile.name);
    $('#helloName').textContent = firstName();
  };

  /* ---------- Статистика ---------- */
  const STAT_DEFS = [
    { k: 'tasks', label: 'Активных задач', c: '#2b8bff', i: 'task', to: 'tasks' },
    { k: 'autos', label: 'Автоматизаций', c: '#b25cff', i: 'bolt', to: 'automations' },
    { k: 'rate',  label: 'Успешность', c: '#19c3a0', i: 'check', suf: '%', to: 'automations' },
    { k: 'notes', label: 'Новых уведомлений', c: '#f0506e', i: 'bell', to: 'notifications' },
  ];
  const buildStats = () => {
    $('#stats').innerHTML = STAT_DEFS.map((s, i) =>
      `<a class="stat" href="#${s.to}" style="--c:${s.c};--d:${i * .08}s" aria-label="${s.label}: перейти в раздел"><div class="stat__ico">${ico(s.i)}</div><b data-k="${s.k}" data-v="0">0${s.suf || ''}</b><span>${s.label}</span><i class="stat__go" aria-hidden="true">→</i></a>`
    ).join('');
  };
  const unread = () => data.notes.filter(n => !n.read).length;
  const renderStats = () => {
    const vals = {
      tasks: data.tasks.filter(t => !t.done).length,
      autos: data.autos.filter(a => a.on).length,
      rate: data.runs.total ? Math.round(data.runs.ok / data.runs.total * 100) : 100,
      notes: unread(),
    };
    STAT_DEFS.forEach(s => tween($(`[data-k="${s.k}"]`), vals[s.k], s.suf || ''));
    const activeTasks = vals.tasks;
    $('#navTasks').textContent = activeTasks || '';
    $('#navNotes').textContent = vals.notes || '';
    const bell = $('#bellCount');
    bell.hidden = !vals.notes;
    bell.textContent = vals.notes > 9 ? '9+' : vals.notes;
  };

  /* ---------- График ---------- */
  const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  let chartBuilt = false;
  const renderChart = () => {
    const chart = $('#chart'), di = dayIdx(), max = Math.max(...data.week, 4);
    if (!chartBuilt) {
      chart.innerHTML = DAYS.map((d, i) =>
        `<div class="bar ${i === di ? 'today' : ''}"><div class="bar__col" style="--d:${i * .07}s" data-v="0"></div><small>${d}</small></div>`
      ).join('');
      chartBuilt = true;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('.bar__col', chart).forEach((col, i) => {
        col.style.height = Math.max(data.week[i] / max * 100, data.week[i] ? 6 : 2) + '%';
        col.dataset.v = data.week[i];
      });
    }));
    $('#weekTotal').textContent = `Всего: ${data.week.reduce((a, b) => a + b, 0)}`;
  };

  /* ---------- Журнал действий ---------- */
  // Куда ведёт клик по событию в журнале
  const FEED_TARGET = { ok: 'tasks', task: 'tasks', auto: 'automations', send: 'notifications', bell: 'notifications', tg: 'settings' };
  const renderFeed = () => {
    const items = data.feed.slice(0, 6);
    $('#feed').innerHTML = items.map((f, i) => {
      const t = TYPES[f.type] || TYPES.ok, isNew = !seen.feed.has(f.id);
      const to = FEED_TARGET[f.type] || 'notifications';
      return `<li class="${isNew ? 'new' : ''}" style="--d:${i * .06}s"><a href="#${to}"><i style="--c:${t.c}">${ico(t.i)}</i>
        <div><strong>${esc(f.text)}</strong><small>${f.sub ? esc(f.sub) + ' · ' : ''}${timeAgo(f.time)}</small></div></a></li>`;
    }).join('') || '<li class="empty">Пока нет действий</li>';
    items.forEach(f => seen.feed.add(f.id));
  };

  /* ---------- Задачи ---------- */
  const renderTasks = () => {
    const f = state.filter, today = dateStr(0);
    const counts = { all: data.tasks.length, active: data.tasks.filter(t => !t.done).length, done: data.tasks.filter(t => t.done).length };
    $$('#taskFilters .chip').forEach(c => {
      c.classList.toggle('active', c.dataset.filter === f);
      $('b', c).textContent = counts[c.dataset.filter];
    });
    const list = data.tasks
      .filter(t => f === 'all' || (f === 'active' ? !t.done : t.done))
      .sort((a, b) => (a.done - b.done) || (b.created - a.created));

    $('#taskList').innerHTML = list.map((t, i) => {
      const late = t.due && !t.done && t.due < today;
      return `<li class="task ${t.done ? 'done' : ''} ${seen.tasks.has(t.id) ? '' : 'new'}" data-id="${t.id}" style="--d:${i * .05}s">
        <button class="task__check" role="checkbox" aria-checked="${t.done}" aria-label="Отметить выполненной"><svg viewBox="0 0 24 24">${PATHS.check}</svg></button>
        <div class="task__body">
          <div class="task__title">${esc(t.title)}</div>
          <div class="task__meta"><span class="prio prio--${t.prio}">${PRIO[t.prio]}</span>${t.due ? `<span class="${late ? 'late' : ''}">${late ? 'просрочено · ' : ''}${fmtDue(t.due)}</span>` : ''}</div>
        </div>
        <button class="icon-btn" data-del aria-label="Удалить задачу">${ico('trash')}</button>
      </li>`;
    }).join('');
    list.forEach(t => seen.tasks.add(t.id));
    $('#taskEmpty').hidden = list.length > 0;
  };

  /* ---------- Автоматизации ---------- */
  const renderAutos = () => {
    $('#autoGrid').innerHTML = data.autos.map((a, i) =>
      `<article class="auto ${a.on ? '' : 'off'}" data-id="${a.id}" style="--d:${i * .07}s">
        <div class="auto__top"><h4>${esc(a.name)}</h4>
          <label class="tgl"><input type="checkbox" ${a.on ? 'checked' : ''} aria-label="Включить автоматизацию «${esc(a.name)}»"><i></i></label></div>
        <div class="auto__flow"><div><em>Когда</em>${esc(a.trigger)}</div><div><em>Тогда</em>${esc(a.action)}</div></div>
        <div class="auto__foot"><span>Запусков: <b data-runs>${a.runs}</b></span>
          <div class="auto__btns"><button class="icon-btn" data-del aria-label="Удалить">${ico('trash')}</button>
          <button class="btn btn--ghost" data-run>${ico('play')}Запустить</button></div></div>
      </article>`).join('') || '<p class="empty">Автоматизаций нет. Создайте первую!</p>';
  };

  /* ---------- Уведомления ---------- */
  const renderNotes = () => {
    $('#noteList').innerHTML = data.notes.map((n, i) => {
      const t = TYPES[n.type] || TYPES.bell;
      return `<li><button class="note ${n.read ? '' : 'unread'} ${seen.notes.has(n.id) ? '' : 'new'}" data-id="${n.id}" style="--d:${i * .05}s" aria-label="${n.read ? 'Прочитано' : 'Непрочитано'}: ${esc(n.text)}">
        <i style="--c:${t.c}">${ico(t.i)}</i>
        <span class="note__text"><strong>${esc(n.text)}</strong><small>${timeAgo(n.time)}</small></span></button></li>`;
    }).join('');
    data.notes.forEach(n => seen.notes.add(n.id));
    $('#noteEmpty').hidden = data.notes.length > 0;
    $('#noteSummary').textContent = data.notes.length ? `Непрочитано: ${unread()} из ${data.notes.length}` : '';
  };

  /* ---------- Telegram ---------- */
  let pending = null;                       // ссылка привязки, пока пользователь не подтвердил её в Telegram
  let pendingTimer = null;
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  const renderTg = () => {
    const tg = data.tg || { configured: false, on: false };
    $('#tgPanel').classList.toggle('on', !!tg.on);
    let text;
    if (!tg.configured) text = 'Бот пока не подключён к серверу: владельцу сайта нужно добавить TELEGRAM_BOT_TOKEN в файл .env (см. README).';
    else if (tg.on) text = `Бот подключён${tg.username ? ` (@${tg.username})` : ''}. Уведомления приходят в Telegram, а задачи можно добавлять командой /add.`;
    else if (pending) text = 'Ожидаем подтверждения в Telegram…';
    else text = 'Подключите бота, чтобы получать уведомления и управлять задачами прямо в Telegram.';
    $$('.js-tg-text').forEach(el => { el.textContent = text; });
    $$('.js-tg-btn').forEach(b => {
      b.disabled = !tg.configured;
      b.textContent = tg.on ? 'Отключить' : (pending ? 'Новая ссылка' : 'Подключить');
      b.classList.toggle('btn--primary', !tg.on);
      b.classList.toggle('btn--ghost', !!tg.on);
    });
    const t = $('#testTg'); if (t) t.disabled = !tg.on;
    const box = $('#tgPending');
    if (box) {
      box.hidden = !(pending && !tg.on);
      if (pending) {
        // ссылку подставляем только если она ведёт на t.me (защита от подмены ответа)
        $('#tgOpen').href = /^https:\/\/t\.me\/[\w]+\?start=[\w-]+$/.test(pending.link) ? pending.link : 'https://t.me/';
        $('#tgCmd').textContent = `/start ${pending.code}`;
      }
    }
  };

  const stopWatch = () => { clearInterval(pendingTimer); pendingTimer = null; };
  const startWatch = () => {
    stopWatch();
    let tick = 0;
    pendingTimer = setInterval(async () => {
      if (!pending) { stopWatch(); return; }
      const left = pending.expiresAt - Date.now();
      const el = $('#tgLeft'); if (el) el.textContent = mmss(left);
      if (left <= 0) { pending = null; stopWatch(); renderTg(); toast('Ссылка устарела. Нажмите «Подключить» ещё раз.'); return; }
      if (++tick % 3 === 0) {                                   // раз в 3 секунды спрашиваем сервер: подтвердили ли в Telegram
        await refresh();
        if (data.tg.on) { pending = null; stopWatch(); renderTg(); toast('Telegram подключён ✅'); }
      }
    }, 1000);
  };

  /* ---------- Настройки ---------- */
  const renderSettings = () => {
    $('#setName').value = data.profile.name || '';
    $('#setEmail').value = session.email;
    $('#setPhone').value = data.profile.phone || '';
    $('#prefTg').checked = data.prefs.tg;
    $('#prefEmail').checked = data.prefs.email;
    renderVerify();
  };

  // Статус подтверждения email: баннер сверху и значок в «Безопасности»
  const renderVerify = () => {
    const ok = !!session.emailVerified;
    $('#verifyBanner').hidden = ok;
    $('#bannerEmail').textContent = session.email;
    const pill = $('#emailPill');
    pill.textContent = ok ? 'Email подтверждён' : 'Email не подтверждён';
    pill.className = 'pill ' + (ok ? 'pill--ok' : 'pill--warn');
  };

  const renderAll = () => {
    renderUser(); renderStats(); renderChart(); renderFeed();
    renderTasks(); renderAutos(); renderNotes(); renderTg(); renderPlan();
  };

  /* ---------- Навигация между разделами ---------- */
  const TITLES = { home: 'Главная', tasks: 'Задачи', automations: 'Автоматизация', notifications: 'Уведомления', billing: 'Тариф', settings: 'Настройки' };
  const show = (name) => {
    if (!TITLES[name]) name = 'home';
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    $$('.side__nav a').forEach(a => {
      const on = a.dataset.view === name;
      a.classList.toggle('active', on);
      on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    $('#viewTitle').textContent = TITLES[name];
    document.title = `${TITLES[name]} — AutoFlow`;
    if (name === 'settings') renderSettings();
    if (name === 'billing') loadBilling();
    if (name === 'home') renderChart();
    closeMenu();
    window.scrollTo({ top: 0 });
  };
  addEventListener('hashchange', () => show(location.hash.slice(1)));

  // Мобильное меню
  const side = $('#side'), scrim = $('#scrim'), menuBtn = $('#menuBtn');
  const closeMenu = () => { side.classList.remove('open'); scrim.classList.remove('show'); menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', () => {
    const open = !side.classList.contains('open');
    side.classList.toggle('open', open); scrim.classList.toggle('show', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  scrim.addEventListener('click', closeMenu);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  $('#bellBtn').addEventListener('click', () => { location.hash = '#notifications'; });
  $$('[data-go]').forEach(b => b.addEventListener('click', () => {
    location.hash = '#' + b.dataset.go;
    if (b.dataset.focus) setTimeout(() => document.getElementById(b.dataset.focus).focus(), 80);
  }));

  /* ---------- Задачи: события ---------- */
  const busy = new Set();          // защита от двойных кликов, пока запрос не завершён

  $('#taskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = $('#taskTitle').value.trim();
    if (!title) { $('#taskTitle').focus(); return; }
    const btn = $('button[type=submit]', e.target);
    if (btn.disabled) return;
    btn.disabled = true;
    const res = await mutate('POST', '/api/tasks', { title, prio: $('#taskPrio').value, due: $('#taskDue').value });
    btn.disabled = false;
    if (!res.ok) { toast(errMsg(res)); return; }
    if (state.filter === 'done') { state.filter = 'all'; renderTasks(); }
    e.target.reset();
    $('#taskTitle').focus();
  });

  $('#taskFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    seen.tasks.clear();
    renderTasks();
  });

  $('#taskList').addEventListener('click', async (e) => {
    const li = e.target.closest('.task');
    if (!li) return;
    const task = data.tasks.find(t => t.id === li.dataset.id);
    if (!task || busy.has('t' + task.id)) return;

    if (e.target.closest('[data-del]')) {
      busy.add('t' + task.id);
      li.classList.add('removing');
      const res = await mutate('DELETE', `/api/tasks/${task.id}`, undefined, { minMs: 320 });
      busy.delete('t' + task.id);
      if (!res.ok) { li.classList.remove('removing'); toast(errMsg(res)); if (res.status === 404) refresh(); }
      return;
    }
    if (e.target.closest('.task__check')) {
      busy.add('t' + task.id);
      const want = !task.done;
      // сразу показываем результат (галочка и зачёркивание), а сервер подтвердит
      li.classList.toggle('done', want);
      li.querySelector('.task__check').setAttribute('aria-checked', String(want));
      const res = await mutate('PATCH', `/api/tasks/${task.id}`, { done: want }, { minMs: state.filter !== 'all' ? 450 : 0 });
      busy.delete('t' + task.id);
      if (!res.ok) {
        li.classList.toggle('done', !want);
        li.querySelector('.task__check').setAttribute('aria-checked', String(!want));
        toast(errMsg(res));
        if (res.status === 404) refresh();
      }
    }
  });

  /* ---------- Автоматизации: события ---------- */
  const grid = $('#autoGrid');
  grid.addEventListener('pointermove', (e) => {
    const card = e.target.closest('.auto');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    card.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  grid.addEventListener('change', async (e) => {
    const card = e.target.closest('.auto');
    const a = card && data.autos.find(x => x.id === card.dataset.id);
    if (!a || !e.target.matches('.tgl input')) return;
    const want = e.target.checked;
    card.classList.toggle('off', !want);
    const res = await mutate('PATCH', `/api/automations/${a.id}`, { enabled: want });
    if (res.ok) toast(want ? `«${a.name}» включена` : `«${a.name}» выключена`);
    else { e.target.checked = !want; card.classList.toggle('off', want); toast(errMsg(res)); }
  });

  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.auto');
    const a = card && data.autos.find(x => x.id === card.dataset.id);
    if (!a || busy.has('a' + a.id)) return;

    if (e.target.closest('[data-del]')) {
      if (!confirm(`Удалить автоматизацию «${a.name}»?`)) return;
      const res = await mutate('DELETE', `/api/automations/${a.id}`);
      if (!res.ok) toast(errMsg(res));
      return;
    }
    const runBtn = e.target.closest('[data-run]');
    if (runBtn) {
      busy.add('a' + a.id);
      runBtn.disabled = true;
      runBtn.innerHTML = '<span class="spin"></span>Запуск…';
      const res = await mutate('POST', `/api/automations/${a.id}/run`, {}, { minMs: 700 });
      busy.delete('a' + a.id);
      if (res.ok) toast(`«${res.data.name}» выполнена`);
      else { toast(errMsg(res)); renderAutos(); }
    }
  });

  // Диалог создания
  const dlg = $('#autoDialog');
  const openDlg = () => {
    $('#autoForm').reset();
    $('#autoErr').classList.remove('show');
    dlg.showModal();
    $('#autoName').focus();
  };
  $('#newAuto').addEventListener('click', openDlg);
  $('#quickAuto').addEventListener('click', () => { location.hash = '#automations'; setTimeout(openDlg, 60); });
  $('#autoCancel').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#autoForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#autoName').value.trim();
    const err = $('#autoErr');
    const fail = (m) => { err.textContent = m; err.classList.add('show'); };
    if (name.length < 3) { fail('Введите название, минимум 3 символа'); $('#autoName').focus(); return; }
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    const res = await mutate('POST', '/api/automations', { name, trigger: $('#autoTrigger').value, action: $('#autoAction').value });
    btn.disabled = false;
    if (!res.ok) { fail(errMsg(res)); return; }
    dlg.close();
    toast(`«${name}» создана и включена`);
  });

  /* ---------- Уведомления: события ---------- */
  $('#noteList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.note');
    const n = btn && data.notes.find(x => x.id === btn.dataset.id);
    if (!n || busy.has('n' + n.id)) return;
    busy.add('n' + n.id);
    const want = !n.read;
    btn.classList.toggle('unread', !want);
    const res = await mutate('PATCH', `/api/notifications/${n.id}`, { read: want });
    busy.delete('n' + n.id);
    if (!res.ok) { btn.classList.toggle('unread', want); toast(errMsg(res)); }
  });
  $('#markAll').addEventListener('click', async () => {
    const res = await mutate('POST', '/api/notifications/read-all', {});
    if (!res.ok) toast(errMsg(res));
  });
  $('#clearNotes').addEventListener('click', async () => {
    if (!data.notes.length) return;
    const res = await mutate('DELETE', '/api/notifications');
    if (!res.ok) toast(errMsg(res));
  });

  /* ---------- Telegram и настройки: события ---------- */
  $$('.js-tg-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (data.tg.on) {
      if (!confirm('Отключить Telegram-бота?')) return;
      const res = await mutate('POST', '/api/telegram/disconnect', {});
      toast(res.ok ? 'Бот отключён' : errMsg(res));
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Создаём ссылку…';
    const res = await mutate('POST', '/api/telegram/connect', {});
    if (!res.ok) {
      renderTg();
      toast(res.status === 503 ? 'Бот не настроен на сервере: нужен TELEGRAM_BOT_TOKEN' : res.status === 409 ? 'Telegram уже подключён' : errMsg(res));
      return;
    }
    pending = res.data.pending;
    renderTg();
    if (location.hash !== '#settings') location.hash = '#settings'; else renderSettings();
    startWatch();
  }));

  $('#testTg').addEventListener('click', async () => {
    const res = await mutate('POST', '/api/telegram/test', {});
    if (res.ok) toast('Тест отправлен. Проверьте Telegram');
    else if (res.status === 409 && res.data.error === 'telegram_disabled') toast('Включите «Telegram» в настройках уведомлений или дождитесь лимита');
    else if (res.status === 409) toast('Сначала подключите Telegram-бота');
    else toast(errMsg(res));
  });

  const savePref = async (key, input) => {
    const res = await mutate('PATCH', '/api/prefs', { [key]: input.checked });
    if (!res.ok) { input.checked = !input.checked; toast(errMsg(res)); }
  };
  $('#prefTg').addEventListener('change', (e) => savePref('tg', e.target));
  $('#prefEmail').addEventListener('change', (e) => savePref('email', e.target));

  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#setName').value.trim(), phone = $('#setPhone').value.trim();
    const err = $('#profileErr');
    const words = name.split(/\s+/).filter(w => w.length > 1);
    const digits = phone.replace(/\D/g, '');
    let msg = '';
    if (words.length < 2) msg = 'Укажите имя и фамилию';
    else if (phone && (digits.length < 10 || digits.length > 15)) msg = 'Проверьте номер телефона';
    err.textContent = msg; err.classList.toggle('show', Boolean(msg));
    if (msg) return;

    const res = await apiCall('PATCH', '/api/me', { name, phone });
    if (!res.ok) {
      const f = res.data.fields || {};
      err.textContent = f.name || f.phone || 'Не удалось сохранить профиль';
      err.classList.add('show');
      return;
    }
    data.profile = { name, phone };
    session = { ...session, name, phone };
    renderAll(); toast('Профиль сохранён');
  });


  /* ---------- Тариф ---------- */
  let billing = null;
  const rub = (n) => new Intl.NumberFormat('ru-RU').format(n);
  const dateRu = (ms) => new Date(ms).toLocaleDateString('ru-RU');
  const FEATURES = {
    start: ['Неограниченные задачи', 'Уведомления в кабинете'],
    pro: ['Неограниченные задачи', 'Уведомления в кабинете', 'Приоритетная поддержка'],
    business: ['Неограниченные задачи', 'Уведомления в кабинете', 'Командный доступ (скоро)', 'Выделенная поддержка'],
  };

  // Чип тарифа сверху и счётчик активных автоматизаций (приходят вместе с данными кабинета)
  const renderPlan = () => {
    const p = data.plan;
    if (!p) return;
    $('#planChip').textContent = p.name;
    const pill = $('#autoUsage');
    pill.textContent = `Активных: ${p.usage.automations} из ${p.limits.automations}`;
    pill.classList.toggle('full', p.usage.automations >= p.limits.automations);
  };

  const orderStatus = { paid: 'Оплачен', pending: 'Ожидает оплаты', expired: 'Просрочен' };
  const renderBilling = () => {
    if (!billing) return;
    const p = billing.plan, paid = p.id !== 'start';
    const left = paid ? Math.max(0, Math.ceil((p.periodEnd - Date.now()) / 86400000)) : 0;
    const pct = Math.min(100, Math.round(p.usage.automations / p.limits.automations * 100));
    $('#planNow').innerHTML = `
      <div>
        <span class="eyebrow">Ваш тариф</span>
        <h3>${esc(p.name)}</h3>
        <p class="plan-now__sub">${paid ? `Действует до ${dateRu(p.periodEnd)} (осталось дней: ${left}). Автопродления нет: продлить можно в любой момент.` : 'Бесплатный тариф. Можно перейти на расширенный в любое время.'}</p>
        <div class="usage"><div class="usage__row"><span>Активные автоматизации</span><span><b>${p.usage.automations}</b> из ${p.limits.automations}</span></div>
          <div class="usage__bar ${pct >= 100 ? 'full' : ''}"><i style="width:${pct}%"></i></div></div>
      </div>
      <ul>
        <li class="yes">Неограниченные задачи</li>
        <li class="yes">Уведомления в кабинете</li>
        <li class="${p.limits.telegramNotify ? 'yes' : 'no'}">Уведомления от автоматизаций в Telegram${p.limits.telegramNotify ? '' : ' (тариф «Про»)'}</li>
        <li class="yes">Команды Telegram-бота (/add, /tasks)</li>
      </ul>`;

    const note = $('#billingNote');
    note.hidden = billing.mode === 'off' ? false : billing.mode !== 'demo';
    note.textContent = billing.mode === 'off'
      ? 'Оплата пока не подключена: платные тарифы недоступны.'
      : 'Демо-оплата: деньги не списываются, данные карты не нужны. Позже здесь будет настоящая платёжная система.';

    const rank = { start: 0, pro: 1, business: 2 };
    $('#planGrid').innerHTML = billing.catalog.map((c, i) => {
      const cur = c.id === p.id, lower = rank[c.id] < rank[p.id];
      let btn;
      if (cur && c.id === 'start') btn = '<button class="btn btn--ghost" disabled>Ваш тариф</button>';
      else if (c.id === 'start') btn = '<button class="btn btn--ghost" disabled>Бесплатный</button>';
      else if (lower) btn = '<button class="btn btn--ghost" disabled>Доступно после окончания текущего</button>';
      else if (billing.mode === 'off') btn = '<button class="btn btn--ghost" disabled>Оплата пока недоступна</button>';
      else btn = `<button class="btn btn--primary" data-buy="${c.id}">${cur ? 'Продлить на 30 дней' : `Перейти на «${esc(c.name)}»`}</button>`;
      return `<article class="plan-card ${cur ? 'current' : ''}" style="--d:${i * .08}s">
        ${cur ? '<span class="tag">Ваш тариф</span>' : ''}
        <h4>${esc(c.name)}</h4>
        <div class="price">${rub(c.price)} ₸ <small>${c.price ? '/ 30 дней' : '/ навсегда'}</small></div>
        <ul><li class="yes">До ${c.limits.automations} активных автоматизаций</li>
          <li class="${c.limits.telegramNotify ? 'yes' : 'no'}">Уведомления в Telegram</li>
          ${FEATURES[c.id].filter(f => !/уведомления в кабинете|Неограниченные/i.test(f)).map(f => `<li class="yes">${esc(f)}</li>`).join('')}</ul>
        ${btn}</article>`;
    }).join('');

    $('#orderList').innerHTML = billing.orders.map(o => `<li>
      <div><strong>Тариф «${esc(o.planName)}»</strong><small>${dateRu(o.createdAt)}${o.status === 'pending' ? ' · <a class="panel__link" href="' + afUrl('/checkout?order=' + encodeURIComponent(o.id)) + '">Оплатить</a>' : ''}</small></div>
      <span class="ostatus ostatus--${o.status}">${orderStatus[o.status] || esc(o.status)}</span>
      <span class="amount">${rub(o.amount)} ₸</span></li>`).join('');
    $('#orderEmpty').hidden = billing.orders.length > 0;
  };

  const loadBilling = async () => {
    const res = await apiCall('GET', '/api/billing');
    if (res.ok) { billing = res.data; renderBilling(); } else toast('Не удалось загрузить тарифы');
  };

  $('#planGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-buy]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const res = await apiCall('POST', '/api/billing/checkout', { plan: btn.dataset.buy });
    if (res.ok && /^\/checkout\?order=[\w-]+$/.test(res.data.url)) { location.href = afUrl(res.data.url); return; }
    btn.disabled = false;
    toast(res.status === 503 ? 'Оплата пока не подключена' : errMsg(res));
  });

  /* ---------- Подтверждение email и смена пароля (сервер) ---------- */
  $('#resendVerify').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const res = await apiCall('POST', '/api/verify-email/send', {});
    if (res.ok && res.data.alreadyVerified) { session.emailVerified = true; renderVerify(); toast('Email уже подтверждён'); }
    else if (res.ok) toast('Письмо отправлено. Проверьте почту, в том числе «Спам»');
    else if (res.status === 429) toast('Слишком много запросов. Попробуйте через час');
    else toast('Не удалось отправить письмо');
    setTimeout(() => { btn.disabled = false; }, 30000);
  });

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cur = $('#pwCurrent'), nw = $('#pwNew'), nw2 = $('#pwNew2'), err = $('#pwErr');
    const fail = (msg) => { err.textContent = msg; err.classList.add('show'); };
    err.classList.remove('show');
    if (!cur.value) return fail('Введите текущий пароль');
    if (nw.value.length < 8) return fail('Новый пароль: минимум 8 символов');
    if (!/[A-Za-zА-Яа-яЁё]/.test(nw.value) || !/\d/.test(nw.value)) return fail('Новый пароль: добавьте буквы и цифры');
    if (nw.value !== nw2.value) return fail('Новые пароли не совпадают');
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    const res = await apiCall('POST', '/api/change-password', { current: cur.value, password: nw.value });
    btn.disabled = false;
    if (res.ok) {
      e.target.reset();
      refresh(); toast('Пароль изменён. На других устройствах выполнен выход');
    } else if (res.data.fields && (res.data.fields.current || res.data.fields.password)) fail(res.data.fields.current || res.data.fields.password);
    else if (res.status === 429) fail('Слишком много попыток. Попробуйте позже');
    else fail('Не удалось сменить пароль');
  });

  $('#logoutBtn').addEventListener('click', async () => {
    await apiCall('POST', '/api/logout', {});
    location.href = afUrl('/login');
  });

  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('Вернуть образцы данных? Ваши задачи, автоматизации и уведомления будут удалены.')) return;
    const res = await mutate('POST', '/api/demo/reset', {});
    if (res.ok) { Object.values(seen).forEach(s => s.clear()); renderAll(); renderSettings(); toast('Образцы данных восстановлены'); }
    else toast(errMsg(res));
  });

  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('Удалить аккаунт и все его данные? Это действие необратимо.')) return;
    const password = prompt('Для подтверждения введите ваш пароль:');
    if (!password) return;
    const res = await apiCall('DELETE', '/api/me', { password });
    if (res.ok) { location.href = afUrl('/'); }
    else if (res.status === 403) toast('Неверный пароль');
    else if (res.status === 429) toast('Слишком много попыток, попробуйте позже');
    else toast('Не удалось удалить аккаунт');
  });

  /* ---------- Старт ---------- */
  buildStats();
  const first = await refresh();
  if (!first.ok) { renderAll(); toast('Не удалось загрузить данные. Обновите страницу.'); }
  renderSettings();
  show(location.hash.slice(1));
  setInterval(() => { renderFeed(); renderNotes(); }, 60000);
  // Задачи, добавленные из Telegram, появляются без перезагрузки
  setInterval(() => { if (document.visibilityState === 'visible' && !busy.size && !pending) refresh(); }, 30000);
  // Вернулись на вкладку (или открыт кабинет на другом устройстве): подтягиваем свежие данные
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
})();
