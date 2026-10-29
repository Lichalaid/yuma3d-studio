/*
 * Yuma 3D Studio — checkout logic for the Cloudflare Worker (imported by worker/index.js).
 *
 *   GET  /api/checkout/status   Whether online payment is enabled (never exposes secrets).
 *   POST /api/checkout          Validates the bag on the server and creates ONE Stripe Checkout Session.
 *   GET  /api/checkout/result   Payment status for the return page, verified with Stripe.
 *   POST /api/stripe/webhook    Signed Stripe events: emails the paid order to Yuma and to the buyer.
 *
 * Prices, shipping and personalization are always recomputed here from catalog-products.json.
 * Nothing the browser sends about amounts is trusted. Credentials are Worker secrets
 * (see ACTIVAR-STRIPE.md); none are stored in this file.
 */
import CATALOG from '../catalog-products.json' with { type: 'json' };

// Storefront files embedded by tools/build-checkout-worker.py for the single-file build.
// With Cloudflare Static Assets (wrangler.jsonc) this is null and env.ASSETS serves the site.
const FILES = __STATIC_FILES__;

export const STRIPE_API_VERSION = '2026-09-30.endive';
export const YUMA_ACCOUNTS = Object.freeze({ test: 'acct_1UVZa22S141stGeG', live: 'acct_1UVgaICbK0UdCU0G' });
const SHOP_EMAIL = 'yuma3dstudio@gmail.com';
const SHOP_WHATSAPP = '+1 832 507 2768';
const SHIPPING_CENTS = 499;
const FREE_SHIPPING_FROM_CENTS = 5000;
const MAX_LINES = 30;
const MAX_QUANTITY = 10;
// Accessories of "Initial + name" whose price is confirmed. The rest stay by quote.
const PURCHASABLE_INITIAL_DESIGNS = ['none', 'stars'];
const HANDLED_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'];
const ORDER_FORMAT = 'yuma-gzip-v1';
const METADATA_CHUNK = 450;
const MAX_METADATA_CHUNKS = 40; // 40 chunks + 4 order keys + 3 status flags stays under Stripe's 50 keys.
const ACCOUNT_CHECK_TTL_MS = 10 * 60 * 1000;
const COLOR_NAMES = {
  blue: { en: 'Blue', es: 'Azul' }, pink: { en: 'Pink', es: 'Rosado' }, red: { en: 'Red', es: 'Rojo' },
  rainbow: { en: 'Rainbow', es: 'Arcoíris' }, yellow: { en: 'Yellow', es: 'Amarillo' }, green: { en: 'Green', es: 'Verde' },
  purple: { en: 'Purple', es: 'Morado' }, white: { en: 'White', es: 'Blanco' }, black: { en: 'Black', es: 'Negro' },
};
const PRODUCTS = new Map(CATALOG.map(product => [product.id, product]));
const enc = new TextEncoder();

// Messages shown to buyers, in both store languages.
const MESSAGES = {
  items: ['Choose between 1 and 30 items.', 'Elige entre 1 y 30 productos.'],
  delivery: ['Choose shipping or pickup.', 'Elige envío o retiro.'],
  refresh: ['Refresh the checkout and try again.', 'Actualiza la página e inténtalo de nuevo.'],
  unavailable: ['One of the products is no longer available. Remove it and try again.', 'Uno de los productos ya no está disponible. Quítalo e inténtalo de nuevo.'],
  quote: ['This product needs a quote before payment.', 'Este producto se cotiza antes de pagar.'],
  quantity: ['Choose a quantity from 1 to 10.', 'Elige una cantidad de 1 a 10.'],
  design: ['Choose the design for this product.', 'Elige el diseño de este producto.'],
  accessory: ['Please request a quote for this accessory before payment.', 'Consulta el precio de este adorno antes de pagar.'],
  colors: ['Choose a color for every part.', 'Elige un color para cada pieza.'],
  required: ['Complete the required personalization fields.', 'Completa los datos de personalización obligatorios.'],
  text: ['Check the personalization text.', 'Revisa el texto de la personalización.'],
  initial: ['Enter one initial.', 'Escribe una sola letra inicial.'],
  name: ['Check the name.', 'Revisa el nombre.'],
  profiles: ['Check the social profiles.', 'Revisa los perfiles de redes sociales.'],
  tooLarge: ['This order has too much personalization. Please contact Yuma.', 'Este pedido tiene demasiados datos de personalización. Escríbele a Yuma.'],
  reload: ['Reload the page before checking out.', 'Vuelve a cargar la página antes de pagar.'],
  disabled: ['Online payments are not available yet. Please contact Yuma.', 'Los pagos en línea todavía no están disponibles. Escríbele a Yuma.'],
  notConfigured: ['Payments are not configured yet.', 'Los pagos todavía no están configurados.'],
  stripe: ['Stripe could not process this request. Please try again.', 'Stripe no pudo procesar el pedido. Inténtalo de nuevo.'],
  stripeDown: ['Stripe could not be reached. Please try again.', 'No pudimos conectar con Stripe. Inténtalo de nuevo.'],
  busy: ['Too many attempts. Wait a minute and try again.', 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.'],
  verify: ['The checkout could not be verified.', 'No pudimos verificar el pago.'],
  notFound: ['Order not found.', 'No encontramos el pedido.'],
  reference: ['Invalid checkout reference.', 'La referencia del pago no es válida.'],
};

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const fail = (message, status = 400, extra = {}) => {
  const [en, es] = Array.isArray(message) ? message : [message, message];
  return Object.assign(new Error(en), { status, messageEs: es, ...extra });
};
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
const digest = async value => hex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const money = cents => '$' + (cents / 100).toFixed(2);
const truncate = (text, max) => (Array.from(text).length > max ? Array.from(text).slice(0, max - 1).join('') + '…' : text);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function log(level, event, details = {}) {
  const line = JSON.stringify({ level, event, ...details });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}

const VISITOR_COOKIE = /(?:^|;\s*)yuma_checkout=([a-f0-9-]{36})/;
const cookieValue = request => request.headers.get('Cookie')?.match(VISITOR_COOKIE)?.[1];
const newCookie = (value, secure) => `yuma_checkout=${value}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Max-Age=604800`;

function formValues(value, key, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) value.forEach((v, i) => formValues(v, `${key}[${i}]`, out));
  else if (typeof value === 'object') Object.entries(value).forEach(([k, v]) => formValues(v, key ? `${key}[${k}]` : k, out));
  else out.append(key, String(value));
}

/** Minimal Stripe REST client: form encoding, pinned API version, idempotent retries and error logging. */
export class StripeClient {
  constructor(key, transport = (url, init) => fetch(url, init), { apiBase = 'https://api.stripe.com', maxRetries = 2, retryDelayMs = 300 } = {}) {
    this.key = key;
    // Workers throw "Illegal invocation" if fetch is called as a method of another object.
    // Keep it in a closure and always call it as a plain function.
    this.send = (url, init) => transport(url, init);
    this.apiBase = apiBase;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  async request(method, path, values, idempotencyKey) {
    const params = new URLSearchParams();
    formValues(values, '', params);
    const headers = { Authorization: `Bearer ${this.key}`, 'Stripe-Version': STRIPE_API_VERSION };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const url = `${this.apiBase}/v1${path}${method === 'GET' && params.size ? '?' + params.toString() : ''}`;
    const retryable = method === 'GET' || Boolean(idempotencyKey);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await this.send(url, { method, headers, ...(method === 'POST' ? { body: params.toString() } : {}), signal: AbortSignal.timeout(20000) });
      } catch (error) {
        if (retryable && attempt < this.maxRetries) { await sleep(this.retryDelayMs * 2 ** attempt); continue; }
        log('error', 'stripe_network_error', { method, path: logPath(path), message: String(error?.message || error) });
        throw fail(MESSAGES.stripeDown, 502);
      }
      const body = await response.json().catch(() => null);
      if (response.ok && body) return body;
      const shouldRetry = response.headers.get('Stripe-Should-Retry');
      const transient = shouldRetry === 'true' || (shouldRetry !== 'false' && (response.status === 429 || response.status >= 500));
      if (transient && retryable && attempt < this.maxRetries) { await sleep(this.retryDelayMs * 2 ** attempt); continue; }
      const error = body?.error || {};
      log('error', 'stripe_api_error', {
        method, path: logPath(path), status: response.status, type: error.type, code: error.code, param: error.param,
        message: error.message, request_id: response.headers.get('Request-Id'),
      });
      throw fail(MESSAGES.stripe, 502, { stripe: { status: response.status, type: error.type, code: error.code, param: error.param } });
    }
  }
}
const logPath = path => path.replace(/cs_(test|live)_[A-Za-z0-9]+/, 'cs_$1_…');

/* ---------------------------------------------------------------- configuration */

export function checkoutConfig(env) {
  const mode = env.STRIPE_MODE === 'live' ? 'live' : 'test';
  const keyConfigured = new RegExp(`^(?:sk|rk)_${mode}_[A-Za-z0-9]+$`).test(env.STRIPE_SECRET_KEY || '');
  const merchantConfigured = env.STRIPE_ACCOUNT_ID === YUMA_ACCOUNTS[mode];
  const webhookConfigured = /^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET || '');
  // "log" prints the emails in the Worker logs instead of sending them. Only for test mode (local trials).
  const emailDelivery = mode === 'test' && env.ORDER_EMAIL_MODE === 'log' ? 'log'
    : env.ORDER_EMAIL_API_KEY && /@/.test(env.ORDER_EMAIL_FROM || '') ? 'resend' : 'none';
  const emailConfigured = emailDelivery !== 'none';
  const enabled = env.CHECKOUT_ENABLED === 'true';
  return {
    mode, enabled, keyConfigured, merchantConfigured, webhookConfigured, emailConfigured, emailDelivery,
    configured: enabled && keyConfigured && merchantConfigured && webhookConfigured && emailConfigured,
    automaticTax: env.STRIPE_AUTOMATIC_TAX === 'true',
    promotionCodes: env.ALLOW_PROMOTION_CODES === 'true',
    buyerEmail: env.BUYER_CONFIRMATION_EMAIL !== 'off',
  };
}

// Local overrides exist only for automated tests and only in test mode: secrets can never be sent elsewhere.
function localOverride(env, name, fallback) {
  const value = env[name];
  if (!value) return fallback;
  if (env.STRIPE_MODE !== 'live' && /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(value)) return value;
  log('error', 'invalid_override', { name });
  throw fail(MESSAGES.notConfigured, 503);
}

function merchantClient(env) {
  const config = checkoutConfig(env);
  if (!config.keyConfigured || !config.merchantConfigured) throw fail(MESSAGES.notConfigured, 503);
  return new StripeClient(env.STRIPE_SECRET_KEY, undefined, { apiBase: localOverride(env, 'STRIPE_API_BASE', 'https://api.stripe.com') });
}

const verifiedAccounts = new Map();
async function checkedClient(env) {
  const stripe = merchantClient(env);
  const cacheKey = await digest(env.STRIPE_SECRET_KEY + '|' + env.STRIPE_ACCOUNT_ID);
  const cached = verifiedAccounts.get(cacheKey);
  if (cached && Date.now() - cached.at < ACCOUNT_CHECK_TTL_MS) return stripe;
  const account = await stripe.request('GET', '/account');
  if (account.id !== env.STRIPE_ACCOUNT_ID) {
    log('error', 'stripe_account_mismatch', { expected: env.STRIPE_ACCOUNT_ID, received: account.id });
    throw fail(MESSAGES.notConfigured, 503);
  }
  if (env.STRIPE_MODE === 'live' && !account.charges_enabled) {
    log('error', 'stripe_charges_disabled', { account: account.id });
    throw fail(MESSAGES.notConfigured, 503);
  }
  verifiedAccounts.set(cacheKey, { at: Date.now() });
  return stripe;
}

/* ---------------------------------------------------------------- cart validation */

function cleanText(value, max = 80) {
  if (typeof value !== 'string') throw fail(MESSAGES.required);
  const text = value.normalize('NFC').trim();
  if (!text) throw fail(MESSAGES.required);
  if (Array.from(text).length > max || /[\u0000-\u001f\u007f]/.test(text)) throw fail(MESSAGES.text);
  return text;
}

function productParts(product, designId) {
  const config = product?.personalization || {};
  const design = config.design_options?.find(option => option.id === designId);
  return {
    config, design,
    colorFields: design?.color_fields || config.color_fields || [],
    textFields: [...(config.text_fields || []), ...(design?.extra_text_fields || [])],
  };
}

function validateItem(item, language) {
  const product = typeof item?.productId === 'string' ? PRODUCTS.get(item.productId) : undefined;
  if (!product) throw fail(MESSAGES.unavailable);
  if (!Number.isInteger(product.price_cents) || product.price_cents <= 0) throw fail(MESSAGES.quote);
  if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) throw fail(MESSAGES.quantity);
  const draft = item.options && typeof item.options === 'object' ? item.options : {};
  const { config, design, colorFields, textFields } = productParts(product, draft.designId);
  if (config.design_options?.length && !design) throw fail(MESSAGES.design);
  if (product.id === 'initial-name' && !PURCHASABLE_INITIAL_DESIGNS.includes(design.id)) throw fail(MESSAGES.accessory);
  const colors = {};
  for (const field of colorFields) {
    const value = draft.colors?.[field.key];
    if (!config.colors?.includes(value)) throw fail(MESSAGES.colors);
    colors[field.key] = value;
  }
  const text = {};
  for (const field of textFields) {
    let value = cleanText(draft.text?.[field.key], field.max_length || 80);
    if (field.kind === 'initial') {
      if (!/^\p{L}$/u.test(value)) throw fail(MESSAGES.initial);
      value = value.toLocaleUpperCase('en-US');
    }
    if (field.kind === 'name' && !/^\p{L}[\p{L}\p{M}\s’'\-]*$/u.test(value)) throw fail(MESSAGES.name);
    text[field.key] = value;
  }
  let profiles;
  if (config.type === 'social') {
    const max = config.multiple_profiles ? 10 : 1;
    if (!Array.isArray(draft.profiles) || draft.profiles.length < 1 || draft.profiles.length > max) throw fail(MESSAGES.profiles);
    profiles = draft.profiles.map(profile => ({ network: cleanText(profile?.network, 80), handle: cleanText(profile?.handle, 120) }));
  }
  return {
    productId: product.id, name: product.name[language] || product.name.en, unitAmount: product.price_cents, quantity: item.quantity,
    colors, text, ...(design ? { designId: design.id } : {}), ...(profiles ? { profiles } : {}),
  };
}

export function validateCart(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items) || !input.items.length || input.items.length > MAX_LINES) throw fail(MESSAGES.items);
  if (!['ship', 'pickup'].includes(input.delivery)) throw fail(MESSAGES.delivery);
  if (!/^[a-f0-9-]{36}$/i.test(input.nonce || '')) throw fail(MESSAGES.refresh);
  const language = input.language === 'es' ? 'es' : 'en';
  const items = input.items.map(item => validateItem(item, language));
  const subtotal = items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const shipping = input.delivery === 'pickup' || subtotal >= FREE_SHIPPING_FROM_CENTS ? 0 : SHIPPING_CENTS;
  return { version: 1, language, delivery: input.delivery, items, subtotal, shipping, total: subtotal + shipping };
}

/** Human-readable personalization lines, e.g. ["Initial: E", "Name: Emma", "Initial color: Blue"]. */
export function itemDetails(item, lang = 'en') {
  const product = PRODUCTS.get(item.productId);
  const { config, design, colorFields, textFields } = productParts(product, item.designId);
  const label = (fields, key) => {
    const field = fields.find(f => f.key === key);
    return field?.label?.[lang] || field?.label?.en || key;
  };
  const lines = [];
  for (const [key, value] of Object.entries(item.text || {})) lines.push(`${label(textFields, key)}: ${value}`);
  if (design) lines.push(`${config.design_label?.[lang] || (lang === 'es' ? 'Diseño' : 'Design')}: ${design.label?.[lang] || design.id}`);
  for (const [key, value] of Object.entries(item.colors || {})) lines.push(`${label(colorFields, key)}: ${COLOR_NAMES[value]?.[lang] || value}`);
  for (const profile of item.profiles || []) lines.push(`${profile.network}: ${profile.handle}`);
  return lines;
}
const productNameIn = (item, lang) => PRODUCTS.get(item.productId)?.name?.[lang] || item.name;

/* ---------------------------------------------------------------- order snapshot in Stripe metadata */

async function encodeOrder(order) {
  const bytes = enc.encode(JSON.stringify(order));
  if (bytes.length > 30000) throw fail(MESSAGES.tooLarge);
  const compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary = '';
  for (const byte of compressed) binary += String.fromCharCode(byte);
  const value = btoa(binary);
  const chunks = Math.ceil(value.length / METADATA_CHUNK);
  if (chunks > MAX_METADATA_CHUNKS) throw fail(MESSAGES.tooLarge);
  const metadata = { format: ORDER_FORMAT, chunks: String(chunks) };
  for (let i = 0; i < chunks; i++) metadata['design_' + i] = value.slice(i * METADATA_CHUNK, (i + 1) * METADATA_CHUNK);
  return metadata;
}

export const isStoreSession = session => session?.metadata?.format === ORDER_FORMAT;

export async function decodeOrder(metadata) {
  if (metadata?.format !== ORDER_FORMAT || !/^\d{1,2}$/.test(metadata.chunks || '')) throw fail('Order details are unavailable.', 502);
  const count = Number(metadata.chunks);
  if (count < 1 || count > MAX_METADATA_CHUNKS) throw fail('Order details are invalid.', 502);
  const binary = atob(Array.from({ length: count }, (_, i) => metadata['design_' + i] || '').join(''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  if (text.length > 30000) throw fail('Order details are invalid.', 502);
  return JSON.parse(text);
}

/* ---------------------------------------------------------------- checkout session */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function shortReference(hexDigest) {
  let bits = BigInt('0x' + hexDigest.slice(0, 10));
  let out = '';
  for (let i = 0; i < 8; i++) { out = CROCKFORD[Number(bits & 31n)] + out; bits >>= 5n; }
  return 'YM-' + out;
}

function shippingLabel(order) {
  const es = order.language === 'es';
  if (order.delivery === 'pickup') return es ? 'Retiro sin cargo · Katy, TX' : 'Free pickup · Katy, TX';
  if (!order.shipping) return es ? 'Envío UPS gratis' : 'Free UPS shipping';
  return es ? 'Envío UPS' : 'UPS shipping';
}

function submitMessage(order) {
  const es = order.language === 'es';
  const base = es
    ? 'Cada pieza se fabrica a pedido en hasta 2 días hábiles. Los diseños personalizados no tienen devolución.'
    : 'Each piece is made to order in up to 2 business days. Personalized designs can’t be returned.';
  if (order.delivery !== 'pickup') return base;
  return base + (es ? ' Yuma te escribirá para coordinar el retiro en Katy, TX.' : ' Yuma will contact you to arrange pickup in Katy, TX.');
}

// JPEG thumbnails made for Stripe by tools/prepare-stripe-images.py. Stripe fetches them, so only on https.
function productImage(origin, item) {
  return origin.startsWith('https://') && PRODUCTS.has(item.productId) ? [`${origin}/assets/catalog/stripe/${item.productId}.jpg`] : undefined;
}

export async function createSession(input, origin, visitor, stripe, mode = 'test', options = {}) {
  const order = validateCart(input);
  const owner = await digest(visitor);
  const reference = shortReference(await digest(`${JSON.stringify(order)}|${owner}|${input.nonce}|${mode}`));
  const metadata = { ...(await encodeOrder(order)), owner, order_ref: reference };
  const taxBehavior = options.automaticTax ? { tax_behavior: 'exclusive' } : {};
  const request = {
    mode: 'payment',
    locale: order.language,
    success_url: `${origin}/checkout-result/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancelled#shop`,
    client_reference_id: reference,
    integration_identifier: 'yuma3d_storefront',
    metadata,
    line_items: order.items.map(item => ({
      quantity: item.quantity,
      price_data: {
        currency: 'usd',
        unit_amount: item.unitAmount,
        ...taxBehavior,
        product_data: {
          name: item.name,
          description: truncate(itemDetails(item, order.language).join(' · '), 500),
          images: productImage(origin, item),
          metadata: { product_id: item.productId },
        },
      },
    })),
    shipping_options: [{
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: order.shipping, currency: 'usd' },
        display_name: shippingLabel(order),
        ...(order.delivery === 'ship' ? { delivery_estimate: { minimum: { unit: 'business_day', value: 3 }, maximum: { unit: 'business_day', value: 7 } } } : {}),
        ...taxBehavior,
      },
    }],
    phone_number_collection: { enabled: true },
    payment_intent_data: { description: `Yuma 3D Studio · ${reference}`, metadata: { order_ref: reference } },
    custom_text: { submit: { message: submitMessage(order) } },
    automatic_tax: { enabled: Boolean(options.automaticTax) },
    ...(options.promotionCodes ? { allow_promotion_codes: true } : {}),
    ...(order.delivery === 'ship' ? { shipping_address_collection: { allowed_countries: ['US', 'PR'] } } : {}),
  };
  // Same request => same key => Stripe returns the same session instead of creating a duplicate.
  const send = async body => stripe.request('POST', '/checkout/sessions', body, 'yuma-checkout-' + await digest(JSON.stringify(body)));
  let session;
  try {
    session = await send(request);
  } catch (error) {
    // Product photos are a nice-to-have: if Stripe objects to an image, sell without photos instead of failing.
    if (error.stripe?.status !== 400 || !/images/.test(error.stripe?.param || '')) throw error;
    log('warn', 'checkout_images_rejected', { param: error.stripe.param });
    request.line_items.forEach(line => { delete line.price_data.product_data.images; });
    session = await send(request);
  }
  if (session.livemode !== (mode === 'live') || !new RegExp(`^cs_${mode}_[A-Za-z0-9]+$`).test(session.id || '') || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '')) {
    log('error', 'checkout_session_unverified', { livemode: session.livemode, mode });
    throw fail(MESSAGES.verify, 502);
  }
  return { url: session.url, id: session.id, total: order.total, reference };
}

/* ---------------------------------------------------------------- webhook */

function signatureBytes(value) {
  if (!/^[a-f0-9]{64}$/i.test(value)) return new Uint8Array();
  return Uint8Array.from(value.match(/../g), v => parseInt(v, 16));
}

export async function verifySignature(raw, header, secret, now = Date.now()) {
  if (!secret || !header) return false;
  const values = header.split(',').map(part => part.trim().split('='));
  const timestamp = values.find(part => part[0] === 't')?.[1];
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const pair of values.filter(part => part[0] === 'v1')) {
    if (await crypto.subtle.verify('HMAC', key, signatureBytes(pair[1] || ''), enc.encode(`${timestamp}.${raw}`))) return true;
  }
  return false;
}

/** Amounts we fixed when creating the session. Taxes and discounts may be added by Stripe on top. */
function amountIssues(session, order) {
  const issues = [];
  if (session.currency !== 'usd') issues.push(`currency ${session.currency}`);
  if (session.amount_subtotal !== order.subtotal) issues.push(`subtotal ${session.amount_subtotal} ≠ ${order.subtotal}`);
  const shipping = session.total_details?.amount_shipping ?? session.shipping_cost?.amount_subtotal;
  if (shipping !== order.shipping) issues.push(`shipping ${shipping} ≠ ${order.shipping}`);
  return issues;
}

async function updateMetadata(stripe, sessionId, values) {
  const idempotencyKey = 'yuma-meta-' + await digest(sessionId + JSON.stringify(values));
  await stripe.request('POST', `/checkout/sessions/${encodeURIComponent(sessionId)}`, { metadata: values }, idempotencyKey);
}

async function webhook(request, env) {
  const raw = await request.text();
  if (raw.length > 1024 * 1024) throw fail('Request too large.', 413);
  if (!await verifySignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET)) {
    log('warn', 'webhook_bad_signature');
    throw fail('Invalid webhook signature.', 400);
  }
  const event = JSON.parse(raw);
  const config = checkoutConfig(env);
  if (event.livemode !== (config.mode === 'live')) {
    log('error', 'webhook_wrong_mode', { event: event.id, livemode: event.livemode });
    throw fail('Unexpected payment mode.', 400);
  }
  if (!HANDLED_EVENTS.includes(event.type)) return json({ received: true });
  const sessionId = event.data?.object?.id || '';
  if (!new RegExp(`^cs_${config.mode}_[A-Za-z0-9]+$`).test(sessionId)) throw fail('Invalid checkout reference.', 400);
  const stripe = await checkedClient(env);
  const session = await stripe.request('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (session.livemode !== (config.mode === 'live')) throw fail('Unexpected payment mode.', 400);
  if (!isStoreSession(session)) {
    // A Payment Link or another integration in the same Stripe account. Not ours: acknowledge and ignore.
    log('info', 'webhook_ignored_foreign_session', { event: event.type });
    return json({ received: true, ignored: true });
  }
  if (event.type === 'checkout.session.async_payment_failed') {
    log('warn', 'payment_failed', { reference: session.metadata.order_ref });
    return json({ received: true, paid: false });
  }
  if (!['paid', 'no_payment_required'].includes(session.payment_status)) return json({ received: true, paid: false });
  await fulfill(session, env, config, stripe);
  return json({ received: true });
}

async function fulfill(session, env, config, stripe) {
  const order = await decodeOrder(session.metadata);
  const issues = amountIssues(session, order);
  if (issues.length) log('error', 'order_amount_mismatch', { reference: session.metadata.order_ref, issues });
  const metadata = session.metadata;
  if (metadata.shop_notified !== 'true' && metadata.notification_sent !== 'true') {
    const sent = await sendEmail(env, config, shopEmail(session, order, config, issues));
    // Yuma must always learn about a paid order: keep asking Stripe to retry until the email goes out.
    if (!sent.ok) throw fail('Order notification will be retried.', 503);
    await updateMetadata(stripe, session.id, { shop_notified: 'true', payment_verified: 'true' });
    log('info', 'order_notified', { reference: metadata.order_ref, mode: config.mode });
  }
  if (!config.buyerEmail || ['true', 'failed', 'skipped'].includes(metadata.buyer_notified)) return;
  if (!session.customer_details?.email) {
    await updateMetadata(stripe, session.id, { buyer_notified: 'skipped' });
    return;
  }
  const sent = await sendEmail(env, config, buyerEmail(session, order, config));
  if (sent.ok) await updateMetadata(stripe, session.id, { buyer_notified: 'true' });
  else if (sent.permanent) await updateMetadata(stripe, session.id, { buyer_notified: 'failed' });
  else throw fail('Buyer confirmation will be retried.', 503);
}

/* ---------------------------------------------------------------- emails */

async function sendEmail(env, config, message) {
  if (config.emailDelivery === 'log') {
    log('info', 'email_logged', { role: message.role, to: message.to, subject: message.subject, text: message.text });
    return { ok: true };
  }
  if (config.emailDelivery !== 'resend') return { ok: false, permanent: false };
  let response;
  try {
    response = await fetch(`${localOverride(env, 'RESEND_API_BASE', 'https://api.resend.com')}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ORDER_EMAIL_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': message.idempotencyKey },
      body: JSON.stringify({ from: env.ORDER_EMAIL_FROM, to: [message.to], subject: message.subject, text: message.text, html: message.html, ...(message.replyTo ? { reply_to: message.replyTo } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    log('error', 'email_network_error', { role: message.role, message: String(error?.message || error) });
    return { ok: false, permanent: false };
  }
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => null);
  log('error', 'email_failed', { role: message.role, status: response.status, name: body?.name, message: body?.message });
  return { ok: false, permanent: response.status >= 400 && response.status < 500 && response.status !== 429 };
}

function formatAddress(address) {
  if (!address) return '';
  return [address.line1, address.line2, [address.city, address.state, address.postal_code].filter(Boolean).join(', '), address.country].filter(Boolean).join(', ');
}

function totalsLines(session, order, lang) {
  const es = lang === 'es';
  const details = session.total_details || {};
  const lines = [[es ? 'Productos' : 'Items', money(session.amount_subtotal ?? order.subtotal)]];
  lines.push([order.delivery === 'pickup' ? (es ? 'Retiro en Katy, TX' : 'Pickup in Katy, TX') : (es ? 'Envío UPS' : 'UPS shipping'), (details.amount_shipping ?? order.shipping) ? money(details.amount_shipping ?? order.shipping) : (es ? 'Gratis' : 'Free')]);
  if (details.amount_discount) lines.push([es ? 'Descuento' : 'Discount', '−' + money(details.amount_discount)]);
  if (details.amount_tax) lines.push([es ? 'Impuestos' : 'Tax', money(details.amount_tax)]);
  lines.push([es ? 'Total cobrado' : 'Total paid', money(session.amount_total ?? order.total) + ' USD']);
  return lines;
}

function emailHtml(title, intro, sections) {
  const block = ({ heading, rows = [], paragraphs = [] }) => `
    <tr><td style="padding:18px 0 4px;font:600 15px Arial,sans-serif;color:#343b31">${escapeHtml(heading)}</td></tr>
    ${paragraphs.map(p => `<tr><td style="padding:2px 0;font:14px/1.5 Arial,sans-serif;color:#343b31">${escapeHtml(p)}</td></tr>`).join('')}
    ${rows.map(([a, b]) => `<tr><td style="padding:2px 0;font:14px/1.5 Arial,sans-serif;color:#343b31">${escapeHtml(a)}${b === undefined ? '' : `: <strong>${escapeHtml(b)}</strong>`}</td></tr>`).join('')}`;
  return `<!doctype html><html><body style="margin:0;background:#f6f1ea"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1ea;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fffdf8;border-radius:12px;padding:24px">
    <tr><td style="font:600 20px Arial,sans-serif;color:#343b31">${escapeHtml(title)}</td></tr>
    <tr><td style="padding-top:6px;font:14px/1.5 Arial,sans-serif;color:#5b6157">${escapeHtml(intro)}</td></tr>
    ${sections.map(block).join('')}
    </table></td></tr></table></body></html>`;
}
const emailText = (title, intro, sections) => [title, intro, ...sections.map(({ heading, rows = [], paragraphs = [] }) =>
  [heading.toUpperCase(), ...paragraphs, ...rows.map(([a, b]) => (b === undefined ? a : `${a}: ${b}`))].join('\n'))].join('\n\n');

function itemSections(order, lang) {
  const es = lang === 'es';
  return order.items.map((item, index) => ({
    heading: `${index + 1}. ${item.quantity} × ${productNameIn(item, lang)} — ${money(item.unitAmount * item.quantity)}`,
    rows: itemDetails(item, lang).map(line => {
      const at = line.indexOf(': ');
      return at > 0 ? [line.slice(0, at), line.slice(at + 2)] : [line, undefined];
    }).concat([[es ? 'Precio unitario' : 'Unit price', money(item.unitAmount)]]),
  }));
}

function shopEmail(session, order, config, issues) {
  const test = config.mode === 'test';
  const reference = session.metadata.order_ref;
  const customer = session.customer_details || {};
  const shipping = session.collected_information?.shipping_details || session.shipping_details;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  const title = `${test ? 'PEDIDO DE PRUEBA' : 'Nuevo pedido pagado'} ${reference}`;
  const intro = test
    ? 'Pago de prueba en el sandbox de Stripe. No se cobró dinero real: no fabricar.'
    : `Pago confirmado por Stripe. Total cobrado: ${money(session.amount_total)} USD.`;
  const sections = [];
  if (issues.length) sections.push({ heading: 'ATENCIÓN', paragraphs: ['Los montos no coinciden con el pedido original. Revisa el pago en Stripe antes de fabricar.', ...issues] });
  sections.push({
    heading: 'Cliente',
    rows: [
      ['Nombre', customer.name || shipping?.name || '—'],
      ['Email', customer.email || '—'],
      ['Teléfono', customer.phone || '—'],
      ['Idioma de la compra', order.language === 'es' ? 'Español' : 'Inglés'],
    ],
  });
  sections.push(order.delivery === 'pickup'
    ? { heading: 'Entrega', paragraphs: ['Retiro en Katy, TX 77449. Coordinar día y horario con el cliente.'] }
    : { heading: 'Entrega', rows: [['Envío UPS a', shipping?.name || customer.name || '—'], ['Dirección', formatAddress(shipping?.address) || '—']] });
  sections.push(...itemSections(order, 'es'));
  sections.push({ heading: 'Totales', rows: totalsLines(session, order, 'es') });
  sections.push({
    heading: 'Stripe',
    rows: [['Referencia', reference], ['Pago', paymentIntent || session.id]],
    paragraphs: [`https://dashboard.stripe.com/${test ? 'test/' : ''}payments/${paymentIntent || ''}`.replace(/\/$/, '')],
  });
  return {
    role: 'shop', to: SHOP_EMAIL, idempotencyKey: `yuma-shop-${session.id}`,
    replyTo: customer.email || undefined,
    subject: `${test ? '[PRUEBA] ' : ''}Pedido ${reference} · ${money(session.amount_total ?? order.total)} · ${order.delivery === 'pickup' ? 'Retiro' : 'Envío UPS'}`,
    text: emailText(title, intro, sections),
    html: emailHtml(title, intro, sections),
  };
}

function buyerEmail(session, order, config) {
  const lang = order.language === 'es' ? 'es' : 'en';
  const es = lang === 'es';
  const test = config.mode === 'test';
  const reference = session.metadata.order_ref;
  const shipping = session.collected_information?.shipping_details || session.shipping_details;
  const title = es ? `¡Gracias por tu pedido! ${reference}` : `Thank you for your order! ${reference}`;
  const intro = (test ? (es ? '[PRUEBA] Pago de prueba de Stripe, sin cobro real. ' : '[TEST] Stripe test payment, no real charge. ') : '')
    + (es ? 'Recibimos tu pago y Yuma ya tiene todos los detalles de tu diseño.' : 'We received your payment and Yuma has every detail of your design.');
  const sections = [
    ...itemSections(order, lang),
    { heading: es ? 'Totales' : 'Totals', rows: totalsLines(session, order, lang) },
    order.delivery === 'pickup'
      ? { heading: es ? 'Retiro' : 'Pickup', paragraphs: [es ? 'Yuma te escribirá para coordinar el retiro sin cargo en Katy, TX.' : 'Yuma will contact you to arrange your free pickup in Katy, TX.'] }
      : {
        heading: es ? 'Envío' : 'Shipping',
        paragraphs: [
          es ? 'Fabricamos cada pieza en hasta 2 días hábiles. UPS la entrega en 3 a 5 días hábiles y te enviaremos el número de seguimiento.' : 'We make each piece in up to 2 business days. UPS delivers in 3 to 5 business days, and we will send you the tracking number.',
          [shipping?.name, formatAddress(shipping?.address)].filter(Boolean).join(' — '),
        ].filter(Boolean),
      },
    {
      heading: es ? '¿Algo no está bien?' : 'Something not right?',
      paragraphs: [
        es ? 'Revisa la escritura de nombres y los colores. Si hay que corregir algo, responde este correo cuanto antes, antes de que empiece la fabricación.' : 'Please check the spelling of names and the colors. If anything needs a change, reply to this email as soon as possible, before production starts.',
        es ? `También puedes escribirnos por WhatsApp: ${SHOP_WHATSAPP}.` : `You can also message us on WhatsApp: ${SHOP_WHATSAPP}.`,
        es ? 'Los diseños personalizados no tienen devolución.' : 'Personalized designs can’t be returned.',
      ],
    },
  ];
  return {
    role: 'buyer', to: session.customer_details.email, idempotencyKey: `yuma-buyer-${session.id}`, replyTo: SHOP_EMAIL,
    subject: `${test ? (es ? '[PRUEBA] ' : '[TEST] ') : ''}${es ? 'Tu pedido de Yuma 3D Studio' : 'Your Yuma 3D Studio order'} ${reference}`,
    text: emailText(title, intro, sections),
    html: emailHtml(title, intro, sections),
  };
}

/* ---------------------------------------------------------------- API router */

function errorResponse(error) {
  const status = error.status || 500;
  const known = Boolean(error.status);
  return json({ error: known ? error.message : 'The request could not be completed.', error_es: known ? error.messageEs || error.message : 'No se pudo completar la solicitud.' }, status);
}

async function checkoutRequest(request, env, url, visitor) {
  if (request.headers.get('Origin') !== url.origin || !visitor) throw fail(MESSAGES.reload, 403);
  const config = checkoutConfig(env);
  if (!config.configured) throw fail(MESSAGES.disabled, 503);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw fail('Send a JSON request.', 415);
  if (env.CHECKOUT_LIMITER) {
    const key = 'checkout:' + (request.headers.get('CF-Connecting-IP') || visitor);
    const { success } = await env.CHECKOUT_LIMITER.limit({ key });
    if (!success) throw fail(MESSAGES.busy, 429);
  }
  const raw = await request.text();
  if (raw.length > 40000) throw fail(MESSAGES.tooLarge, 413);
  let input;
  try { input = JSON.parse(raw); } catch { throw fail('Invalid request.'); }
  validateCart(input); // Reject invalid bags before calling Stripe.
  const stripe = await checkedClient(env);
  const result = await createSession(input, url.origin, visitor, stripe, config.mode, config);
  log('info', 'checkout_created', { reference: result.reference, total: result.total, mode: config.mode });
  return json(result);
}

async function resultRequest(env, url, visitor) {
  const config = checkoutConfig(env);
  const id = url.searchParams.get('session_id');
  if (!new RegExp(`^cs_${config.mode}_[A-Za-z0-9]+$`).test(id || '')) throw fail(MESSAGES.reference);
  const stripe = await checkedClient(env);
  const session = await stripe.request('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
  if (session.livemode !== (config.mode === 'live') || !isStoreSession(session)) throw fail(MESSAGES.notFound, 404);
  const paid = ['paid', 'no_payment_required'].includes(session.payment_status);
  const base = { paid, mode: config.mode, status: session.status, reference: session.metadata.order_ref, total: session.amount_total, currency: session.currency };
  // The session id alone is not enough to see the personalization: it must be the browser that started the checkout.
  if (!visitor || session.metadata.owner !== await digest(visitor)) return json({ ...base, limited: true });
  const order = await decodeOrder(session.metadata);
  return json({
    ...base,
    delivery: order.delivery,
    language: order.language,
    email: session.customer_details?.email || null,
    subtotal: session.amount_subtotal,
    shipping: session.total_details?.amount_shipping ?? order.shipping,
    tax: session.total_details?.amount_tax || 0,
    discount: session.total_details?.amount_discount || 0,
    items: order.items.map(item => ({
      productId: item.productId,
      quantity: item.quantity,
      lineTotal: item.unitAmount * item.quantity,
      name: { en: productNameIn(item, 'en'), es: productNameIn(item, 'es') },
      details: { en: itemDetails(item, 'en'), es: itemDetails(item, 'es') },
    })),
  });
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const visitor = cookieValue(request);
  if (url.pathname === '/api/checkout/status' && request.method === 'GET') {
    const { configured, mode, webhookConfigured, emailConfigured } = checkoutConfig(env);
    return json({ configured, mode, webhookConfigured, emailConfigured }, 200, visitor ? {} : { 'Set-Cookie': newCookie(crypto.randomUUID(), url.protocol === 'https:') });
  }
  if (url.pathname === '/api/stripe/webhook' && request.method === 'POST') return webhook(request, env);
  if (url.pathname === '/api/checkout' && request.method === 'POST') return checkoutRequest(request, env, url, visitor);
  if (url.pathname === '/api/checkout/result' && request.method === 'GET') return resultRequest(env, url, visitor);
  return json({ error: 'Not found' }, 404);
}

/* ---------------------------------------------------------------- static files (single-file build only) */

function embeddedResponse(path, request) {
  const file = FILES?.[path];
  if (!file) return null;
  const headers = { 'Content-Type': file.type, 'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), { headers });
}

function serveEmbedded(request, url) {
  if (!['GET', 'HEAD'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
  const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  const exact = embeddedResponse(path, request);
  if (exact) return exact;
  if (FILES?.[url.pathname + '/index.html']) return Response.redirect(url.origin + url.pathname + '/', 308);
  return new Response(embeddedResponse('/404.html', request)?.body || 'Not found', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/** Entry point used by worker/index.js. */
export async function handleRequest(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, env);
    if (env.ASSETS) return await env.ASSETS.fetch(request);
    return serveEmbedded(request, url);
  } catch (error) {
    if (!error.status) log('error', 'unhandled_error', { path: url.pathname, message: String(error?.message || error) });
    return errorResponse(error);
  }
}
