import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCart, createSession, verifySignature, handleApi, StripeClient, checkoutConfig, decodeOrder, itemDetails } from '../worker/checkout.js';
import { createFakeStripe } from './helpers/fake-services.mjs';
import { CATALOG, nonce, visitor, sample, TEST_ENV, WEBHOOK_SECRET, signedWebhook, checkoutRequest, useFakeFetch, captureLogs } from './helpers/fixtures.mjs';

const webhookRequest = (fake, id, type) => signedWebhook(fake.event(id, type));
async function paidSession(fake, input = sample(), env = TEST_ENV, completeWith = {}) {
  const restore = useFakeFetch(fake);
  try {
    const response = await handleApi(checkoutRequest(input), env);
    const created = await response.json();
    fake.complete(created.id, completeWith);
    return created;
  } finally { restore(); }
}
async function withFake(fake, fn) { const restore = useFakeFetch(fake); try { return await fn(); } finally { restore(); } }

/* ---------- original behaviour (kept) ---------- */

test('server calculates prices, quantities and one shipping fee', () => {
  const p = sample();
  const order = validateCart(p);
  assert.equal(order.subtotal, 5100); assert.equal(order.shipping, 0); assert.equal(order.total, 5100);
  assert.equal(order.items[0].text.initial, 'E');
  p.items.pop(); assert.equal(validateCart(p).total, 3999);
  p.delivery = 'pickup'; assert.equal(validateCart(p).total, 3500);
});

test('missing data, altered colors, unknown quotes and unpriced accessories are rejected', () => {
  const cases = [
    p => { p.items[0].options.text.name = ''; },
    p => { p.items[0].options.colors.baseColor = 'not-offered'; },
    p => { p.items[0].quantity = 0; },
    p => { p.items[0].quantity = 11; },
    p => { p.items[0].productId = 'raised-name-keychain'; },
    p => { p.items[0].productId = 'wholesale-keychains'; },
    p => { p.items[0].productId = 'does-not-exist'; },
    p => { p.items[0].options.accessories = { accessories: ['stars', 'cloud', 'bow', 'bear'] }; },
    p => { p.items[0].options.accessories = { accessories: ['stars', 'stars'] }; },
    p => { p.items[0].options.accessories = { accessories: ['unicorn'] }; },
    p => { p.items[0].options.text.initial = 'EM'; },
    p => { p.items[0].options.text.name = 'Emma<script>'; },
    p => { p.items[0].options.text.name = 'Emma\u0007'; },
    p => { p.delivery = 'drone'; },
    p => { p.nonce = 'x'; },
    p => { p.items = []; },
  ];
  for (const change of cases) { const p = sample(); change(p); assert.throws(() => validateCart(p), change.toString()); }
});

test('one Checkout Session contains every product and retries are idempotent', async () => {
  const calls = [];
  const stripe = { request: async (...args) => { calls.push(args); return { id: 'cs_test_unit', url: 'https://checkout.stripe.com/c/pay/cs_test_unit', livemode: false }; } };
  const a = await createSession(sample(), 'https://example.com', 'visitor', stripe);
  const b = await createSession(sample(), 'https://example.com', 'visitor', stripe);
  assert.equal(a.total, 5100);
  const request = calls[0][2];
  assert.equal(request.line_items.length, 2);
  assert.equal(request.line_items[0].price_data.unit_amount, 3500);
  assert.equal(request.line_items[1].quantity, 2);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(a.reference, b.reference);
  assert.match(a.reference, /^YM-[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(request.metadata.format, 'yuma-gzip-v1');
  assert.ok(Object.values(request.metadata).every(v => v.length <= 500));
  assert.deepEqual(await decodeOrder(request.metadata), validateCart(sample()));
});

test('foreign origin and live credentials cannot activate this sandbox integration', async () => {
  const r = await handleApi(new Request('https://example.com/api/checkout/status'), { STRIPE_SECRET_KEY: 'sk_live_example', STRIPE_ACCOUNT_ID: 'acct_live' });
  assert.equal((await r.json()).configured, false);
  await assert.rejects(() => handleApi(new Request('https://example.com/api/checkout', { method: 'POST', headers: { Origin: 'https://wrong.example', 'Content-Type': 'application/json', Cookie: 'yuma_checkout=' + nonce }, body: JSON.stringify(sample()) }), TEST_ENV), e => e.status === 403);
  await assert.rejects(() => handleApi(checkoutRequest(sample(), { cookie: null }), TEST_ENV), e => e.status === 403);
});

test('webhook checks signature and five minute replay tolerance', async () => {
  const raw = '{"id":"evt_test"}', secret = 'whsec_unit', stamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(stamp + '.' + raw))), b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifySignature(raw, `t=${stamp},v1=${signature}`, secret), true);
  assert.equal(await verifySignature(raw, `t=${stamp},v1=${signature}`, secret, Date.now() + 400000), false);
  assert.equal(await verifySignature(raw + 'x', `t=${stamp},v1=${signature}`, secret), false);
  assert.equal(await verifySignature(raw, `t=${stamp},v1=${signature}`, 'whsec_other'), false);
});

test('live activation requires Yuma, a matching mode, webhook, email and explicit enablement', async () => {
  const config = { STRIPE_MODE: 'live', CHECKOUT_ENABLED: 'true', STRIPE_ACCOUNT_ID: 'acct_1UVgaICbK0UdCU0G', STRIPE_SECRET_KEY: 'rk_live_unit', STRIPE_WEBHOOK_SECRET: 'whsec_unit', ORDER_EMAIL_API_KEY: 'unit', ORDER_EMAIL_FROM: 'orders@example.com' };
  const status = async env => (await handleApi(new Request('https://example.com/api/checkout/status'), env)).json();
  assert.equal((await status(config)).configured, true);
  for (const key of ['CHECKOUT_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ORDER_EMAIL_API_KEY', 'ORDER_EMAIL_FROM']) {
    const env = { ...config }; delete env[key];
    assert.equal((await status(env)).configured, false, key);
  }
  assert.equal((await status({ ...config, STRIPE_ACCOUNT_ID: 'acct_unrelated' })).configured, false);
  assert.equal((await status({ ...config, STRIPE_SECRET_KEY: 'rk_test_unit' })).configured, false);
  assert.equal((await status({ ...config, ORDER_EMAIL_MODE: 'log', ORDER_EMAIL_API_KEY: '' })).configured, false, 'log mode never counts as email in live mode');
  await assert.rejects(() => handleApi(new Request('https://example.com/api/checkout', { method: 'POST', headers: { Origin: 'https://example.com', Cookie: 'yuma_checkout=' + nonce } }), {}), e => e.status === 503);
});

test('session creation verifies the expected live or test mode', async () => {
  const live = { request: async () => ({ id: 'cs_live_unit', url: 'https://checkout.stripe.com/c/pay/cs_live_unit', livemode: true }) };
  assert.equal((await createSession(sample(), 'https://example.com', 'visitor', live, 'live')).id, 'cs_live_unit');
  await assert.rejects(() => createSession(sample(), 'https://example.com', 'visitor', live, 'test'), e => e.status === 502);
});

test('paid webhook emails the full personalization to Yuma and does not notify twice', async () => {
  const fake = createFakeStripe();
  const lastHandle = 'FINAL_PROFILE_' + 'z'.repeat(100);
  const input = { nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'social-display', quantity: 1, options: { colors: Object.fromEntries(['baseColor', 'detailColor', 'business-name', 'logo', 'front-text', 'social-1', 'social-2', 'nfc-marks'].map(k => [k, 'white'])), profiles: Array.from({ length: 10 }, (_, i) => ({ network: 'Social ' + i, handle: i === 9 ? lastHandle : 'profile_' + i + 'x'.repeat(100) })) } }] };
  const { id } = await paidSession(fake, input);
  await withFake(fake, async () => {
    assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200);
    assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200);
  });
  const shop = fake.emails.filter(e => e.to[0] === 'yuma3dstudio@gmail.com');
  assert.equal(shop.length, 1, 'one email to Yuma');
  assert.ok(shop[0].text.includes(lastHandle));
  assert.equal(fake.emails.length, 2, 'Yuma + buyer, once each');
  assert.equal(fake.sessions.get(id).metadata.shop_notified, 'true');
  assert.equal(fake.sessions.get(id).metadata.buyer_notified, 'true');
  assert.deepEqual(fake.contractErrors, []);
});

/* ---------- regressions and new behaviour ---------- */

test('Stripe client calls fetch as a plain function (Cloudflare "Illegal invocation" regression)', async () => {
  const fake = createFakeStripe();
  await withFake(fake, async () => {
    const account = await new StripeClient('rk_test_unit').request('GET', '/account');
    assert.equal(account.id, 'acct_1UVZa22S141stGeG');
  });
});

test('transient Stripe errors are retried with the same idempotency key; client errors are not', async () => {
  const attempts = [];
  const responses = [
    new Response('{"error":{"type":"api_error"}}', { status: 500 }),
    new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 }),
    new Response('{"id":"cs_test_ok"}', { status: 200 }),
  ];
  const client = new StripeClient('rk_test_unit', (url, init) => { attempts.push(init.headers['Idempotency-Key']); return Promise.resolve(responses.shift()); }, { retryDelayMs: 1 });
  assert.equal((await client.request('POST', '/checkout/sessions', { mode: 'payment' }, 'key-1')).id, 'cs_test_ok');
  assert.deepEqual(attempts, ['key-1', 'key-1', 'key-1']);

  const logs = captureLogs();
  let calls = 0;
  const strict = new StripeClient('rk_test_unit', () => { calls++; return Promise.resolve(new Response('{"error":{"type":"invalid_request_error","code":"parameter_unknown","param":"foo","message":"Received unknown parameter: foo"}}', { status: 400, headers: { 'Request-Id': 'req_123' } })); }, { retryDelayMs: 1 });
  await assert.rejects(() => strict.request('POST', '/checkout/sessions', {}, 'key-2'), e => e.status === 502 && Boolean(e.messageEs));
  logs.restore();
  assert.equal(calls, 1);
  const logged = logs.events().find(e => e.event === 'stripe_api_error');
  assert.equal(logged.param, 'foo'); assert.equal(logged.request_id, 'req_123');
  assert.ok(!JSON.stringify(logs.lines).includes('rk_test_unit'), 'the key is never logged');

  calls = 0;
  const noRetry = new StripeClient('rk_test_unit', () => { calls++; return Promise.resolve(new Response('{}', { status: 500, headers: { 'Stripe-Should-Retry': 'false' } })); }, { retryDelayMs: 1 });
  const quiet = captureLogs();
  await assert.rejects(() => noRetry.request('POST', '/checkout/sessions', {}, 'key-3'));
  quiet.restore();
  assert.equal(calls, 1);
});

test('the checkout request asks Stripe for phone, delivery estimate, clear texts and explicit tax settings', async () => {
  const fake = createFakeStripe();
  const created = await withFake(fake, async () => (await handleApi(checkoutRequest(sample()), TEST_ENV)).json());
  const params = fake.sessions.get(created.id)._params;
  assert.equal(params.phone_number_collection.enabled, 'true');
  assert.equal(params.automatic_tax.enabled, 'false');
  assert.equal(params.allow_promotion_codes, undefined);
  assert.deepEqual(params.shipping_address_collection.allowed_countries, ['US', 'PR']);
  assert.equal(params.shipping_options[0].shipping_rate_data.delivery_estimate.maximum.value, '7');
  assert.match(params.custom_text.submit.message, /made to order/);
  assert.equal(params.payment_intent_data.metadata.order_ref, created.reference);
  assert.match(params.line_items[0].price_data.product_data.description, /Initial: E · Name: Emma · Name font: Allura · Initial font: Al Bayan · Accessories: none · Initial color: Sky blue · Name color: White/);
  assert.equal(params.line_items[0].price_data.product_data.images[0], 'https://shop.example/assets/catalog/stripe/initial-name.jpg');
  assert.deepEqual(fake.contractErrors, []);

  const flags = createFakeStripe();
  const withFlags = { ...TEST_ENV, STRIPE_AUTOMATIC_TAX: 'true', ALLOW_PROMOTION_CODES: 'true' };
  const second = await withFake(flags, async () => (await handleApi(checkoutRequest({ ...sample(), delivery: 'pickup', language: 'es' }), withFlags)).json());
  const p2 = flags.sessions.get(second.id)._params;
  assert.equal(p2.automatic_tax.enabled, 'true');
  assert.equal(p2.allow_promotion_codes, 'true');
  assert.equal(p2.line_items[0].price_data.tax_behavior, 'exclusive');
  assert.equal(p2.shipping_options[0].shipping_rate_data.tax_behavior, 'exclusive');
  assert.equal(p2.shipping_options[0].shipping_rate_data.display_name, 'Retiro sin cargo · Katy, TX');
  assert.equal(p2.shipping_address_collection, undefined);
  assert.equal(p2.locale, 'es');
  assert.match(p2.custom_text.submit.message, /retiro en Katy/);
  assert.deepEqual(flags.contractErrors, []);
});

test('a webhook for a session that is not from the store (e.g. a Payment Link) is acknowledged and ignored', async () => {
  const fake = createFakeStripe();
  const foreign = fake.createSession({ mode: 'payment', line_items: [], metadata: { source: 'payment_link' } });
  fake.complete(foreign.id);
  await withFake(fake, async () => {
    const response = await handleApi(webhookRequest(fake, foreign.id), TEST_ENV);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, true);
  });
  assert.equal(fake.emails.length, 0);
});

test('delayed payment methods: no email until Stripe confirms the payment', async () => {
  const fake = createFakeStripe();
  const { id } = await paidSession(fake, sample(), TEST_ENV, { paymentStatus: 'unpaid' });
  await withFake(fake, async () => {
    assert.equal((await (await handleApi(webhookRequest(fake, id), TEST_ENV)).json()).paid, false);
    assert.equal(fake.emails.length, 0);
    fake.sessions.get(id).payment_status = 'paid';
    assert.equal((await handleApi(webhookRequest(fake, id, 'checkout.session.async_payment_succeeded'), TEST_ENV)).status, 200);
    assert.equal(fake.emails.length, 2);
    fake.sessions.get(id).payment_status = 'unpaid';
    assert.equal((await (await handleApi(webhookRequest(fake, id, 'checkout.session.async_payment_failed'), TEST_ENV)).json()).paid, false);
  });
});

test('if the email service fails, Stripe is asked to retry and nothing is marked as sent', async () => {
  const fake = createFakeStripe();
  const { id } = await paidSession(fake);
  const logs = captureLogs();
  fake.failures.resend.push({ status: 500, body: { name: 'internal_server_error', message: 'down' }, headers: {} });
  await withFake(fake, async () => {
    await assert.rejects(() => handleApi(webhookRequest(fake, id), TEST_ENV), e => e.status === 503);
    assert.equal(fake.sessions.get(id).metadata.shop_notified, undefined);
    assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200);
  });
  logs.restore();
  assert.equal(fake.emails.filter(e => e.to[0] === 'yuma3dstudio@gmail.com').length, 1);
  assert.ok(logs.events().some(e => e.event === 'email_failed' && e.role === 'shop'));
});

test('a rejected buyer address does not block the order or loop forever', async () => {
  const fake = createFakeStripe();
  const { id } = await paidSession(fake);
  // First Resend call (Yuma) succeeds, the buyer email is rejected as invalid (422).
  const logs = captureLogs();
  await withFake(fake, async () => {
    const original = fake.transport;
    let n = 0;
    fake.transport = async (url, init) => (url.endsWith('/emails') && ++n === 2
      ? new Response('{"name":"validation_error","message":"Invalid `to` field"}', { status: 422 })
      : original(url, init));
    assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200);
    fake.transport = original;
  });
  logs.restore();
  assert.equal(fake.sessions.get(id).metadata.shop_notified, 'true');
  assert.equal(fake.sessions.get(id).metadata.buyer_notified, 'failed');
});

test('taxes or discounts added by Stripe do not block the order email; a real mismatch is flagged', async () => {
  const fake = createFakeStripe();
  const { id } = await paidSession(fake, sample(), TEST_ENV, { tax: 421, discount: 500 });
  await withFake(fake, async () => assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200));
  const shop = fake.emails.find(e => e.to[0] === 'yuma3dstudio@gmail.com');
  assert.match(shop.text, /Impuestos: \$4\.21/);
  assert.match(shop.text, /Descuento: −\$5\.00/);
  assert.doesNotMatch(shop.text, /ATENCIÓN/);

  const tampered = createFakeStripe();
  const second = await paidSession(tampered);
  tampered.sessions.get(second.id).amount_subtotal = 100;
  const logs = captureLogs();
  await withFake(tampered, async () => assert.equal((await handleApi(webhookRequest(tampered, second.id), TEST_ENV)).status, 200));
  logs.restore();
  assert.match(tampered.emails[0].text, /ATENCIÓN/);
  assert.ok(logs.events().some(e => e.event === 'order_amount_mismatch'));
});

test('emails are readable: Spanish labels for Yuma, the buyer language for the buyer, HTML escaped', async () => {
  const fake = createFakeStripe();
  const input = sample();
  input.items[0].options.accessories = { accessories: ['stars', 'birth'] };
  Object.assign(input.items[0].options.colors, { 'acc-accessories-stars': 'rainbow', 'acc-accessories-birth': 'gold' });
  Object.assign(input.items[0].options.text, { 'birth-date': '2026-01-23', 'birth-time': '08:13', 'birth-weight': '9.1 lb' });
  input.items.push({ productId: 'social-nfc-keychain', quantity: 1, options: { colors: { baseColor: 'black', detailColor: 'white' }, profiles: [{ network: 'Instagram', handle: '<b>@yuma</b>' }] } });
  const { id } = await paidSession(fake, input, TEST_ENV, { email: 'ana@example.com' });
  await withFake(fake, async () => assert.equal((await handleApi(webhookRequest(fake, id), TEST_ENV)).status, 200));
  const shop = fake.emails.find(e => e.to[0] === 'yuma3dstudio@gmail.com');
  const buyer = fake.emails.find(e => e.to[0] === 'ana@example.com');
  for (const line of ['Letra inicial: E', 'Nombre: Emma', 'Adornos: Estrellas, Detalle de nacimiento (fecha, hora y peso)', 'Color de la inicial: Azul cielo', 'Estrellas: Arcoíris', 'Fecha de nacimiento: 2026-01-23', 'Peso al nacer (con unidad): 9.1 lb', 'Detalle de nacimiento (fecha, hora y peso): Dorado', 'Envío UPS a: Ana Pérez', '123 Main St, Katy, TX, 77449, US', 'Teléfono: +18325550100', 'Instagram: <b>@yuma</b>']) assert.ok(shop.text.includes(line), line);
  assert.match(shop.subject, /^\[PRUEBA\] Pedido YM-[0-9A-Z]{8} · \$\d+\.\d\d · Envío UPS$/);
  assert.equal(shop.reply_to, 'ana@example.com');
  assert.ok(shop.html.includes('&lt;b&gt;@yuma&lt;/b&gt;') && !shop.html.includes('<b>@yuma</b>'), 'buyer text is escaped in HTML');
  assert.ok(buyer.text.includes('Initial: E') && buyer.text.includes('Accessories: Stars, Birth details (date, time and weight)') && buyer.text.includes('Stars: Rainbow'));
  assert.equal(buyer.reply_to, 'yuma3dstudio@gmail.com');
  assert.match(buyer.subject, /^\[TEST\] Your Yuma 3D Studio order YM-/);
  assert.equal(shop.headers['Idempotency-Key'], 'yuma-shop-' + id);
});

test('the return page shows details only to the browser that paid', async () => {
  const fake = createFakeStripe();
  const { id, reference } = await paidSession(fake);
  const result = cookie => handleApi(new Request(`https://shop.example/api/checkout/result?session_id=${id}`, { headers: cookie ? { Cookie: 'yuma_checkout=' + cookie } : {} }), TEST_ENV).then(r => r.json());
  await withFake(fake, async () => {
    const mine = await result(visitor);
    assert.equal(mine.paid, true); assert.equal(mine.reference, reference); assert.equal(mine.total, 5100);
    assert.equal(mine.items[0].details.es[0], 'Letra inicial: E');
    const other = await result('00000000-0000-4000-8000-000000000000');
    assert.equal(other.paid, true); assert.equal(other.limited, true); assert.equal(other.items, undefined);
    assert.equal((await result(null)).limited, true);
    await assert.rejects(() => handleApi(new Request('https://shop.example/api/checkout/result?session_id=cs_live_abc'), TEST_ENV), e => e.status === 400);
    const foreign = fake.createSession({ mode: 'payment', line_items: [], metadata: {} });
    await assert.rejects(() => handleApi(new Request(`https://shop.example/api/checkout/result?session_id=${foreign.id}`), TEST_ENV), e => e.status === 404);
  });
});

test('errors carry a Spanish message for the Spanish storefront', async () => {
  const p = sample(); p.items[0].quantity = 99; p.language = 'es';
  const fake = createFakeStripe();
  await withFake(fake, () => assert.rejects(() => handleApi(checkoutRequest(p), TEST_ENV), e => e.status === 400 && e.messageEs === 'Elige una cantidad de 1 a 10.'));
});

test('checkout status sets the visitor cookie, Secure only over https', async () => {
  const secure = await handleApi(new Request('https://shop.example/api/checkout/status'), TEST_ENV);
  assert.match(secure.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const local = await handleApi(new Request('http://localhost:8787/api/checkout/status'), TEST_ENV);
  assert.doesNotMatch(local.headers.get('Set-Cookie'), /Secure/);
  const again = await handleApi(new Request('https://shop.example/api/checkout/status', { headers: { Cookie: 'yuma_checkout=' + visitor } }), TEST_ENV);
  assert.equal(again.headers.get('Set-Cookie'), null);
});

test('local email log mode only exists in test mode', () => {
  assert.equal(checkoutConfig({ ...TEST_ENV, ORDER_EMAIL_API_KEY: '', ORDER_EMAIL_MODE: 'log' }).configured, true);
  assert.equal(checkoutConfig({ ...TEST_ENV, ORDER_EMAIL_API_KEY: '', ORDER_EMAIL_MODE: 'log' }).emailDelivery, 'log');
  assert.equal(checkoutConfig({ ...TEST_ENV, STRIPE_MODE: 'live', STRIPE_ACCOUNT_ID: 'acct_1UVgaICbK0UdCU0G', STRIPE_SECRET_KEY: 'rk_live_x', ORDER_EMAIL_API_KEY: '', ORDER_EMAIL_MODE: 'log' }).emailConfigured, false);
});

test('API base overrides can only point to localhost in test mode', async () => {
  const fake = createFakeStripe();
  const logs = captureLogs();
  await withFake(fake, async () => {
    await assert.rejects(() => handleApi(checkoutRequest(sample()), { ...TEST_ENV, STRIPE_API_BASE: 'https://evil.example' }), e => e.status === 503);
    await assert.rejects(() => handleApi(checkoutRequest(sample()), { ...TEST_ENV, STRIPE_MODE: 'live', STRIPE_ACCOUNT_ID: 'acct_1UVgaICbK0UdCU0G', STRIPE_SECRET_KEY: 'rk_live_x', STRIPE_API_BASE: 'http://127.0.0.1:12111' }), e => e.status === 503);
  });
  logs.restore();
  assert.equal(fake.requests.length, 0, 'no request left with the key');
});

test('optional Cloudflare rate limiter returns 429', async () => {
  const fake = createFakeStripe();
  const env = { ...TEST_ENV, CHECKOUT_LIMITER: { limit: async () => ({ success: false }) } };
  await withFake(fake, () => assert.rejects(() => handleApi(checkoutRequest(sample()), env), e => e.status === 429));
});

test('the merchant account is verified once and cached', async () => {
  const fake = createFakeStripe();
  await withFake(fake, async () => {
    for (let i = 0; i < 3; i++) await handleApi(checkoutRequest({ ...sample(), nonce: `12345678-1234-4234-8234-12345678900${i}` }), { ...TEST_ENV, STRIPE_SECRET_KEY: 'rk_test_cachecheck' });
  });
  assert.equal(fake.requests.filter(r => r.url.endsWith('/v1/account')).length, 1);
});

test('the wrong Stripe account is refused before any checkout is created', async () => {
  const fake = createFakeStripe({ accountId: 'acct_SOMEONE_ELSE' });
  const logs = captureLogs();
  await withFake(fake, () => assert.rejects(() => handleApi(checkoutRequest(sample()), { ...TEST_ENV, STRIPE_SECRET_KEY: 'rk_test_wrongaccount' }), e => e.status === 503));
  logs.restore();
  assert.equal(fake.sessions.size, 0);
  assert.ok(logs.events().some(e => e.event === 'stripe_account_mismatch'));
});

test('itemDetails falls back gracefully and labels every part', () => {
  const lines = itemDetails({ productId: 'lipgloss-keychain', designId: 'cup', colors: { baseColor: 'pink', lid: 'white', handle: 'black' }, text: {} }, 'es');
  assert.deepEqual(lines, ['Diseño: Vaso con asa', 'Cuerpo del vaso: Rosa pastel', 'Tapa: Blanco', 'Asa: Negro']);
});

test('if Stripe objects to a product photo, the checkout is created without photos instead of failing', async () => {
  const fake = createFakeStripe();
  const calls = [];
  const client = {
    request: async (method, path, values, key) => {
      calls.push(structuredClone(values));
      if (calls.length === 1) throw Object.assign(new Error('Stripe could not process this request.'), { status: 502, stripe: { status: 400, type: 'invalid_request_error', param: 'line_items[0][price_data][product_data][images][0]' } });
      const created = await fake.transport('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: 'Bearer rk_test_x', 'Stripe-Version': 'v', 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key }, body: new URLSearchParams() });
      return { id: 'cs_test_retry', url: 'https://checkout.stripe.com/c/pay/cs_test_retry', livemode: false, created: await created.json() };
    },
  };
  const logs = captureLogs();
  const result = await createSession(sample(), 'https://shop.example', visitor, client);
  logs.restore();
  assert.equal(result.id, 'cs_test_retry');
  assert.ok(calls[0].line_items[0].price_data.product_data.images);
  assert.equal(calls[1].line_items[0].price_data.product_data.images, undefined);
  assert.ok(logs.events().some(e => e.event === 'checkout_images_rejected'));
  // Any other Stripe error is not retried.
  const other = { request: async () => { throw Object.assign(new Error('x'), { status: 502, stripe: { status: 400, param: 'locale' } }); } };
  await assert.rejects(() => createSession(sample(), 'https://shop.example', visitor, other), e => e.stripe.param === 'locale');
});

/* ---- Rules added by Codex on 2 Nov 2026 (name fonts, sale prices, Christmas sets, charms, photo frame) ---- */

test('name fonts: required for products with a name, kept in the order; the initial is always Al Bayan', () => {
  const order = validateCart(sample());
  assert.equal(order.items[0].nameFont, 'Allura');
  assert.equal(order.items[0].initialFont, 'Al Bayan');
  assert.equal(order.items[1].nameFont, undefined, 'no name, no font');
  assert.ok(itemDetails(order.items[0], 'es').includes('Tipografía del nombre: Allura'));
  const p = sample(); p.items[0].options.font = 'Comic Sans';
  assert.throws(() => validateCart(p), /name font/);
  delete p.items[0].options.font;
  assert.throws(() => validateCart(p), /name font/);
});

test('sale prices are display only: Stripe charges the catalog selling price; percentages match', () => {
  const priced = CATALOG.filter(product => product.discount_percent > 0);
  assert.ok(new Set(priced.map(product => product.discount_percent)).size > 1);
  for (const product of priced) {
    assert.ok(product.compare_at_cents > product.price_cents);
    assert.equal(product.discount_percent, Math.round((100 * (product.compare_at_cents - product.price_cents)) / product.compare_at_cents));
  }
  assert.equal(validateCart(sample()).items[0].unitAmount, 3500);
});

test('Christmas: each of the three sets costs $10; the buyer only chooses the set (no colors, as the shop asked)', () => {
  const product = CATALOG.find(p => p.id === 'christmas-sets');
  assert.equal(product.personalization.design_options.length, 3);
  for (const design of product.personalization.design_options) {
    assert.deepEqual(design.color_fields, []);
    const order = validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: product.id, quantity: 1, options: { designId: design.id } }] });
    assert.equal(order.total, 1000);
    assert.equal(order.items[0].designId, design.id);
    assert.deepEqual(order.items[0].colors, {});
  }
  assert.throws(() => validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: product.id, quantity: 1, options: {} }] }), /design/);
});

test('design choices the shop asked for (2 Nov): can opener, lip gloss textures, wholesale; fitness opener; star on the moon', () => {
  const opener = validateCart({ nonce, language: 'es', delivery: 'pickup', items: [{ productId: 'can-opener-keychain', quantity: 1, options: { designId: 'kiss', colors: { 'design-color': 'dark-pink', detailColor: 'gold' } } }] });
  assert.deepEqual(itemDetails(opener.items[0], 'es'), ['Diseño del abridor: Forma de beso', 'Color del diseño: Rosa oscuro', 'Contorno: Dorado']);
  const gloss = validateCart({ nonce, language: 'es', delivery: 'pickup', items: [{ productId: 'lipgloss-keychain', quantity: 1, options: { designId: 'texture-butterflies', colors: { baseColor: 'beige' } } }] });
  assert.deepEqual(itemDetails(gloss.items[0], 'es'), ['Diseño: Textura de mariposas', 'Cuerpo del porta lipgloss: Beige']);
  const fitness = validateCart({ nonce, language: 'es', delivery: 'pickup', items: [{ productId: 'fitness-keychain', quantity: 1, options: { colors: { baseColor: 'brown', detailColor: 'dark-blue', opener: 'pink' } } }] });
  assert.ok(itemDetails(fitness.items[0], 'es').includes('Abridor de latas en forma de paleta: Rosa pastel'));
  const wholesale = CATALOG.find(p => p.id === 'wholesale-keychains').personalization;
  assert.deepEqual(wholesale.design_options.map(o => o.id), ['bows', 'hearts', 'flowers', 'butterflies']);
  assert.deepEqual(wholesale.color_fields.map(f => f.label.es), ['Color del diseño']);
  for (const id of ['wall-name-seven', 'wall-name-four']) {
    const labels = CATALOG.find(p => p.id === id).personalization.color_fields.map(f => f.label.es);
    assert.ok(labels.includes('Estrella de la luna') && !labels.some(l => /Mariposa/.test(l)), id);
  }
});

test('palette: two blues, two pinks, beige, brown and gold are offered on every full-palette product', () => {
  for (const product of CATALOG.filter(p => p.personalization.colors?.length)) {
    for (const color of ['blue', 'dark-blue', 'pink', 'dark-pink', 'beige', 'brown', 'gold']) assert.ok(product.personalization.colors.includes(color), `${product.id} ${color}`);
  }
});

test('charms: exactly two different solid colors; cooler needs name and colors; photo frame and logo are payable; removed products are not', () => {
  const charms = { nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'charms-keychain', quantity: 1, options: { colors: { baseColor: 'purple', detailColor: 'white', flower: 'red' }, text: { name: 'Laura' }, font: 'Cookie' } }] };
  const order = validateCart(charms);
  assert.equal(order.total, 1500);
  assert.deepEqual(order.items[0].colors, { baseColor: 'purple', detailColor: 'white' });
  charms.items[0].options.colors.detailColor = 'purple';
  assert.throws(() => validateCart(charms), /two different colors/);
  charms.items[0].options.colors.detailColor = 'rainbow';
  assert.throws(() => validateCart(charms));
  // Cooler: editable name on the plaque + body color + lid/handle/tap color (no BTS sign).
  assert.throws(() => validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'personalized-can-cooler', quantity: 1, options: {} }] }));
  const cooler = validateCart({ nonce, language: 'es', delivery: 'pickup', items: [{ productId: 'personalized-can-cooler', quantity: 1, options: { colors: { baseColor: 'black', detailColor: 'beige' }, text: { 'plaque-name': 'Jin' } } }] });
  assert.equal(cooler.items[0].unitAmount, CATALOG.find(p => p.id === 'personalized-can-cooler').price_cents);
  assert.deepEqual(itemDetails(cooler.items[0], 'es'), ['Nombre de la placa: Jin', 'Termo: Negro', 'Tapa, asa y llave: Beige']);
  // Photo frame and business logo are payable; the buyer sends the photos / logo on WhatsApp after paying.
  const frame = validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'photo-frame', quantity: 1, options: { colors: { baseColor: 'white', detailColor: 'gold' } } }] });
  assert.equal(frame.total, 3500);
  assert.equal(frame.items[0].sendAfterPayment, 'photos');
  const logo = validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'business-logo', quantity: 1, options: { colors: { baseColor: 'white', detailColor: 'gold', rim: 'gold', 'logo-detail': 'black' } } }] });
  assert.equal(logo.items[0].sendAfterPayment, 'logo');
  assert.throws(() => validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'name-accessory-keychain', quantity: 1, options: {} }] }), /no longer available/);
  assert.throws(() => validateCart({ nonce, language: 'en', delivery: 'pickup', items: [{ productId: 'raised-name-keychain', quantity: 1, options: {} }] }), /no longer available/);
});

test('cord keychains: "1 name + accessories" (3 cord + 2 external, two colors) and "2 names" (only external accessories)', () => {
  const cart = (productId, options) => ({ nonce, language: 'es', delivery: 'pickup', items: [{ productId, quantity: 1, options }] });
  const one = { colors: { baseColor: 'purple', detailColor: 'white' }, text: { name: 'Laura' }, font: 'Allura' };
  const order = validateCart(cart('charms-keychain', { ...one, accessories: { cord: ['heart', 'paws', 'stars'], external: ['camera', 'bow'] } }));
  const lines = itemDetails(order.items[0], 'es');
  assert.ok(lines.includes('Nombre: Laura'));
  assert.ok(lines.includes('Accesorios del cordón: Corazón, Patita de perrito, Estrella'));
  assert.ok(lines.includes('Accesorios externos: Cámara, Lazo'));
  assert.deepEqual(Object.keys(order.items[0].colors), ['baseColor', 'detailColor'], 'accessories are made in the same two colors');
  assert.throws(() => validateCart(cart('charms-keychain', { ...one, accessories: { cord: ['heart', 'stars', 'bows', 'paws'] } })), /accessories/);
  assert.throws(() => validateCart(cart('charms-keychain', { ...one, accessories: { external: ['flower', 'camera', 'lipgloss'] } })), /accessories/);
  assert.throws(() => validateCart(cart('charms-keychain', { ...one, colors: { baseColor: 'purple', detailColor: 'purple' } })), /two different colors|dos colores/i);
  assert.equal(validateCart(cart('charms-keychain', one)).total, 1500, 'accessories are optional');

  const two = { colors: { baseColor: 'white', detailColor: 'dark-pink', 'second-base': 'white', 'second-name': 'dark-pink' }, text: { 'first-name': 'Ana', 'second-name': 'Luz' }, font: 'Lobster' };
  const twoOrder = validateCart(cart('two-names-keychain', { ...two, accessories: { cord: ['heart'], external: ['camera', 'heart'] },
    colors: { ...two.colors, 'acc-external-camera': 'white', 'acc-external-heart': 'pink' } }));
  assert.deepEqual(twoOrder.items[0].accessories, { external: ['camera', 'heart'] }, 'no cord accessories with two names');
  const twoLines = itemDetails(twoOrder.items[0], 'es');
  assert.ok(twoLines.includes('Primer nombre: Ana') && twoLines.includes('Segundo nombre: Luz'));
  assert.ok(twoLines.includes('Accesorios externos: Cámara, Corazón'));
  assert.ok(twoLines.includes('Cámara: Blanco'));
  assert.ok(!twoLines.some(line => line.startsWith('Accesorios del cordón')));
  assert.throws(() => validateCart(cart('two-names-keychain', { ...two, accessories: { external: ['camera'] } })), /color/);
  assert.equal(validateCart(cart('two-names-keychain', two)).total, 1500);
});
