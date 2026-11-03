import { readFileSync } from 'node:fs';
import Stripe from 'stripe';

export const CATALOG = JSON.parse(readFileSync(new URL('../../catalog-products.json', import.meta.url), 'utf8'));
export const nonce = '12345678-1234-4234-8234-123456789abc';
export const visitor = '9b2f7a10-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
export const WEBHOOK_SECRET = 'whsec_unitTestSecret123';
export const TEST_ENV = {
  CHECKOUT_ENABLED: 'true', STRIPE_MODE: 'test', STRIPE_ACCOUNT_ID: 'acct_1UVZa22S141stGeG',
  STRIPE_SECRET_KEY: 'rk_test_unit123', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  ORDER_EMAIL_API_KEY: 're_unit123', ORDER_EMAIL_FROM: 'Yuma 3D Studio <orders@yuma3dstudio.com>',
};

export const sample = () => ({
  nonce, language: 'en', delivery: 'ship',
  items: [
    { productId: 'initial-name', quantity: 1, price: 1, options: { designId: 'none', colors: { baseColor: 'blue', detailColor: 'white' }, text: { initial: 'e', name: 'Emma' }, font: 'Allura' } },
    { productId: 'fitness-keychain', quantity: 2, options: { colors: { baseColor: 'pink', detailColor: 'white', opener: 'blue' } } },
  ],
});

/** A valid personalization for any purchasable catalog product. */
export function validOptions(product) {
  const config = product.personalization;
  const design = config.design_options?.find(d => product.id !== 'initial-name' || ['none', 'stars'].includes(d.id));
  const colorFields = design?.color_fields || config.color_fields;
  const colors = Object.fromEntries((colorFields || []).map((field, i) => [field.key, config.colors[i % config.colors.length]]));
  const baseText = design?.text_fields || config.text_fields || [];
  const textFields = [...baseText, ...(design?.extra_text_fields || [])];
  const text = Object.fromEntries(textFields.map(field => [field.key, field.kind === 'initial' ? 'e' : field.kind === 'name' ? 'Emma' : 'Yuma Studio']));
  const profiles = config.type === 'social'
    ? (config.multiple_profiles ? [{ network: 'Instagram', handle: '@yuma3dstudio' }, { network: 'TikTok', handle: '@yuma3d' }] : [{ network: 'Instagram', handle: '@yuma3dstudio' }])
    : undefined;
  const font = baseText.some(field => ['name', 'first-name', 'second-name'].includes(field.key)) ? 'Satisfy' : undefined;
  return { ...(design ? { designId: design.id } : {}), colors, text, ...(profiles ? { profiles } : {}), ...(font ? { font } : {}) };
}
// Photo designs are priced but ordered through WhatsApp until the store can receive the photos.
export const purchasable = () => CATALOG.filter(p => Number.isInteger(p.price_cents) && p.personalization.type !== 'photos');

/** Signs a webhook payload exactly like Stripe, using Stripe's official SDK. */
export function signedWebhook(payload, secret = WEBHOOK_SECRET, url = 'https://shop.example/api/stripe/webhook') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
  return new Request(url, { method: 'POST', headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' }, body });
}

export function checkoutRequest(input, { origin = 'https://shop.example', cookie = visitor } = {}) {
  return new Request(origin + '/api/checkout', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'yuma_checkout=' + cookie } : {}) },
    body: JSON.stringify(input),
  });
}

/** Routes the Worker's fetch calls to the fakes; returns a restore function. */
export function useFakeFetch(fake) {
  const original = globalThis.fetch;
  globalThis.fetch = function (url, init) {
    // Same rule as Cloudflare Workers: fetch must not be called as a method of another object.
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    const target = String(url);
    if (target.startsWith('https://api.stripe.com/') || target.startsWith('https://api.resend.com/')) return fake.transport(target, init);
    throw new Error('Unexpected outbound request: ' + target);
  };
  return () => { globalThis.fetch = original; };
}

export function captureLogs() {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error']) console[level] = line => lines.push(String(line));
  return { lines, restore: () => Object.assign(console, original), events: () => lines.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }) };
}
