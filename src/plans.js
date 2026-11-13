/* Тарифы. Единственный источник правды о ценах и ограничениях: клиент присылает только код тарифа, всё остальное берётся здесь. */
export const PLANS = {
  start:    { id: 'start',    name: 'Старт',  price: 0,      automations: 3,   telegramNotify: false, rank: 0 },
  pro:      { id: 'pro',      name: 'Про',    price: 4900,   automations: 25,  telegramNotify: true,  rank: 1 },
  business: { id: 'business', name: 'Бизнес', price: 14900,  automations: 100, telegramNotify: true,  rank: 2 },
};
export const PAID_PLANS = ['pro', 'business'];
export const CURRENCY = 'KZT';
export const PERIOD_DAYS = 30;          // длительность оплаченного периода
export const ORDER_TTL_MIN = 30;        // сколько живёт неоплаченный заказ
