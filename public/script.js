/* ==========================================================
   AutoFlow — интерактив и анимации
   ========================================================== */
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer  = matchMedia('(pointer: fine)').matches;

  /* ---------- Если пользователь уже вошёл (проверяет сервер по cookie) ---------- */
  const showLoggedIn = () => {
    $$('.img-btn').forEach(el => el.remove());
    $('.header__actions').insertAdjacentHTML('afterbegin', `<a href="${afUrl('/dashboard')}" class="btn btn--primary btn--sm cabinet-btn">Личный кабинет</a>`);
    $$('[data-cta]').forEach(el => el.setAttribute('href', afUrl('/dashboard')));
    $$('[data-plan]').forEach(el => el.setAttribute('href', afUrl('/dashboard#billing')));
    const heroCta = $('.hero__actions .btn--primary');
    if (heroCta) heroCta.setAttribute('href', afUrl('/dashboard'));
    const navLogin = $('.nav__login');
    if (navLogin) { navLogin.textContent = 'Кабинет'; navLogin.setAttribute('href', afUrl('/dashboard')); }
    $$('[data-guest]').forEach(el => { el.hidden = true; });
    $$('[data-user]').forEach(el => { el.hidden = false; });
  };
  fetch('/api/session', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => { if (d && d.user) showLoggedIn(); })
    .catch(() => {});

  $('#year') && ($('#year').textContent = new Date().getFullYear());

  /* ---------- Шапка: фон при скролле ---------- */
  const header = $('.header');
  const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Мобильное меню ---------- */
  const burger = $('.burger');
  const nav = $('#nav');
  const setMenu = (open) => {
    nav.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
  };
  burger.addEventListener('click', () => setMenu(!nav.classList.contains('open')));
  $$('a', nav).forEach(a => a.addEventListener('click', () => setMenu(false)));
  addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  /* ---------- Масштабирование визуала (ноутбук + телефон) ---------- */
  const visual = $('.hero__visual');
  const stage  = $('.stage');
  const STAGE_W = 640, STAGE_H = 540;

  const fitStage = () => {
    const w = visual.parentElement.clientWidth;
    const available = Math.min(w, visual.clientWidth || w);
    const scale = Math.min(1, available / STAGE_W);
    const offset = Math.max(0, (available - STAGE_W * scale) / 2);
    stage.style.transform = `translateX(${offset}px) scale(${scale})`;
    visual.style.height = STAGE_H * scale + 'px';
  };
  fitStage();
  addEventListener('resize', fitStage);
  if (document.fonts) document.fonts.ready.then(fitStage);

  /* ---------- Появление блоков при скролле ---------- */
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  $$('[data-reveal]').forEach(el => revealObserver.observe(el));

  /* ---------- Счётчики в дашборде ---------- */
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const countUp = (el, duration = 1400) => {
    const target = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    if (reduceMotion) { el.textContent = target + suffix; return; }
    const start = performance.now();
    const step = (now) => {
      const p = Math.min((now - start) / duration, 1);
      el.textContent = Math.round(target * easeOut(p)) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = '0' + suffix;
    requestAnimationFrame(step);
  };
  setTimeout(() => $$('[data-count]').forEach(el => countUp(el)), 900);

  /* ---------- Уведомления в телефоне появляются по очереди ---------- */
  $$('.msg').forEach((msg, i) => {
    setTimeout(() => msg.classList.add('show'), reduceMotion ? 0 : 1500 + i * 850);
  });

  /* ---------- Параллакс от курсора в hero ---------- */
  if (!reduceMotion && finePointer) {
    const hero = $('.hero');
    const layers = $$('.layer', stage);
    let tx = 0, ty = 0, cx = 0, cy = 0;

    hero.addEventListener('mousemove', (e) => {
      const r = hero.getBoundingClientRect();
      tx = (e.clientX - r.left) / r.width - 0.5;
      ty = (e.clientY - r.top) / r.height - 0.5;
    });
    hero.addEventListener('mouseleave', () => { tx = 0; ty = 0; });

    const tick = () => {
      cx += (tx - cx) * 0.07;
      cy += (ty - cy) * 0.07;
      layers.forEach(l => {
        const d = Number(l.dataset.depth || 0);
        l.style.transform = `translate3d(${(-cx * d).toFixed(2)}px, ${(-cy * d).toFixed(2)}px, 0)`;
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Подсветка карточки под курсором ---------- */
  $$('.card').forEach(card => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
    });
  });

  /* ---------- Активный пункт меню при скролле ---------- */
  const links = $$('.nav a:not(.nav__login)');
  const sections = links
    .map(a => $(a.getAttribute('href')))
    .filter(Boolean);

  const spy = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + entry.target.id));
    });
  }, { rootMargin: '-45% 0px -50% 0px' });
  sections.forEach(s => spy.observe(s));

  /* ---------- Последний пункт меню подсвечивается у нижнего края страницы ---------- */
  const lastLink = links.find(a => a.getAttribute('href') === '#contacts');
  if (lastLink) {
    addEventListener('scroll', () => {
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) {
        links.forEach(a => a.classList.toggle('active', a === lastLink));
      }
    }, { passive: true });
  }

  /* ---------- Форма «Контакты» ---------- */
  const cform = $('#contactForm');
  if (cform) {
    const fields = { name: $('#cName'), email: $('#cEmail'), message: $('#cMsg') };
    const trap = $('#cWebsite');            // скрытое поле-ловушка для ботов (людям не видно)
    const showErr = (key, msg) => {
      const el = $(`.cerr[data-for="${key}"]`, cform);
      el.textContent = msg; el.classList.toggle('show', Boolean(msg));
      fields[key].setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    const rules = {
      name: v => (v.trim().length < 2 ? 'Укажите имя' : ''),
      email: v => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Введите корректный email'),
      message: v => (v.trim().length < 10 ? 'Напишите хотя бы пару предложений (от 10 символов)' : ''),
    };
    Object.keys(fields).forEach(k => fields[k].addEventListener('input', () => {
      if ($(`.cerr[data-for="${k}"]`, cform).classList.contains('show')) showErr(k, rules[k](fields[k].value));
    }));

    const btn = $('.cform__btn', cform), ok = $('#contactOk');
    cform.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.classList.contains('loading')) return;
      ok.hidden = true;
      let bad = null;
      Object.keys(fields).forEach(k => { const m = rules[k](fields[k].value); showErr(k, m); if (m && !bad) bad = k; });
      if (bad) { fields[bad].focus(); return; }

      btn.classList.add('loading');
      try {
        const r = await fetch('/api/contact', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fields.name.value, email: fields.email.value, message: fields.message.value, website: trap ? trap.value : '' }),
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok) { cform.reset(); ok.hidden = false; }
        else if (data.fields) Object.entries(data.fields).forEach(([k, m]) => fields[k] && showErr(k, m));
        else if (r.status === 429) showErr('message', 'Слишком много сообщений. Попробуйте чуть позже.');
        else showErr('message', 'Не удалось отправить. Проверьте соединение и попробуйте ещё раз.');
      } catch (_) {
        showErr('message', 'Не удалось отправить. Проверьте соединение и попробуйте ещё раз.');
      } finally { btn.classList.remove('loading'); }
    });
  }
})();
