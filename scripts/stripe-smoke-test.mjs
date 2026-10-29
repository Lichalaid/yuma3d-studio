// Real check against Yuma's Stripe SANDBOX: account, key permissions, Checkout creation and
// the order snapshot round trip. Never touches live mode and never charges anything.
//
//   npm run stripe:check          creates a test checkout, verifies it and expires it
//   npm run stripe:check -- --keep   leaves it open and prints the URL to pay with 4242 4242 4242 4242
//
// Reads STRIPE_SECRET_KEY (and optional flags) from the environment or from .dev.vars.
import { readFileSync, existsSync } from 'node:fs';

globalThis.__STATIC_FILES__ = null;
const { StripeClient, createSession, decodeOrder, checkoutConfig } = await import('../worker/checkout.js');

const fileVars = {};
const devVars = new URL('../.dev.vars', import.meta.url);
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) fileVars[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
const env = { ...fileVars, ...process.env };
const keep = process.argv.includes('--keep');
const ok = text => console.log('  ✓ ' + text);
const stop = text => { console.error('  ✗ ' + text); process.exit(1); };

console.log('Yuma 3D Studio · Stripe sandbox check\n');
if (!/^(rk|sk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY || '')) stop('STRIPE_SECRET_KEY must be a SANDBOX key (rk_test_… or sk_test_…). This script never uses live keys.');
const config = checkoutConfig({ ...env, STRIPE_MODE: 'test' });
const apiBase = env.STRIPE_API_BASE && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(env.STRIPE_API_BASE) ? env.STRIPE_API_BASE : 'https://api.stripe.com';
const stripe = new StripeClient(env.STRIPE_SECRET_KEY, undefined, { apiBase, maxRetries: 1 });
const step = async (label, fn) => {
  try { return await fn(); } catch (error) {
    stop(`${label} failed: ${error.message}\n    Stripe's exact reason is in the JSON line above (look for "message"). If it names a missing permission, add only that one to the restricted key.`);
  }
};

const account = await step('Reading the account (permission: Accounts → Read)', () => stripe.request('GET', '/account'));
if (account.id !== 'acct_1UVZa22S141stGeG') stop(`This key belongs to ${account.id}, not to Yuma's sandbox (acct_1UVZa22S141stGeG).`);
ok(`Key belongs to Yuma's sandbox (${account.id})`);

const cart = {
  nonce: crypto.randomUUID(), language: 'en', delivery: 'ship',
  items: [
    { productId: 'initial-name', quantity: 1, options: { designId: 'stars', colors: { baseColor: 'pink', detailColor: 'white', 'star-1': 'yellow', 'star-2': 'yellow', 'star-3': 'rainbow', 'star-4': 'purple' }, text: { initial: 'E', name: 'Emma' } } },
    { productId: 'name-accessory-keychain', quantity: 1, options: { colors: { baseColor: 'pink', detailColor: 'white', charm: 'blue', 'charm-details': 'white' }, text: { name: 'Rose' } } },
  ],
};
// An https origin makes the request include the product photos, exactly as on the published site.
const settings = JSON.parse(readFileSync(new URL('../site-settings.json', import.meta.url), 'utf8'));
const origin = /^https:\/\/[^/]+$/.test(env.SITE_ORIGIN || '') ? env.SITE_ORIGIN : settings.origin;
const created = await step('Creating a Checkout Session (permissions: Checkout Sessions, Products, Prices, Shipping Rates → Write)',
  () => createSession(cart, origin, crypto.randomUUID(), stripe, 'test', config));
ok(`Checkout Session created: ${created.reference} · $${(created.total / 100).toFixed(2)} (expected $47.99)`);

const session = await step('Reading the session back', () => stripe.request('GET', `/checkout/sessions/${created.id}`));
const order = await decodeOrder(session.metadata);
if (session.amount_subtotal !== 4300 || session.total_details?.amount_shipping !== 499) stop(`Unexpected amounts: subtotal ${session.amount_subtotal}, shipping ${session.total_details?.amount_shipping}`);
if (order.items[0].text.name !== 'Emma' || order.items[0].colors['star-3'] !== 'rainbow') stop('The order snapshot did not survive the round trip');
ok(`Stripe stored the full personalization (${Object.keys(session.metadata).length} metadata keys)`);

await step('Updating metadata (used by the webhook to avoid duplicate emails)', async () => {
  await stripe.request('POST', `/checkout/sessions/${created.id}`, { metadata: { smoke_test: 'true' } }, 'yuma-smoke-' + created.id);
  await stripe.request('POST', `/checkout/sessions/${created.id}`, { metadata: { smoke_test: '' } }, 'yuma-smoke-clear-' + created.id);
});
ok('The key can update Checkout Session metadata');

if (keep) {
  console.log(`\nOpen this test checkout and pay with 4242 4242 4242 4242, any future date and any CVC:\n${created.url}\n`);
  console.log('With `npm run dev` and `stripe listen --forward-to localhost:8787/api/stripe/webhook` running, the order email appears in the dev terminal.');
} else {
  await step('Expiring the test session', () => stripe.request('POST', `/checkout/sessions/${created.id}/expire`, {}, 'yuma-smoke-expire-' + created.id));
  ok('Test session expired (nothing was charged)');
}
console.log('\nAll checks passed: this key is ready for the test store.');
