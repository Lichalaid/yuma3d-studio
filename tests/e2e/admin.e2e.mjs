// End-to-end of the admin panel ("puerta de atrás") with real Chromium against scripts/dev-server.mjs
// (same routing and Node runtime as Vercel). Runs on a temporary copy of the project, so the real
// catalog is never touched. Saves use the local store (in production: one GitHub commit + Vercel deploy).
// Checks that a product created in the panel can be seen, personalized and paid with the right price.
// Run: npm run test:e2e:admin   (needs: npm i -D playwright && npx playwright install chromium)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createFakeStripe, serveFake } from '../helpers/fake-services.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const ROOT = new URL('../..', import.meta.url).pathname;
const PORT = 3299, FAKE_PORT = 12112, BASE = `http://localhost:${PORT}`;
const PASSWORD = 'clave-de-prueba-2026';
const SHOTS = process.env.E2E_SCREENSHOTS || path.join(ROOT, 'test-results/');
fs.mkdirSync(SHOTS, { recursive: true });

// Temporary copy of the project (without node_modules / git).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yuma-admin-e2e-'));
for (const entry of fs.readdirSync(ROOT)) {
  if (['node_modules', '.git', 'test-results', 'dist', '.wrangler', '.vercel'].includes(entry)) continue;
  fs.cpSync(path.join(ROOT, entry), path.join(work, entry), { recursive: true });
}
const readCatalog = () => JSON.parse(fs.readFileSync(path.join(work, 'catalog-products.json'), 'utf8'));

const fake = createFakeStripe();
const fakeServer = await serveFake(fake, FAKE_PORT);
const env = {
  ...process.env, ADMIN_LOCAL_PASSWORD: PASSWORD, ADMIN_STORE: 'local', DEV_SERVER_QUIET: '1',
  CHECKOUT_ENABLED: 'true', STRIPE_MODE: 'test', STRIPE_ACCOUNT_ID: 'acct_1UVZa22S141stGeG', STRIPE_SECRET_KEY: 'rk_test_e2e',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2eSecret123', ORDER_EMAIL_MODE: 'log', STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
};
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'GITHUB_REPO']) delete env[key];
const server = spawn(process.execPath, [path.join(work, 'scripts/dev-server.mjs'), '--port', String(PORT), '--root', work], { env, stdio: ['ignore', 'pipe', 'pipe'] });
const logs = [];
server.stdout.on('data', d => logs.push(String(d)));
server.stderr.on('data', d => logs.push(String(d)));

const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (error) { results.push({ name, ok: false }); console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 5).join('\n    ')}`); }
};
async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/admin/session`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('dev-server did not start:\n' + logs.join(''));
}
async function newPage(browser, options) {
  const context = await browser.newContext(options);
  await context.route('https://checkout.stripe.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fake Stripe</h1>' }));
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|401/.test(m.text())) page.errors.push(m.text()); });
  return { context, page };
}
async function login(page) {
  await page.goto(`${BASE}/admin/`);
  await page.fill('#password', PASSWORD);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#product-list .product-row');
}
// Clicks a save button and waits until the panel reports that this change is live.
async function saveAndPublish(page, selector) {
  await page.evaluate(() => { const bar = document.querySelector('#publish'); bar.textContent = ''; bar.hidden = true; });
  await page.click(selector);
  await page.waitForFunction(() => /Publicado ✓/.test(document.querySelector('#publish')?.textContent || ''), null, { timeout: 20000 });
}

let browser, productId;
try {
  await waitForServer();
  browser = await playwright.chromium.launch();

  await step('wrong password is rejected; the right one opens the panel', async () => {
    const { context, page } = await newPage(browser);
    await page.goto(`${BASE}/admin/`);
    await page.fill('#password', 'otra-cosa');
    await page.click('#login-form button[type=submit]');
    await page.waitForFunction(() => /incorrecta/.test(document.querySelector('#login-error').textContent));
    assert.equal((await fetch(`${BASE}/api/admin/catalog`)).status, 401, 'catalog API needs a session');
    await page.fill('#password', PASSWORD);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#product-list .product-row');
    assert.equal(await page.locator('#product-list .product-row').count(), JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog-products.json'), 'utf8')).length);
    await page.screenshot({ path: SHOTS + 'admin-1-lista.png', fullPage: true });
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('creates a product with photo, colors, parts, a name field, price and category', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    await page.click('#new-product');
    await page.setInputFiles('#photo-input', [path.join(ROOT, 'storefront/assets/name-lia.png'), path.join(ROOT, 'storefront/assets/name-alan.jpg')]);
    await page.waitForFunction(() => document.querySelectorAll('#photos .photo').length === 2 && !document.querySelector('#photos .processing'));
    await page.fill('#name-es', 'Llavero corazón con nombre');
    await page.fill('#desc-es', 'Llavero en forma de corazón con el nombre en relieve.\n\nSe fabrica a pedido en Houston.');
    await page.click('#english summary');
    await page.fill('#name-en', 'Heart name keychain');
    await page.fill('#price', '12,50');
    await page.fill('#compare-price', '15');
    await page.waitForFunction(() => /17% off/.test(document.querySelector('#discount-preview').textContent));
    await page.selectOption('#category', 'keychains');
    await page.click('#no-colors');
    for (const color of ["pink", "purple", "white"]) await page.click(`#swatches label:has(input[value="${color}"])`);
    await page.fill('#part-es-0', 'Corazón');
    await page.fill('#part-en-0', 'Heart');
    await page.click('#add-part');
    await page.fill('#part-es-1', 'Letras');
    await page.click('#add-text');
    await page.fill('#text-es-0', 'Nombre');
    await page.fill('#text-en-0', 'Name');
    await page.fill('#text-max-0', '10');
    await page.screenshot({ path: SHOTS + 'admin-2-nuevo-producto.png', fullPage: true });
    await saveAndPublish(page, '#save');
    await page.screenshot({ path: SHOTS + 'admin-3-publicado.png' });
    const product = readCatalog()[0];
    productId = product.id;
    assert.equal(product.id, 'heart-name-keychain');
    assert.deepEqual(product.name, { es: 'Llavero corazón con nombre', en: 'Heart name keychain' });
    assert.deepEqual(product.description.es, ['Llavero en forma de corazón con el nombre en relieve.', 'Se fabrica a pedido en Houston.']);
    assert.deepEqual(product.description.en, product.description.es, 'English description falls back to Spanish');
    assert.equal(product.price_cents, 1250);
    assert.deepEqual([product.compare_at_cents, product.discount_percent], [1500, 17]);
    assert.equal(product.category, 'keychains');
    assert.deepEqual(product.personalization.colors, ['pink', 'purple', 'white']);
    assert.deepEqual(product.personalization.color_fields, [{ key: 'part-1', label: { en: 'Heart', es: 'Corazón' } }, { key: 'part-2', label: { en: 'Letras', es: 'Letras' } }]);
    assert.deepEqual(product.personalization.text_fields, [{ key: 'name', label: { en: 'Name', es: 'Nombre' }, max_length: 10, kind: 'name' }]);
    assert.equal(product.images.length, 2);
    for (const image of product.images) {
      assert.match(image, /^assets\/catalog\/uploads\/heart-name-keychain-[a-z0-9]+\.webp$/);
      const bytes = fs.readFileSync(path.join(work, 'storefront', image));
      assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    }
    assert.ok(fs.existsSync(path.join(work, 'storefront/assets/catalog/stripe/heart-name-keychain.jpg')), 'Stripe thumbnail written');
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('the new product is in the store: card, own page, SEO and sitemap', async () => {
    const { context, page } = await newPage(browser);
    await page.goto(`${BASE}/#shop`);
    const first = page.locator('#catalog-grid .catalog-card').first();
    assert.match(await first.textContent(), /Heart name keychain/);
    assert.match(await first.textContent(), /\$15\.00\s*\$12\.50/, 'crossed-out price and selling price');
    assert.match(await first.textContent(), /17% off/);
    const html = await (await fetch(`${BASE}/products/${productId}/`)).text();
    assert.match(html, /<title>Heart name keychain \| Yuma 3D Studio<\/title>/);
    assert.match(html, /"price": "12\.50"/);
    assert.match(await (await fetch(`${BASE}/sitemap.xml`)).text(), /\/products\/heart-name-keychain\//);
    await page.goto(`${BASE}/products/${productId}/`);
    await page.click('[data-language="es"]');
    await page.waitForFunction(() => /Llavero corazón/.test(document.querySelector('#product-title').textContent));
    await page.screenshot({ path: SHOTS + 'admin-4-ficha-en-tienda.png', fullPage: true });
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('a buyer personalizes it and Stripe gets the panel price (USD 12.50)', async () => {
    const { context, page } = await newPage(browser);
    await page.goto(`${BASE}/products/${productId}/`);
    await page.waitForSelector('#product-text-name');
    await page.fill('#product-text-name', 'Valentina');
    await page.check('input[name="product-font"][value="Lobster"]', { force: true });
    await page.selectOption('#piece-colors select[data-component="part-1"]', 'pink');
    await page.selectOption('#piece-colors select[data-component="part-2"]', 'white');
    const offered = await page.$$eval('#piece-colors select[data-component="part-1"] option[value]:not([value=""])', o => o.map(x => x.value));
    assert.deepEqual(offered, ['pink', 'purple', 'white'], 'only the colors chosen in the panel are offered');
    await page.click('#product-action');
    await page.waitForSelector('#bag-dialog[open]');
    await page.check('#bag-dialog input[name="delivery"][value="pickup"]');
    await page.click('#checkout');
    await page.waitForSelector('#review-dialog[open] #stripe-pay:not([hidden])');
    await page.click('#stripe-pay');
    await page.waitForURL(/checkout\.stripe\.com/);
    const session = [...fake.sessions.values()].at(-1);
    assert.equal(session.amount_total, 1250);
    const line = session._params.line_items[0].price_data;
    assert.equal(Number(line.unit_amount), 1250);
    assert.equal(line.product_data.name, 'Heart name keychain');
    assert.match(line.product_data.description, /Name: Valentina · Name font: Lobster · Heart: Pink · Letras: White/);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('edit price and hide: the store and the checkout follow the panel', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    await page.click(`[data-id="${productId}"] [data-edit]`);
    await page.fill('#price', '14');
    await page.uncheck('#visible');
    await saveAndPublish(page, '#save');
    const product = readCatalog()[0];
    assert.equal(product.price_cents, 1400);
    assert.equal(product.hidden, true);
    assert.equal(product.images.length, 2, 'photos kept');
    assert.equal((await fetch(`${BASE}/products/${productId}/`)).status, 404, 'hidden product has no page');
    assert.ok(!(await (await fetch(`${BASE}/`)).text()).includes('Heart name keychain'), 'hidden product not in the catalog');
    const status = await fetch(`${BASE}/api/checkout/status`);
    const cookie = status.headers.get('set-cookie').split(';')[0];
    const buy = await fetch(`${BASE}/api/checkout`, { method: 'POST', headers: { Origin: BASE, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productId, quantity: 1, options: { colors: { 'part-1': 'pink', 'part-2': 'white' }, text: { name: 'Ana' }, font: 'Allura' } }], delivery: 'pickup', language: 'en', nonce: crypto.randomUUID() }) });
    assert.equal(buy.status, 400, 'hidden product cannot be bought');
    assert.match((await buy.json()).error, /no longer available/);
    assert.match(await page.textContent(`[data-id="${productId}"]`), /Oculto/);
    await saveAndPublish(page, `[data-id="${productId}"] [data-toggle]`);
    assert.equal(readCatalog()[0].hidden, undefined);
    assert.equal((await fetch(`${BASE}/products/${productId}/`)).status, 200);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('reorders the catalog and edits an existing product without touching its special options', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    await page.click(`[data-id="${productId}"] [data-move="1"]`);
    await saveAndPublish(page, '#save-order');
    assert.equal(readCatalog()[1].id, productId);
    const before = readCatalog().find(p => p.id === 'initial-name');
    await page.click('[data-id="initial-name"] [data-edit]');
    assert.equal(await page.isVisible('#parts-block'), false);
    assert.equal(await page.isVisible('#special-note'), true);
    await page.fill('#name-es', 'Inicial + nombre decorativo');
    await saveAndPublish(page, '#save');
    const after = readCatalog().find(p => p.id === 'initial-name');
    assert.equal(after.name.es, 'Inicial + nombre decorativo');
    assert.deepEqual(after.personalization, before.personalization, 'design options untouched');
    assert.deepEqual(after.source, before.source, 'other fields kept');
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('categories: add one, a used one cannot be removed, the filter appears when it has products', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    await page.click('[data-tab="categories"]');
    assert.equal(await page.isDisabled('[data-remove-cat="1"]'), true, 'Llaveros has products');
    await page.click('#add-category');
    const last = (await page.locator('#category-rows .cat-row').count()) - 1;
    await page.fill(`#cat-es-${last}`, 'Decoración');
    await page.fill(`#cat-en-${last}`, 'Home decor');
    await saveAndPublish(page, '#categories-form button[type=submit]');
    const categories = JSON.parse(fs.readFileSync(path.join(work, 'catalog-categories.json'), 'utf8'));
    assert.deepEqual(categories.at(-1), { id: 'home-decor', name: { en: 'Home decor', es: 'Decoración' } });
    assert.ok(!(await (await fetch(`${BASE}/`)).text()).includes('data-filter="home-decor"'), 'empty category is not shown');
    await page.click('[data-tab="products"]');
    await page.click(`[data-id="${productId}"] [data-edit]`);
    await page.selectOption('#category', 'home-decor');
    await saveAndPublish(page, '#save');
    assert.ok((await (await fetch(`${BASE}/`)).text()).includes('data-filter="home-decor" aria-pressed="false" data-en="Home decor" data-es="Decoración"'));
    await context.close();
  });

  await step('mobile (390 px): list and form fit the screen', async () => {
    const { context, page } = await newPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await login(page);
    await page.screenshot({ path: SHOTS + 'admin-celular-1-lista.png' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll (list)');
    await page.click(`[data-id="${productId}"] [data-edit]`);
    await page.waitForSelector('#photos .photo');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll (form)');
    await page.screenshot({ path: SHOTS + 'admin-celular-2-formulario.png', fullPage: true });
    await context.close();
  });

  await step('delete removes the product, its page and its uploaded photos', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    const images = readCatalog().find(p => p.id === productId).images;
    await page.click(`[data-id="${productId}"] [data-edit]`);
    await page.click('#delete');
    await saveAndPublish(page, '#confirm-ok');
    assert.ok(!readCatalog().some(p => p.id === productId));
    for (const image of images) assert.ok(!fs.existsSync(path.join(work, 'storefront', image)), 'photo removed');
    assert.ok(!fs.existsSync(path.join(work, 'storefront/assets/catalog/stripe/heart-name-keychain.jpg')));
    assert.equal((await fetch(`${BASE}/products/${productId}/`)).status, 404);
    await context.close();
  });

  await step('logout ends the session', async () => {
    const { context, page } = await newPage(browser);
    await login(page);
    await page.click('#logout');
    await page.waitForSelector('#login-view:not([hidden])');
    const cookies = await context.cookies();
    assert.ok(!cookies.some(c => c.name === 'yuma_admin' && c.value), 'cookie cleared');
    await context.close();
  });
} finally {
  await browser?.close();
  server.kill();
  fakeServer.close();
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} admin E2E checks passed.`);
if (failed) { console.log(logs.join('').slice(-3000)); process.exit(1); }
