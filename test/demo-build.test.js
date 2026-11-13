import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { buildDemo, engineBundle, ROUTES } from '../scripts/build-demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_NAME = '.demo-test-out';
const OUT = path.join(ROOT, OUT_NAME);
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const result = buildDemo({ outDir: OUT_NAME, repoUrl: 'https://github.com/example/autoflow', paymentsMode: 'demo' });

test('сборка: все ссылки в HTML относительные и ведут на существующие файлы', () => {
  assert.deepEqual(result.unresolved, [], 'каждая ссылка преобразована');
  const htmls = walk(OUT).filter(f => f.endsWith('.html'));
  assert.ok(htmls.length >= 10);
  for (const f of htmls) {
    const html = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(?:href|src)="\/(?!\/)/.test(html), `${path.basename(f)}: остались абсолютные адреса`);
    for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:|tel:|#|data:)/.test(url)) continue;
      const file = url.split(/[?#]/)[0];
      if (!file) continue;
      assert.ok(fs.existsSync(path.join(path.dirname(f), file)), `${path.basename(f)}: нет файла ${file}`);
    }
  }
});

test('сборка: демо-движок подключён сразу после js-flag.js и раньше остальных скриптов', () => {
  for (const f of walk(OUT).filter(f => f.endsWith('.html') && !f.endsWith('404.html'))) {
    const html = fs.readFileSync(f, 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    assert.equal(scripts[0], 'js-flag.js', path.basename(f));
    assert.equal(scripts[1], 'demo-api.js', path.basename(f));
    assert.ok(html.includes('<link rel="stylesheet" href="demo.css">'));
  }
});

test('сборка: в JS не осталось переходов на абсолютные адреса мимо afUrl()', () => {
  for (const f of walk(OUT).filter(f => f.endsWith('.js') && !f.endsWith('demo-api.js'))) {
    const js = fs.readFileSync(f, 'utf8');
    const name = path.basename(f);
    assert.ok(!/location\.(?:href|replace)\s*(?:=|\()\s*(?!afUrl)['"`]\//.test(js), `${name}: переход мимо afUrl`);
    assert.ok(!/setAttribute\(\s*['"]href['"]\s*,\s*['"`]\//.test(js), `${name}: ссылка мимо afUrl`);
    assert.ok(!/href="\/(?:login|register|dashboard|checkout|forgot-password|reset-password|verify-email|terms|privacy)/.test(js), `${name}: ссылка в разметке мимо afUrl`);
  }
});

test('сборка: demo-api.js корректен, содержит карту страниц и настройки, без import/export', () => {
  const code = fs.readFileSync(path.join(OUT, 'demo-api.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(code));
  assert.ok(!/^\s*(import|export)\s/m.test(code), 'файл должен работать как обычный скрипт (в том числе при открытии с диска)');
  for (const [route, file] of Object.entries(ROUTES)) assert.ok(code.includes(`"${route}":"${file}"`), route);
  assert.ok(code.includes('"repoUrl":"https://github.com/example/autoflow"'));
  assert.ok(code.includes('"paymentsMode":"demo"'));
  assert.ok(fs.existsSync(path.join(OUT, '.nojekyll')) && fs.existsSync(path.join(OUT, '404.html')) && fs.existsSync(path.join(OUT, 'demo.css')));
  // серверный код в демо не попадает
  for (const f of walk(OUT)) assert.ok(!/\.(?:db|env)$/.test(f) && !f.includes(`${path.sep}src${path.sep}`), f);
});

test('сборка: движок загружается как обычный скрипт', () => {
  const code = engineBundle();
  assert.ok(code.includes('export') === false || !/^export\s/m.test(code));
  const sandbox = { crypto: globalThis.crypto, TextEncoder, btoa, URL, console };
  vm.runInNewContext(code, sandbox);
  assert.ok(sandbox.AutoFlowDemoEngine && typeof sandbox.AutoFlowDemoEngine.createEngine === 'function');
});

test('сборка: в демо юридические страницы без рабочей плашки для владельца', () => {
  for (const f of ['terms.html', 'privacy.html']) {
    const html = fs.readFileSync(path.join(OUT, f), 'utf8');
    assert.ok(html.includes('Демонстрационный проект'), f);
    assert.ok(!html.includes('покажите документ юристу'), f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'public', 'terms.html'), 'utf8');
  assert.ok(src.includes('покажите документ юристу'), 'в исходнике предупреждение для владельца сохранено');
});

test('сборка: небезопасные параметры отклоняются', () => {
  assert.throws(() => buildDemo({ outDir: '..' }), /Небезопасная/);
  assert.throws(() => buildDemo({ outDir: '.' }), /Небезопасная/);
  assert.throws(() => buildDemo({ outDir: 'public' }), /Небезопасная/);
  assert.throws(() => buildDemo({ outDir: 'src' }), /Небезопасная/);
  assert.throws(() => buildDemo({ outDir: '/tmp/demo-out' }), /Небезопасная/);
  assert.ok(fs.existsSync(path.join(ROOT, 'public', 'index.html')) && fs.existsSync(path.join(ROOT, 'src', 'app.js')), 'исходники целы');
});
