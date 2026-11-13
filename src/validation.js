const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/g;

const str = (v) => (typeof v === 'string' ? v : '');

export function cleanName(v) { return str(v).replace(CTRL_RE, ' ').replace(/\s+/g, ' ').trim(); }
export function cleanEmail(v) { return str(v).trim().toLowerCase(); }
export function cleanPhone(v) { return str(v).replace(CTRL_RE, '').trim(); }

export const checks = {
  name(v) {
    if (v.length > 100 || /[<>]/.test(v)) return 'Недопустимые символы в имени';
    return v.split(' ').filter(w => w.length > 1).length >= 2 ? '' : 'Укажите имя и фамилию';
  },
  email(v) {
    return v.length <= 254 && EMAIL_RE.test(v) ? '' : 'Введите корректный email';
  },
  phone(v, { required } = {}) {
    if (!v) return required ? 'Введите номер, например +7 700 123 45 67' : '';
    const digits = v.replace(/\D/g, '');
    return v.length <= 32 && /^[\d+\s()-]+$/.test(v) && digits.length >= 10 && digits.length <= 15
      ? '' : 'Введите номер, например +7 700 123 45 67';
  },
  password(v) {
    if (typeof v !== 'string' || v.length < 8) return 'Минимум 8 символов';
    if (v.length > 128) return 'Максимум 128 символов';
    if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) return 'Добавьте буквы и цифры';
    return '';
  },
};

const collect = (pairs) => {
  const errors = {};
  for (const [k, msg] of pairs) if (msg) errors[k] = msg;
  return errors;
};

export function validateRegister(body) {
  const v = { name: cleanName(body.name), email: cleanEmail(body.email), phone: cleanPhone(body.phone), password: body.password };
  return {
    value: v,
    errors: collect([
      ['name', checks.name(v.name)],
      ['email', checks.email(v.email)],
      ['phone', checks.phone(v.phone, { required: true })],
      ['password', checks.password(v.password)],
    ]),
  };
}

export function validateProfile(body) {
  const v = { name: cleanName(body.name), phone: cleanPhone(body.phone) };
  return { value: v, errors: collect([['name', checks.name(v.name)], ['phone', checks.phone(v.phone)]]) };
}

export function validateContact(body) {
  const v = {
    name: cleanName(body.name),
    email: cleanEmail(body.email),
    message: str(body.message).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(),
  };
  const nameErr = v.name.length < 2 || v.name.length > 100 || /[<>]/.test(v.name) ? 'Укажите имя' : '';
  const msgErr = v.message.length < 10 ? 'Напишите хотя бы пару предложений (от 10 символов)'
    : v.message.length > 2000 ? 'Сообщение слишком длинное (максимум 2000 символов)' : '';
  return { value: v, errors: collect([['name', nameErr], ['email', checks.email(v.email)], ['message', msgErr]]) };
}
