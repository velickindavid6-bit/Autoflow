import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { PLANS, PAID_PLANS, CURRENCY, PERIOD_DAYS, ORDER_TTL_MIN } from './plans.js';

/* ==========================================================
   Тарифы и оплата (ЗАГЛУШКА).

   Режимы (PAYMENTS_MODE):
     off  — оплата выключена: платный тариф получить нельзя (по умолчанию в production)
     demo — демонстрационная оплата: деньги не списываются, тариф выдаётся бесплатно

   Как это подключится к настоящей платёжной системе:
     1. checkout() создаёт заказ и вместо внутренней страницы /checkout возвращает ссылку оплаты провайдера;
     2. провайдер присылает на сервер подтверждение (webhook): после проверки его подписи
        вызывается applyPayment(orderId, providerRef). Эта функция уже идемпотентна:
        повторная доставка того же подтверждения тариф дважды не продлит.

   Безопасность: цена и тариф берутся на сервере и фиксируются в заказе, клиент присылает только код тарифа;
   заказ виден только владельцу (чужой = 404); у заказа случайный адрес; оплата атомарна.
   Автопродления нет: тариф действует до конца оплаченного периода и затем возвращается к «Старт».
   ========================================================== */

const DAY = 86400000;
const rankOf = (id) => PLANS[id].rank;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export function createBilling({ db, config, data }) {
  const mode = config.billing.mode;
  const q = {
    getSub: db.prepare('SELECT plan, period_end FROM subscriptions WHERE user_id = ?'),
    upsertSub: db.prepare(`INSERT INTO subscriptions (user_id, plan, period_end, updated_at) VALUES (?, ?, ?, ?)
                           ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, period_end = excluded.period_end, updated_at = excluded.updated_at`),
    dropPending: db.prepare("UPDATE orders SET status = 'canceled' WHERE user_id = ? AND status = 'pending'"),
    insOrder: db.prepare('INSERT INTO orders (public_id, user_id, plan, amount, currency, status, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    byPublic: db.prepare('SELECT id, public_id, plan, amount, currency, status, created_at, paid_at FROM orders WHERE public_id = ? AND user_id = ?'),
    list: db.prepare("SELECT public_id, plan, amount, currency, status, created_at, paid_at FROM orders WHERE user_id = ? AND status <> 'canceled' ORDER BY id DESC LIMIT 20"),
    // атомарно: один заказ можно оплатить только один раз, и только пока он не просрочен
    markPaid: db.prepare("UPDATE orders SET status = 'paid', paid_at = ?, provider_ref = ? WHERE id = ? AND status = 'pending' AND created_at > ? RETURNING user_id, plan"),
    cancelOrder: db.prepare("UPDATE orders SET status = 'canceled' WHERE id = ? AND status = 'pending'"),
  };

  const catalog = () => Object.values(PLANS).map(p => ({
    id: p.id, name: p.name, price: p.price, currency: CURRENCY,
    limits: { automations: p.automations, telegramNotify: p.telegramNotify },
  }));

  const view = (o) => {
    const expiresAt = o.created_at + ORDER_TTL_MIN * 60000;
    const expired = o.status === 'pending' && expiresAt <= Date.now();
    return {
      id: o.public_id, plan: o.plan, planName: PLANS[o.plan].name, amount: o.amount, currency: o.currency,
      status: expired ? 'expired' : o.status, createdAt: o.created_at, paidAt: o.paid_at || 0, expiresAt,
    };
  };

  const requireMode = () => { if (mode === 'off') throw new HttpError(503, 'payments_disabled'); };
  const ownOrder = (userId, publicId) => {
    const o = typeof publicId === 'string' ? q.byPublic.get(publicId, userId) : null;
    if (!o) throw new HttpError(404, 'not_found');          // чужой заказ выглядит как несуществующий
    return o;
  };

  /* ---------- Состояние для кабинета ---------- */
  function overview(userId) {
    data.ensureSeeded(userId);
    data.syncPlan(userId);
    return { mode, catalog: catalog(), plan: data.planSummary(userId), orders: q.list.all(userId).map(view) };
  }

  /* ---------- Оформление ---------- */
  function checkout(userId, body) {
    requireMode();
    const planId = body && body.plan;
    if (typeof planId !== 'string' || !PAID_PLANS.includes(planId)) throw new HttpError(400, 'validation', { fields: { plan: 'Выберите тариф «Про» или «Бизнес»' } });
    data.syncPlan(userId);
    if (rankOf(planId) < rankOf(data.planIdOf(userId))) {
      throw new HttpError(409, 'plan_downgrade', { fields: { plan: 'У вас уже действует более высокий тариф. Понизить его можно после окончания периода.' } });
    }
    const plan = PLANS[planId];
    const publicId = crypto.randomBytes(16).toString('base64url');
    data.tx(() => {
      q.dropPending.run(userId);                                                                   // старые неоплаченные заказы отменяются
      q.insOrder.run(publicId, userId, planId, plan.price, CURRENCY, 'pending', mode, Date.now()); // сумма берётся ТОЛЬКО из тарифов на сервере
    });
    return { order: view(q.byPublic.get(publicId, userId)), url: `/checkout?order=${publicId}` };
  }

  const getOrder = (userId, publicId) => view(ownOrder(userId, publicId));

  /* ---------- Применение оплаты (общая точка для демо и будущих webhook) ---------- */
  function applyPayment(orderId, providerRef = null) {
    const row = q.markPaid.get(Date.now(), providerRef, orderId, Date.now() - ORDER_TTL_MIN * 60000);
    if (!row) return null;                                         // уже оплачен, отменён или просрочен: ничего не делаем
    const { user_id: userId, plan } = row;
    const sub = q.getSub.get(userId), now = Date.now();
    // тот же тариф ещё действует: продлеваем; иначе новый период начинается сейчас (без перерасчёта остатка)
    const end = sub && sub.plan === plan && sub.period_end > now ? sub.period_end + PERIOD_DAYS * DAY : now + PERIOD_DAYS * DAY;
    q.upsertSub.run(userId, plan, end, now);
    data.addFeed(userId, `Тариф «${PLANS[plan].name}» активирован`, `до ${fmtDate(end)}`, 'ok');
    data.addNote(userId, `Тариф «${PLANS[plan].name}» активирован до ${fmtDate(end)}`, 'ok');
    return { userId, plan, periodEnd: end };
  }

  function payDemo(userId, publicId) {
    if (mode !== 'demo') throw new HttpError(403, 'demo_disabled');
    const o = ownOrder(userId, publicId);
    const status = view(o).status;
    if (status === 'paid') throw new HttpError(409, 'already_paid');
    if (status === 'canceled') throw new HttpError(409, 'order_canceled');
    if (status === 'expired') throw new HttpError(410, 'order_expired');
    data.tx(() => { if (!applyPayment(o.id, `demo_${crypto.randomBytes(6).toString('hex')}`)) throw new HttpError(409, 'already_paid'); });
    return getOrder(userId, publicId);
  }

  function cancelOrder(userId, publicId) {
    const o = ownOrder(userId, publicId);
    q.cancelOrder.run(o.id);
    return getOrder(userId, publicId);
  }

  return { mode, overview, checkout, getOrder, payDemo, cancelOrder, applyPayment };
}
