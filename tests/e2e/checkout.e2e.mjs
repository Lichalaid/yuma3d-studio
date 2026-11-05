// End-to-end: real Worker in workerd (`wrangler dev`) + real Chromium (Playwright).
// Stripe and Resend are replaced by local fakes that validate every request against Stripe's
// OpenAPI spec; the Stripe-hosted payment page is simulated and webhooks are signed with Stripe's SDK.
// Run: npm run test:e2e   (needs: npm i -D playwright && npx playwright install chromium)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createFakeStripe, serveFake } from '../helpers/fake-services.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const FAKE_PORT = 12111, WORKER_PORT = 8787;
const BASE = `http://localhost:${WORKER_PORT}`;
const SECRET = 'whsec_e2eSecret123';
const SHOTS = process.env.E2E_SCREENSHOTS || new URL('../../test-results/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const fake = createFakeStripe();
const server = await serveFake(fake, FAKE_PORT);
const vars = {
  CHECKOUT_ENABLED: 'true', STRIPE_MODE: 'test', STRIPE_ACCOUNT_ID: 'acct_1UVZa22S141stGeG', STRIPE_SECRET_KEY: 'rk_test_e2e',
  STRIPE_WEBHOOK_SECRET: SECRET, ORDER_EMAIL_API_KEY: 're_e2e', ORDER_EMAIL_FROM: 'Yuma 3D Studio <orders@yuma3dstudio.com>',
  STRIPE_API_BASE: `http://127.0.0.1:${FAKE_PORT}`, RESEND_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
};
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete env[key];
// E2E_SERVER=node runs the same purchases against scripts/dev-server.mjs (Vercel's Node runtime and routing).
const onNode = process.env.E2E_SERVER === 'node';
const wranglerBin = new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url).pathname;
const wrangler = onNode
  ? spawn(process.execPath, [new URL('../../scripts/dev-server.mjs', import.meta.url).pathname, '--port', String(WORKER_PORT)], { cwd: new URL('../..', import.meta.url).pathname, env: { ...env, ...vars, DEV_SERVER_QUIET: '1', ADMIN_STORE: 'local' }, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.execPath, [wranglerBin, 'dev', '--port', String(WORKER_PORT), '--ip', '127.0.0.1', ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: new URL('../..', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'pipe'] });
const workerLogs = [];
wrangler.stdout.on('data', d => workerLogs.push(String(d)));
wrangler.stderr.on('data', d => workerLogs.push(String(d)));

const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`  ✓ ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 4).join('\n    ')}`); }
};

async function waitForWorker() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/api/checkout/status`); if (r.ok) return r.json(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + workerLogs.join(''));
}

async function sendWebhook(id, type = 'checkout.session.completed') {
  const payload = JSON.stringify(fake.event(id, type));
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body: payload });
}

const webhookStatuses = [];
const buyers = { current: { email: 'ana@example.com', name: 'Ana Pérez' } };
function checkoutPage(session) {
  const items = session._params.line_items.map(li => `<li>${li.quantity} × ${li.price_data.product_data.name} — ${li.price_data.product_data.description}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Fake Stripe Checkout</title><h1>Pay Yuma 3D Studio</h1><ul>${items}</ul>
    <p id="total">Total ${(session.amount_total / 100).toFixed(2)}</p><p id="locale">${session.locale}</p>
    <a id="pay" href="/__pay/${session.id}">Pay</a> <a id="back" href="/__cancel/${session.id}">Back</a>`;
}
async function newContext(browser, options = {}) {
  const context = await browser.newContext(options);
  await context.route('https://checkout.stripe.com/**', async route => {
    const { pathname } = new URL(route.request().url());
    let m;
    if ((m = pathname.match(/^\/c\/pay\/(cs_test_\w+)$/))) return route.fulfill({ contentType: 'text/html', body: checkoutPage(fake.sessions.get(m[1])) });
    if ((m = pathname.match(/^\/__pay\/(cs_test_\w+)$/))) {
      fake.complete(m[1], buyers.current);
      webhookStatuses.push((await sendWebhook(m[1])).status);
      const s = fake.sessions.get(m[1]);
      return route.fulfill({ status: 302, headers: { Location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) } });
    }
    if ((m = pathname.match(/^\/__cancel\/(cs_test_\w+)$/))) return route.fulfill({ status: 302, headers: { Location: fake.sessions.get(m[1]).cancel_url } });
    return route.fulfill({ status: 404, body: 'not found' });
  });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) page.errors.push(m.text()); });
  return { context, page };
}

async function addInitialName(page, { initial, name, accessories = [], texts = {}, colors }) {
  await page.goto(`${BASE}/products/initial-name/`);
  await page.waitForSelector('[data-accessory-group="accessories"]');
  for (const id of accessories) await page.click(`[data-accessory-group="accessories"] label:has(input[value="${id}"])`);
  await page.fill('#product-text-initial', initial);
  for (const [key, value] of Object.entries(texts)) await page.fill(`#product-text-${key}`, value);
  await page.fill('#product-text-name', name);
  for (const [key, value] of Object.entries(colors)) await page.selectOption(`#piece-colors select[data-component="${key}"]`, value);
  await page.click('#product-action');
  await page.waitForSelector('#bag-dialog[open]');
}
async function addKeychain(page, { quantity = 1 } = {}) {
  await page.goto(`${BASE}/products/fitness-keychain/`);
  await page.waitForSelector('[data-all-colors]');
  await page.selectOption('[data-all-colors]', 'pink');
  await page.selectOption('#piece-colors select[data-component="opener"]', 'blue');
  if (quantity !== 1) {
    const tag = await page.$eval('#product-quantity', el => el.tagName);
    if (tag === 'SELECT') await page.selectOption('#product-quantity', String(quantity)); else await page.fill('#product-quantity', String(quantity));
  }
  await page.click('#product-action');
  await page.waitForSelector('#bag-dialog[open]');
}
async function goToStripe(page, delivery) {
  await page.check(`#bag-dialog input[name="delivery"][value="${delivery}"]`);
  await page.click('#checkout');
  await page.waitForSelector('#review-dialog[open] #stripe-pay:not([hidden])');
  await page.click('#stripe-pay');
  await page.waitForURL(/checkout\.stripe\.com\/c\/pay\//);
  return page.url().split('/').pop();
}

let browser;
try {
  console.log(onNode ? 'Starting the Node dev server (Vercel runtime) and fake Stripe/Resend…' : 'Starting wrangler dev (workerd) and fake Stripe/Resend…');
  const status = await waitForWorker();
  const browserType = playwright.chromium;
  browser = await browserType.launch();

  await step('checkout status is enabled in test mode', async () => assert.deepEqual(status, { configured: true, mode: 'test', webhookConfigured: true, emailConfigured: true }));

  let sessionA;
  await step('EN · initial + name and a keychain · UPS shipping $2.99 · one Stripe checkout · paid', async () => {
    const { context, page } = await newContext(browser);
    await addInitialName(page, { initial: 'e', name: 'Emma', colors: { baseColor: 'blue', detailColor: 'white' } });
    await addKeychain(page, { name: 'Rose' });
    assert.equal(await page.textContent('#bag-count'), '2');
    sessionA = await goToStripe(page, 'ship');
    const s = fake.sessions.get(sessionA);
    assert.equal(s.amount_subtotal, 4300);
    assert.equal(s.total_details.amount_shipping, 299);
    assert.equal(s.amount_total, 4599);
    assert.equal(s._params.line_items.length, 2);
    assert.equal(s.locale, 'en');
    assert.match(await page.textContent('#total'), /45\.99/);
    await page.click('#pay');
    await page.waitForURL(/\/checkout-result\/\?session_id=cs_test_/);
    await page.waitForFunction(() => /confirmed/i.test(document.querySelector('#result-title').textContent));
    const body = await page.textContent('main');
    for (const text of ['Test payment confirmed.', 'Reference: YM-', 'Initial: E', 'Name: Emma', 'Initial color: Sky blue', 'Paddle-shaped can opener: Sky blue', '$45.99 USD', 'ana@example.com']) assert.ok(body.includes(text), text);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('yuma-demo-bag')), null, 'bag cleared after payment');
    await page.screenshot({ path: SHOTS + 'e2e-result-desktop.png', fullPage: true });
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('webhook answered 200 and Yuma + buyer got one email each', async () => {
    assert.deepEqual(webhookStatuses, [200]);
    const shop = fake.emails.filter(e => e.to[0] === 'yuma3dstudio@gmail.com');
    const buyer = fake.emails.filter(e => e.to[0] === 'ana@example.com');
    assert.equal(shop.length, 1); assert.equal(buyer.length, 1);
    for (const line of ['Letra inicial: E', 'Nombre: Emma', 'Color de la inicial: Azul cielo', 'Color del nombre: Blanco', 'Mancuerna: Rosa pastel', 'Abridor de latas en forma de paleta: Azul cielo', 'Envío UPS a: Ana Pérez', 'Total cobrado: $45.99 USD']) {
      assert.ok(shop[0].text.includes(line), `shop email: ${line}`);
    }
    assert.match(buyer[0].subject, /^\[TEST\] Your Yuma 3D Studio order YM-/);
  });

  await step('replaying the same Stripe event does not send duplicate emails', async () => {
    const before = fake.emails.length;
    assert.equal((await sendWebhook(sessionA)).status, 200);
    assert.equal((await sendWebhook(sessionA, 'checkout.session.async_payment_succeeded')).status, 200);
    assert.equal(fake.emails.length, before);
  });

  await step('ES · 3 accessories incl. birth details + 2 keychains = $51.00 · free shipping · Stripe in Spanish', async () => {
    buyers.current = { email: 'luis@example.com', name: 'Luis Gómez' };
    const { context, page } = await newContext(browser);
    await page.goto(`${BASE}/`);
    await page.click('[data-language="es"]');
    await addInitialName(page, { initial: 'l', name: 'Lucía', accessories: ['stars', 'branches', 'birth'], texts: { 'birth-date': '2026-07-28', 'birth-time': '22:40', 'birth-weight': '3 lb 3 oz' }, colors: { baseColor: 'dark-blue', detailColor: 'white', 'acc-accessories-stars': 'rainbow', 'acc-accessories-branches': 'white', 'acc-accessories-birth': 'beige' } });
    await addKeychain(page, { name: 'Sofía', quantity: 2 });
    const id = await goToStripe(page, 'ship');
    const s = fake.sessions.get(id);
    assert.equal(s.amount_subtotal, 5100); assert.equal(s.total_details.amount_shipping, 0); assert.equal(s.locale, 'es');
    assert.equal(s._params.shipping_options[0].shipping_rate_data.display_name, 'Envío UPS gratis');
    assert.match(s._params.line_items[0].price_data.product_data.description, /Letra inicial: L · Nombre: Lucía · Fecha de nacimiento: 2026-07-28 · Hora de nacimiento: 22:40 · Peso al nacer \(con unidad\): 3 lb 3 oz · Tipografía del nombre: Allura · Tipografía de la inicial: Al Bayan · Adornos: Estrellas, Ramas, Detalle de nacimiento \(fecha, hora y peso\)/);
    await page.click('#pay');
    await page.waitForFunction(() => /confirmado/i.test(document.querySelector('#result-title')?.textContent || ''));
    assert.ok((await page.textContent('main')).includes('Envío UPS'));
    const buyer = fake.emails.find(e => e.to[0] === 'luis@example.com');
    assert.match(buyer.subject, /^\[PRUEBA\] Tu pedido de Yuma 3D Studio YM-/);
    assert.ok(buyer.text.includes('Estrellas: Arcoíris') && buyer.text.includes('Ramas: Blanco'));
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('pickup + cancel: back from Stripe keeps the bag, then paying reuses the same session', async () => {
    buyers.current = { email: 'mia@example.com', name: 'Mia Lee' };
    const { context, page } = await newContext(browser);
    await addKeychain(page, { name: 'Mia' });
    const first = await goToStripe(page, 'pickup');
    const s = fake.sessions.get(first);
    assert.equal(s.total_details.amount_shipping, 0);
    assert.equal(s._params.shipping_address_collection, undefined);
    assert.equal(s._params.shipping_options[0].shipping_rate_data.display_name, 'Free pickup · Katy, TX');
    await page.click('#back');
    await page.waitForURL(url => url.pathname === '/' && url.hash === '#shop');
    assert.equal(new URL(page.url()).search, '', 'cancel flag removed from the address bar');
    await page.waitForSelector('#toast.visible');
    assert.match(await page.textContent('#toast'), /Payment cancelled/);
    await page.waitForSelector('#bag-dialog[open]');
    assert.equal(await page.textContent('#bag-count'), '1');
    const sessionsBefore = fake.sessions.size;
    const second = await goToStripe(page, 'pickup');
    assert.equal(second, first, 'same bag → same Stripe session (idempotent)');
    assert.equal(fake.sessions.size, sessionsBefore);
    await page.click('#pay');
    await page.waitForFunction(() => /confirmed/i.test(document.querySelector('#result-title')?.textContent || ''));
    const shop = fake.emails.filter(e => e.to[0] === 'yuma3dstudio@gmail.com').at(-1);
    assert.match(shop.text, /Retiro en Katy, TX 77449/);
    assert.match(shop.subject, / · Retiro$/);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('mobile (390×844): review dialog and pay button fit the screen', async () => {
    const { context, page } = await newContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await addKeychain(page, { name: 'Ava' });
    await page.click('#checkout');
    await page.waitForSelector('#review-dialog[open] #stripe-pay:not([hidden])');
    const box = await page.$eval('#stripe-pay', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
    assert.ok(box.left >= 0 && box.right <= 390, JSON.stringify(box));
    assert.match(await page.textContent('#stripe-pay'), /Continue to Stripe/);
    assert.match(await page.getAttribute('#order-email', 'class'), /secondary/);
    await page.screenshot({ path: SHOTS + 'e2e-review-mobile.png' });
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('photo frame: payable now, then the buyer is asked to send the photos on WhatsApp (page and both emails)', async () => {
    buyers.current = { email: 'zoe@example.com', name: 'Zoe Diaz' };
    const { context, page } = await newContext(browser);
    await page.goto(`${BASE}/products/photo-frame/`);
    await page.waitForSelector('[data-all-colors]');
    assert.match(await page.textContent('#product-options'), /send 1 to 4 photos \(size 2 × 3\) on WhatsApp/);
    await page.selectOption('[data-all-colors]', 'white');
    await page.click('#product-action');
    await page.waitForSelector('#bag-dialog[open]');
    const id = await goToStripe(page, 'pickup');
    assert.equal(fake.sessions.get(id).amount_total, 3500);
    await page.click('#pay');
    await page.waitForFunction(() => /One more step/.test(document.querySelector('main')?.textContent || ''));
    const link = await page.getAttribute('main a[href^="https://wa.me/"]', 'href');
    assert.match(link, /^https:\/\/wa\.me\/18325072768\?text=.*YM-/);
    await page.screenshot({ path: SHOTS + 'e2e-result-photos.png', fullPage: true });
    const shop = fake.emails.filter(e => e.to[0] === 'yuma3dstudio@gmail.com').at(-1);
    const buyer = fake.emails.find(e => e.to[0] === 'zoe@example.com');
    assert.match(shop.text, /PENDIENTE DEL CLIENTE[\s\S]*tus fotos \(de 1 a 4, tamaño 2 × 3\)[\s\S]*No fabricar hasta recibirlos/);
    assert.match(buyer.text, /ONE MORE STEP[\s\S]*Send your photos \(1 to 4, size 2 × 3\) on WhatsApp to \+1 832 507 2768/);
    assert.deepEqual(page.errors, []);
    await context.close();
  });

  await step('the browser cannot change prices: a tampered request is recomputed by the server', async () => {
    const { context, page } = await newContext(browser);
    await page.goto(`${BASE}/`);
    const response = await page.evaluate(async () => {
      await fetch('/api/checkout/status'); // the visitor cookie comes with this response
      const r = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: crypto.randomUUID(), language: 'en', delivery: 'ship', items: [{ productId: 'can-opener-keychain', quantity: 1, price: 1, unitAmount: 1, options: { designId: 'heart', colors: { 'design-color': 'red', detailColor: 'white' }, text: {} } }] }) });
      return { status: r.status, body: await r.json() };
    });
    assert.equal(response.status, 200);
    assert.equal(fake.sessions.get(response.body.id).amount_subtotal, 500);
    await context.close();
  });

  await step('every request the Worker sent to Stripe matches Stripe\'s OpenAPI spec', async () => {
    assert.deepEqual(fake.contractErrors, []);
    assert.ok(fake.requests.length > 10);
  });
} finally {
  await browser?.close();
  wrangler.kill('SIGTERM');
  server.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
if (failed.length) {
  console.log('\nWorker log tail:\n' + workerLogs.join('').split('\n').slice(-40).join('\n'));
  process.exit(1);
}
