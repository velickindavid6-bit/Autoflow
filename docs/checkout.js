/* Страница оплаты тарифа (демо). Цена и тариф приходят с сервера, здесь только показ и подтверждение. */
(() => {
  const $ = (s) => document.querySelector(s);
  const show = (name) => ['loading', 'orderBox', 'paid', 'problem'].forEach(id => { $('#' + id).hidden = id !== name; });
  const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3500); };
  const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n);
  const problem = (title, text) => { $('#problemTitle').textContent = title; $('#problemText').textContent = text; show('problem'); };

  let csrf = '';
  const api = async (method, url, body) => {
    try {
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
      return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
    } catch (_) { return { ok: false, status: 0, data: {} }; }
  };

  (async () => {
    const orderId = new URLSearchParams(location.search).get('order') || '';
    const ses = await api('GET', '/api/session');
    if (!ses.ok || !ses.data.user) { location.replace(afUrl('/login')); return; }
    csrf = ses.data.csrf;
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(orderId)) { problem('Заказ не найден', 'Вернитесь в кабинет и выберите тариф заново.'); return; }

    const res = await api('GET', `/api/billing/orders/${orderId}`);
    if (!res.ok) { problem('Заказ не найден', 'Вернитесь в кабинет и выберите тариф заново.'); return; }
    const o = res.data.order;
    if (o.status === 'paid') { $('#paidText').textContent = `Тариф «${o.planName}» уже оплачен.`; show('paid'); return; }
    if (o.status === 'expired') { problem('Заказ устарел', 'Заказ действует 30 минут. Создайте новый в кабинете.'); return; }
    if (o.status === 'canceled') { problem('Заказ отменён', 'Создайте новый заказ в кабинете.'); return; }

    const bill = await api('GET', '/api/billing');
    if (bill.ok && bill.data.mode !== 'demo') { problem('Оплата пока недоступна', 'Приём платежей ещё не подключён.'); return; }

    $('#oPlan').textContent = o.planName;
    $('#oAmount').textContent = `${fmt(o.amount)} ₸`;
    show('orderBox');

    const btn = $('#payBtn');
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('loading')) return;
      btn.classList.add('loading');
      const r = await api('POST', `/api/billing/orders/${orderId}/pay`);
      btn.classList.remove('loading');
      if (r.ok) {
        const end = r.data.billing && r.data.billing.plan && r.data.billing.plan.periodEnd;
        $('#paidText').textContent = `Тариф «${o.planName}» активирован${end ? ` до ${new Date(end).toLocaleDateString('ru-RU')}` : ''}.`;
        show('paid');
      } else if (r.status === 409) problem('Уже оплачено или отменено', 'Проверьте раздел «Тариф» в кабинете.');
      else if (r.status === 410) problem('Заказ устарел', 'Создайте новый заказ в кабинете.');
      else if (r.status === 403) problem('Оплата пока недоступна', 'Приём платежей ещё не подключён.');
      else toast('Не удалось оплатить. Попробуйте ещё раз.');
    });
    $('#cancelBtn').addEventListener('click', async () => {
      await api('POST', `/api/billing/orders/${orderId}/cancel`);
      location.href = afUrl('/dashboard#billing');
    });
  })();
})();
