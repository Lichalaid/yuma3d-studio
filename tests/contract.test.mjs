// Contract tests against Stripe's official OpenAPI spec and Stripe's official Node SDK.
import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { handleApi, verifySignature, STRIPE_API_VERSION } from '../worker/checkout.js';
import { createFakeStripe } from './helpers/fake-services.mjs';
import { SPEC_VERSION, CHECKOUT_SESSION_FIELDS, validateStripeRequest } from './helpers/stripe-contract.mjs';
import { TEST_ENV, WEBHOOK_SECRET, signedWebhook, checkoutRequest, useFakeFetch, purchasable, validOptions } from './helpers/fixtures.mjs';

const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

test(`every purchasable product produces a request Stripe accepts (spec ${SPEC_VERSION})`, async () => {
  const fake = createFakeStripe();
  const restore = useFakeFetch(fake);
  let n = 0;
  try {
    for (const product of purchasable()) {
      for (const language of ['en', 'es']) {
        for (const delivery of ['ship', 'pickup']) {
          const input = { nonce: uuid(++n), language, delivery, items: [{ productId: product.id, quantity: 2, options: validOptions(product) }] };
          const response = await handleApi(checkoutRequest(input), TEST_ENV);
          const body = await response.json();
          assert.equal(response.status, 200, `${product.id} ${language} ${delivery}: ${JSON.stringify(body)}`);
          fake.complete(body.id, { email: `buyer${n}@example.com` });
          assert.equal((await handleApi(signedWebhook(fake.event(body.id)), TEST_ENV)).status, 200);
        }
      }
    }
  } finally { restore(); }
  assert.deepEqual(fake.contractErrors, [], fake.contractErrors.join('\n'));
  const posts = fake.requests.filter(r => r.method === 'POST' && r.url.endsWith('/checkout/sessions'));
  assert.equal(posts.length, purchasable().length * 4);
  assert.ok(fake.requests.some(r => r.method === 'POST' && /\/checkout\/sessions\/cs_test_/.test(r.url)), 'metadata updates were validated too');
  assert.ok(fake.requests.every(r => r.headers['Stripe-Version'] === STRIPE_API_VERSION));
});

test('a full bag (30 lines) and the largest social profiles stay within Stripe metadata limits', async () => {
  const fake = createFakeStripe();
  const restore = useFakeFetch(fake);
  try {
    const products = purchasable();
    const items = Array.from({ length: 30 }, (_, i) => ({ productId: products[i % products.length].id, quantity: 10, options: validOptions(products[i % products.length]) }));
    const response = await handleApi(checkoutRequest({ nonce: uuid(9001), language: 'es', delivery: 'ship', items }), TEST_ENV);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const { id } = await response.json();
    fake.complete(id);
    assert.equal((await handleApi(signedWebhook(fake.event(id)), TEST_ENV)).status, 200);
    const metadata = fake.sessions.get(id).metadata;
    assert.ok(Object.keys(metadata).length <= 50, `${Object.keys(metadata).length} metadata keys`);

    const random = length => Array.from({ length }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join('').replace(/[<>]/g, 'x');
    const social = purchasable().find(p => p.id === 'social-display');
    const profiles = Array.from({ length: 10 }, () => ({ network: random(80), handle: random(120) }));
    const big = await handleApi(checkoutRequest({ nonce: uuid(9002), language: 'en', delivery: 'pickup', items: [{ productId: 'social-display', quantity: 1, options: { ...validOptions(social), profiles } }] }), TEST_ENV);
    assert.equal(big.status, 200);
    const huge = Array.from({ length: 30 }, () => ({ productId: 'social-display', quantity: 1, options: { ...validOptions(social), profiles } }));
    await assert.rejects(() => handleApi(checkoutRequest({ nonce: uuid(9003), language: 'en', delivery: 'pickup', items: huge }), TEST_ENV), e => e.status === 400 || e.status === 413);
  } finally { restore(); }
  assert.deepEqual(fake.contractErrors, []);
});

test('the contract validator itself rejects what Stripe would reject', () => {
  const headers = { 'Stripe-Version': STRIPE_API_VERSION, Authorization: 'Bearer rk_test_x', 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'k' };
  const post = body => validateStripeRequest({ method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions', headers, body });
  assert.deepEqual(post('mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=3500&line_items[0][price_data][product_data][name]=Test'), []);
  assert.match(post('mode=payment&made_up_param=1').join(), /made_up_param: unknown parameter/);
  assert.match(post('mode=payment&line_items[0][price_data][unit_amount]=abc&line_items[0][price_data][currency]=usd&line_items[0][quantity]=1').join(), /expected integer/);
  assert.match(post('mode=payments').join(), /not one of/);
  assert.match(post('mode=payment&shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]=fortnight&shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]=1').join(), /not one of/);
  assert.match(post('mode=payment&custom_text[submit][message]=' + 'x'.repeat(1300)).join(), /longer than 1200/);
  assert.match(validateStripeRequest({ method: 'POST', url: 'https://api.stripe.com/v1/checkout/sessions', headers: { ...headers, 'Idempotency-Key': undefined }, body: 'mode=payment' }).join(), /Idempotency-Key/);
  assert.match(validateStripeRequest({ method: 'GET', url: 'https://api.stripe.com/v1/checkout/sessions/cs_test_a?bogus=1', headers }).join(), /unknown query parameter bogus/);
  assert.match(validateStripeRequest({ method: 'POST', url: 'https://api.stripe.com/v1/refunds', headers, body: '' }).join(), /not an operation/);
});

test('webhook signatures created by Stripe\'s official SDK are accepted; altered ones are not', async () => {
  const payload = JSON.stringify({ id: 'evt_sdk', type: 'checkout.session.completed' });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  assert.equal(await verifySignature(payload, header, WEBHOOK_SECRET), true);
  assert.equal(await verifySignature(payload.replace('evt_sdk', 'evt_x'), header, WEBHOOK_SECRET), false);
  assert.equal(await verifySignature(payload, header.replace(/v1=/, 'v0='), WEBHOOK_SECRET), false);
  // The SDK agrees with our reading of the same header.
  const event = Stripe.webhooks.constructEvent(payload, header, WEBHOOK_SECRET);
  assert.equal(event.id, 'evt_sdk');
});

test('the Checkout Session fields the Worker reads exist in the current Stripe API', () => {
  for (const field of ['id', 'url', 'livemode', 'status', 'payment_status', 'amount_subtotal', 'amount_total', 'currency', 'metadata', 'customer_details', 'collected_information', 'total_details', 'payment_intent']) {
    assert.ok(field in CHECKOUT_SESSION_FIELDS, field);
  }
  assert.ok(!('shipping_details' in CHECKOUT_SESSION_FIELDS), 'shipping lives in collected_information since 2025-03-31.basil');
  assert.match(STRIPE_API_VERSION, /^\d{4}-\d{2}-\d{2}\.endive$/);
});
