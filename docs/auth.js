/* ==========================================================
   AutoFlow — логика страниц входа и регистрации
   ========================================================== */
(() => {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer  = matchMedia('(pointer: fine)').matches;

  /* ---------- Запросы к серверу ---------- */
  const api = async (url, body) => {
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await r.json(); } catch (_) {}
      return { ok: r.ok, status: r.status, data };
    } catch (_) {
      return { ok: false, status: 0, data: {} };
    }
  };
  // Пришли с тарифа на главной (?plan=pro): после регистрации ведём сразу к выбору тарифа
  const wantedPlan = new URLSearchParams(location.search).get('plan');
  const cabinetUrl = ['pro', 'business'].includes(wantedPlan) ? '/dashboard#billing' : '/dashboard';
  const goToCabinet = (delay) => setTimeout(() => { location.href = afUrl(cabinetUrl); }, reduceMotion ? 300 : delay);
  const NET_ERR = 'Не удалось связаться с сервером. Проверьте соединение.';
  const LIMIT_ERR = 'Слишком много попыток. Попробуйте чуть позже.';

  /* ---------- Тост ---------- */
  const toast = $('#toast');
  let toastTimer;
  const showToast = (text) => {
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3400);
  };

  /* ---------- Наклон значка за курсором ---------- */
  const icon = $('.hero-icon');
  if (icon && !reduceMotion && finePointer) {
    let tx = 0, ty = 0, cx = 0, cy = 0;
    addEventListener('mousemove', (e) => {
      tx = (e.clientX / innerWidth - 0.5) * 2;
      ty = (e.clientY / innerHeight - 0.5) * 2;
    });
    document.addEventListener('mouseleave', () => { tx = 0; ty = 0; });
    const tick = () => {
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      icon.style.setProperty('--tx', cx.toFixed(3));
      icon.style.setProperty('--ty', cy.toFixed(3));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- Показать / скрыть пароль ---------- */
  $$('.eye').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      input.focus({ preventScroll: true });
    });
  });

  /* ---------- Google (подключим на следующем шаге) ---------- */
  const googleBtn = $('#googleBtn');
  if (googleBtn) {
    googleBtn.addEventListener('click', () => showToast('Вход через Google подключим на следующем шаге'));
  }

  /* ---------- Форма входа ---------- */
  const loginForm = $('#loginForm');
  if (loginForm) {
    const email = $('#email'), pass = $('#password'), remember = $('#remember');
    const KEY = 'autoflow:email';

    // Подставляем запомненный email
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) { email.value = saved; remember.checked = true; }
    } catch (_) {}

    const check = (input, message) => {
      const row = input.closest('.row');
      $('.err', row).textContent = message;
      row.classList.toggle('invalid', Boolean(message));
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
      return !message;
    };
    const vEmail = () => check(email, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim()) ? '' : 'Введите корректный email');
    const vPass  = () => check(pass, pass.value ? '' : 'Введите пароль');

    email.addEventListener('blur', () => { if (email.value) vEmail(); });
    [email, pass].forEach(el => el.addEventListener('input', () => {
      if (el.closest('.row').classList.contains('invalid')) (el === email ? vEmail : vPass)();
    }));

    // После успешного сброса пароля страница сброса присылает сюда с ?reset=1
    if (new URLSearchParams(location.search).get('reset') === '1') {
      showToast('Пароль изменён. Войдите с новым паролем.');
      history.replaceState(null, '', location.pathname);
    }

    const btn = $('.btn-submit', loginForm);
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.classList.contains('loading')) return;
      const okEmail = vEmail(), okPass = vPass();
      if (!okEmail || !okPass) {
        const bad = okEmail ? pass : email;
        const row = bad.closest('.row');
        row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
        bad.focus();
        return;
      }
      btn.classList.add('loading');
      try {
        if (remember.checked) localStorage.setItem(KEY, email.value.trim());
        else localStorage.removeItem(KEY);
      } catch (_) {}

      const res = await api('/api/login', { email: email.value.trim(), password: pass.value });
      btn.classList.remove('loading');

      if (!res.ok) {
        if (res.status === 401) {
          check(pass, 'Неверный email или пароль');
          const row = pass.closest('.row');
          row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
          pass.focus();
        } else if (res.status === 429) showToast(LIMIT_ERR);
        else showToast(NET_ERR);
        return;
      }
      const name = res.data.user.name;
      $('#successText').textContent = `${name.split(/\s+/)[0]}, переходим в личный кабинет…`;
      $('#card').classList.add('is-done');
      $('#success').hidden = false;
      $('#success').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      goToCabinet(1400);
    });
    return;
  }

  /* ---------- Общие помощники для страниц восстановления ---------- */
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const setErr = (input, message) => {
    const row = input.closest('.row');
    $('.err', row).textContent = message;
    row.classList.toggle('invalid', Boolean(message));
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    return !message;
  };
  const shake = (input) => {
    const row = input.closest('.row');
    row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
    input.focus();
  };
  // Токен приходит во фрагменте ссылки (#token=...): браузер не отправляет его на сервер.
  // Читаем его и сразу убираем из адресной строки; на случай обновления страницы держим копию в sessionStorage вкладки.
  const takeToken = (storeKey) => {
    let token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') || '';
    if (token) {
      try { sessionStorage.setItem(storeKey, token); } catch (_) {}
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      try { token = sessionStorage.getItem(storeKey) || ''; } catch (_) {}
    }
    return token;
  };

  /* ---------- Запрос ссылки для сброса пароля ---------- */
  const forgotForm = $('#forgotForm');
  if (forgotForm) {
    const email = $('#email'), btn = $('.btn-submit', forgotForm);
    const vEmail = () => setErr(email, EMAIL_RE.test(email.value.trim()) ? '' : 'Введите корректный email');
    email.addEventListener('blur', () => { if (email.value) vEmail(); });
    email.addEventListener('input', () => { if (email.closest('.row').classList.contains('invalid')) vEmail(); });

    const request = () => api('/api/forgot-password', { email: email.value.trim() });

    // Кнопка «отправить ещё раз» с паузой, чтобы не спамить
    const resendBtn = $('#resendBtn');
    const cooldown = (sec) => {
      resendBtn.disabled = true;
      const tick = () => {
        if (sec <= 0) { resendBtn.disabled = false; resendBtn.textContent = 'отправьте ещё раз'; return; }
        resendBtn.textContent = `отправьте ещё раз (${sec} с)`; sec--; setTimeout(tick, 1000);
      };
      tick();
    };
    resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true;
      const res = await request();
      if (res.status === 429) showToast(LIMIT_ERR);
      else if (res.ok) showToast('Письмо отправлено повторно');
      else showToast(NET_ERR);
      cooldown(30);
    });

    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.classList.contains('loading')) return;
      if (!vEmail()) { shake(email); return; }
      btn.classList.add('loading');
      const res = await request();
      btn.classList.remove('loading');
      if (res.status === 429) { showToast(LIMIT_ERR); return; }
      if (res.status === 400 && res.data.fields && res.data.fields.email) { setErr(email, res.data.fields.email); shake(email); return; }
      if (!res.ok) { showToast(NET_ERR); return; }
      $('#card').classList.add('is-done');
      $('#success').hidden = false;
      cooldown(30);
    });
    return;
  }

  /* ---------- Новый пароль по ссылке из письма ---------- */
  const resetForm = $('#resetForm');
  if (resetForm) {
    const token = takeToken('af:reset');
    const panels = { loading: $('#loading'), form: $('#resetArea'), success: $('#success'), invalid: $('#invalid') };
    const showPanel = (name) => Object.entries(panels).forEach(([k, el]) => { el.hidden = k !== name; });

    (async () => {
      const res = token ? await api('/api/reset-password/check', { token }) : { ok: false, data: {} };
      if (res.status === 429) { showPanel('invalid'); showToast(LIMIT_ERR); return; }
      showPanel(res.ok && res.data.valid ? 'form' : 'invalid');
      if (res.ok && res.data.valid) $('#password').focus({ preventScroll: true });
    })();

    const pass = $('#password'), conf = $('#confirm'), btn = $('.btn-submit', resetForm);
    const vPass = () => {
      const v = pass.value;
      return setErr(pass, v.length < 8 ? 'Минимум 8 символов' : (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) ? 'Добавьте буквы и цифры' : '');
    };
    const vConf = () => setErr(conf, !conf.value ? 'Повторите пароль' : conf.value !== pass.value ? 'Пароли не совпадают' : '');

    const meter = $('#meter'), meterText = $('#meterText');
    const levels = ['', 'Слабый', 'Средний', 'Хороший', 'Надёжный'];
    pass.addEventListener('input', () => {
      const v = pass.value; let s = 0;
      if (v.length >= 8) s++;
      if (/[a-zа-яё]/.test(v) && /[A-ZА-ЯЁ]/.test(v)) s++;
      if (/\d/.test(v)) s++;
      if (/[^A-Za-zА-Яа-яЁё0-9]/.test(v) || v.length >= 12) s++;
      const lvl = v ? Math.max(1, s) : 0;
      meter.classList.toggle('show', lvl > 0); meter.dataset.level = lvl; meterText.textContent = levels[lvl];
      if (pass.closest('.row').classList.contains('invalid')) vPass();
      if (conf.value) vConf();
    });
    conf.addEventListener('input', () => { if (conf.closest('.row').classList.contains('invalid')) vConf(); });

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.classList.contains('loading')) return;
      const okP = vPass(), okC = vConf();
      if (!okP || !okC) { shake(okP ? conf : pass); return; }
      btn.classList.add('loading');
      const res = await api('/api/reset-password', { token, password: pass.value });
      btn.classList.remove('loading');
      if (res.ok) {
        try { sessionStorage.removeItem('af:reset'); } catch (_) {}
        showPanel('success');
        setTimeout(() => { location.href = afUrl('/login?reset=1'); }, reduceMotion ? 800 : 3500);
      } else if (res.status === 400 && res.data.error === 'invalid_token') showPanel('invalid');
      else if (res.status === 400 && res.data.fields && res.data.fields.password) { setErr(pass, res.data.fields.password); shake(pass); }
      else if (res.status === 429) showToast(LIMIT_ERR);
      else showToast(NET_ERR);
    });
    return;
  }

  /* ---------- Подтверждение email по ссылке из письма ---------- */
  if (/\/verify-email(\.html)?$/.test(location.pathname)) {
    const token = takeToken('af:verify');
    const done = (ok) => { $('#loading').hidden = true; (ok ? $('#success') : $('#invalid')).hidden = false; };
    (async () => {
      if (!token) { done(false); return; }
      const res = await api('/api/verify-email', { token });
      if (res.ok) { try { sessionStorage.removeItem('af:verify'); } catch (_) {} }
      if (res.status === 429) showToast(LIMIT_ERR);
      done(res.ok);
    })();
    return;
  }

  /* ---------- Форма регистрации ---------- */
  const form = $('#regForm');
  if (!form) return;

  const f = {
    name:     $('#name'),
    email:    $('#email'),
    phone:    $('#phone'),
    password: $('#password'),
    confirm:  $('#confirm'),
  };

  const rules = {
    name(v) {
      const words = v.trim().split(/\s+/).filter(w => w.length > 1);
      return words.length >= 2 ? '' : 'Укажите имя и фамилию';
    },
    email(v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Введите корректный email';
    },
    phone(v) {
      const digits = v.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 15 ? '' : 'Введите номер, например +7 700 123 45 67';
    },
    password(v) {
      if (v.length < 8) return 'Минимум 8 символов';
      if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) return 'Добавьте буквы и цифры';
      return '';
    },
    confirm(v) {
      if (!v) return 'Повторите пароль';
      return v === f.password.value ? '' : 'Пароли не совпадают';
    },
  };

  const setState = (key, message) => {
    const row = f[key].closest('.row');
    const err = $('.err', row);
    err.textContent = message;
    row.classList.toggle('invalid', Boolean(message));
    row.classList.toggle('valid', !message && f[key].value !== '');
    f[key].setAttribute('aria-invalid', message ? 'true' : 'false');
  };

  const validate = (key) => {
    const message = rules[key](f[key].value);
    setState(key, message);
    return !message;
  };

  // Телефон: оставляем только допустимые символы
  f.phone.addEventListener('input', () => {
    f.phone.value = f.phone.value.replace(/[^\d+\s()-]/g, '');
  });

  // Индикатор надёжности пароля
  const meter = $('#meter');
  const meterText = $('#meterText');
  const levels = ['', 'Слабый', 'Средний', 'Хороший', 'Надёжный'];
  const strength = (v) => {
    if (!v) return 0;
    let s = 0;
    if (v.length >= 8) s++;
    if (/[a-zа-яё]/.test(v) && /[A-ZА-ЯЁ]/.test(v)) s++;
    if (/\d/.test(v)) s++;
    if (/[^A-Za-zА-Яа-яЁё0-9]/.test(v) || v.length >= 12) s++;
    return Math.max(1, s);
  };

  f.password.addEventListener('input', () => {
    const lvl = strength(f.password.value);
    meter.classList.toggle('show', lvl > 0);
    meter.dataset.level = lvl;
    meterText.textContent = levels[lvl];
    if (f.confirm.value) validate('confirm');
  });

  // Проверка при уходе с поля, снятие ошибки при вводе
  Object.keys(f).forEach(key => {
    f[key].addEventListener('blur', () => { if (f[key].value !== '') validate(key); });
    f[key].addEventListener('input', () => {
      if (f[key].closest('.row').classList.contains('invalid')) validate(key);
    });
  });

  // Отправка
  const submitBtn = $('.btn-submit', form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.classList.contains('loading')) return;

    const results = Object.keys(f).map(key => [key, validate(key)]);
    const firstBad = results.find(([, ok]) => !ok);
    if (firstBad) {
      const row = f[firstBad[0]].closest('.row');
      row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
      f[firstBad[0]].focus();
      return;
    }

    submitBtn.classList.add('loading');
    const res = await api('/api/register', {
      name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value,
    });
    submitBtn.classList.remove('loading');

    if (!res.ok) {
      const fields = res.data.fields || {};
      const keys = Object.keys(fields).filter(k => f[k]);
      if (keys.length) {
        keys.forEach(k => setState(k, fields[k]));
        const row = f[keys[0]].closest('.row');
        row.classList.remove('shake'); void row.offsetWidth; row.classList.add('shake');
        f[keys[0]].focus();
      } else if (res.status === 429) showToast(LIMIT_ERR);
      else showToast(NET_ERR);
      return;
    }

    const first = res.data.user.name.split(/\s+/)[0];
    $('#successText').textContent = `${first}, добро пожаловать в AutoFlow! Мы отправили письмо для подтверждения email. Открываем личный кабинет…`;
    goToCabinet(3200);
    $('#card').classList.add('is-done');
    $('#success').hidden = false;
    $('#success').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  });
})();
