#!/usr/bin/env node
/* ==========================================================
   Сборка демо-версии для GitHub Pages (статический сайт без сервера).

   Запуск:   npm run build:demo
   Настройки: demo.config.json (repoUrl, outDir, paymentsMode) или ключи --repo, --out, --payments
   Результат: папка docs/ (её и публикует GitHub Pages)
   ========================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Страницы сервера → файлы статического сайта (относительные адреса работают и на github.io/репозиторий/, и при открытии с диска)
export const ROUTES = {
  '/': 'index.html', '/login': 'login.html', '/register': 'register.html', '/dashboard': 'dashboard.html',
  '/forgot-password': 'forgot-password.html', '/reset-password': 'reset-password.html', '/verify-email': 'verify-email.html',
  '/terms': 'terms.html', '/privacy': 'privacy.html', '/checkout': 'checkout.html',
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripExports = (code) => code.replace(/^export\s+/gm, '');

/** Движок (правила и цены из src/ + демо-сервер). Используется и в сборке, и в автотестах. */
export function engineBundle() {
  const plans = read('src/plans.js'), validation = read('src/validation.js');
  if (/^\s*import\s/m.test(plans) || /^\s*import\s/m.test(validation)) throw new Error('plans.js и validation.js должны оставаться без import: их вставляют в браузерный код');
  return `${stripExports(plans)}\n${stripExports(validation)}\n${read('demo/engine.js')}`;
}

function loadConfig(argv) {
  let cfg = { repoUrl: '', outDir: 'docs', paymentsMode: 'demo' };
  try { cfg = { ...cfg, ...JSON.parse(read('demo.config.json')) }; } catch { /* файла нет: значения по умолчанию */ }
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  if (arg('--repo') !== undefined) cfg.repoUrl = arg('--repo');
  if (arg('--out')) cfg.outDir = arg('--out');
  if (arg('--payments')) cfg.paymentsMode = arg('--payments');
  if (!['off', 'demo'].includes(cfg.paymentsMode)) throw new Error('paymentsMode должен быть off или demo');
  if (cfg.repoUrl && !/^https:\/\/[\w.-]+\/[\w./-]+$/.test(cfg.repoUrl)) throw new Error('repoUrl должен быть ссылкой вида https://github.com/логин/репозиторий');
  return cfg;
}

// Относительный адрес для ссылок в HTML: "/login?x" → "login.html?x", "/auth.css" → "auth.css"
function relocate(p, suffix, publicDir) {
  if (Object.prototype.hasOwnProperty.call(ROUTES, p)) return ROUTES[p] + (suffix || '');
  const file = p.slice(1);
  if (fs.existsSync(path.join(publicDir, file))) return file + (suffix || '');
  return null;
}

export function buildDemo({ outDir = 'docs', repoUrl = '', paymentsMode = 'demo' } = {}) {
  const publicDir = path.join(ROOT, 'public');
  const out = path.resolve(ROOT, outDir);
  if (!out.startsWith(ROOT + path.sep) || out === ROOT || ['', 'public', 'src', 'test', 'demo', 'scripts'].includes(path.relative(ROOT, out))) {
    throw new Error(`Небезопасная папка вывода: ${out}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const unresolved = [];
  const copy = (dir, rel = '') => {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(path.join(out, r), { recursive: true }); copy(dir, r); continue; }
      if (r.endsWith('.html')) {
        let html = fs.readFileSync(path.join(dir, r), 'utf8');
        html = html.replace(/\b(href|src)="(\/[^"#?]*)([?#][^"]*)?"/g, (whole, attr, p, suffix) => {
          const to = relocate(p, suffix, publicDir);
          if (to === null) { unresolved.push(`${r}: ${whole}`); return whole; }
          return `${attr}="${to}"`;
        });
        // В демонстрации юридические страницы показываются как шаблоны (рабочая плашка про юриста нужна только владельцу)
        html = html.replace(/<aside class="legal__note"[^>]*>[\s\S]*?<\/aside>/, '<aside class="legal__note" role="note"><strong>Демонстрационный проект.</strong> Это шаблон документа: в настоящем сервисе здесь будут реквизиты оператора и условия, согласованные с юристом.</aside>');
        if (!html.includes('<script src="js-flag.js"></script>')) throw new Error(`${r}: нет подключения js-flag.js, демо-движок некуда встроить`);
        html = html.replace('<script src="js-flag.js"></script>', '<script src="js-flag.js"></script>\n  <script src="demo-api.js"></script>');
        html = html.replace('</head>', '  <link rel="stylesheet" href="demo.css">\n</head>');
        fs.writeFileSync(path.join(out, r), html);
      } else fs.copyFileSync(path.join(dir, r), path.join(out, r));
    }
  };
  copy(publicDir);

  const config = JSON.stringify({ repoUrl, paymentsMode });
  const browser = read('demo/browser.js').replace('/*__CONFIG__*/ {}', config).replace('/*__ROUTES__*/ {}', JSON.stringify(ROUTES));
  fs.writeFileSync(path.join(out, 'demo-api.js'),
    `/* AutoFlow demo: сервер в браузере. Файл собран автоматически (npm run build:demo), не редактируйте его вручную. */\n(function () {\n'use strict';\n${engineBundle()}\n${browser}\n})();\n`);
  fs.copyFileSync(path.join(ROOT, 'demo/demo.css'), path.join(out, 'demo.css'));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  fs.writeFileSync(path.join(out, '404.html'), `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Страница не найдена — AutoFlow</title><link rel="icon" href="favicon.svg" type="image/svg+xml"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050816;color:#eef2ff;font-family:system-ui,sans-serif;text-align:center}a{color:#a98bff}</style></head><body><div><h1>404</h1><p>Такой страницы нет.</p><p><a href="./">На главную</a></p></div></body></html>\n`);

  return { out, unresolved };
}

// Запуск из командной строки
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig(process.argv.slice(2));
  const { out, unresolved } = buildDemo(cfg);
  if (unresolved.length) { console.error('Не удалось преобразовать ссылки:\n  ' + unresolved.join('\n  ')); process.exit(1); }
  const files = fs.readdirSync(out).length;
  console.log(`Готово: ${path.relative(ROOT, out)}/ (${files} файлов). Ссылка на репозиторий: ${cfg.repoUrl || 'не задана'}; оплата: ${cfg.paymentsMode}`);
}
