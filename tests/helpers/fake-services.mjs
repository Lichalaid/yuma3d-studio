// In-memory stand-ins for api.stripe.com and api.resend.com used by the tests.
// Every Stripe request is checked against Stripe's OpenAPI spec and Stripe's metadata limits,
// and rejected the way Stripe would reject it.
import { createServer } from 'node:http';
import { parseForm, validateStripeRequest } from './stripe-contract.mjs';

const json = (status, body, extra = {}) => ({ status, body, headers: { 'Request-Id': 'req_fake_' + Math.random().toString(36).slice(2, 10), ...extra } });
const stripeError = (status, type, message, extra = {}) => json(status, { error: { type, message, ...extra } });
const randomId = () => Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');

function metadataProblem(metadata) {
  const entries = Object.entries(metadata || {});
  if (entries.length > 50) return `metadata has ${entries.length} keys (max 50)`;
  for (const [key, value] of entries) {
    if (key.length > 40) return `metadata key ${key} longer than 40`;
    if (String(value).length > 500) return `metadata ${key} longer than 500 characters`;
  }
  return null;
}

export function createFakeStripe({ accountId = 'acct_1UVZa22S141stGeG', livemode = false } = {}) {
  const sessions = new Map();
  const idempotency = new Map();
  const requests = [];
  const contractErrors = [];
  const emails = [];
  const emailKeys = new Map();
  const failures = { stripe: [], resend: [] }; // queued forced responses
  const mode = livemode ? 'live' : 'test';

  function createSession(params) {
    const id = `cs_${mode}_${randomId()}`;
    const lineItems = params.line_items || [];
    const subtotal = lineItems.reduce((sum, li) => sum + Number(li.price_data.unit_amount) * Number(li.quantity), 0);
    const shipping = Number(params.shipping_options?.[0]?.shipping_rate_data?.fixed_amount?.amount || 0);
    const session = {
      id, object: 'checkout.session', livemode, mode: params.mode, status: 'open', payment_status: 'unpaid',
      url: `https://checkout.stripe.com/c/pay/${id}`, currency: 'usd', locale: params.locale,
      amount_subtotal: subtotal, amount_total: subtotal + shipping,
      total_details: { amount_discount: 0, amount_shipping: shipping, amount_tax: 0 },
      metadata: { ...(params.metadata || {}) }, client_reference_id: params.client_reference_id,
      success_url: params.success_url, cancel_url: params.cancel_url,
      shipping_address_collection: params.shipping_address_collection || null,
      customer_details: null, collected_information: null, payment_intent: null,
      _params: params,
    };
    sessions.set(id, session);
    return session;
  }

  const publicSession = session => { const { _params, ...rest } = session; return structuredClone(rest); };

  function handleStripe(method, url, headers, body) {
    requests.push({ method, url, headers, body });
    if (failures.stripe.length) return failures.stripe.shift();
    const errors = validateStripeRequest({ method, url, body, headers });
    if (errors.length) { contractErrors.push(...errors); return stripeError(400, 'invalid_request_error', errors[0]); }
    const { pathname } = new URL(url);
    if (method === 'GET' && pathname === '/v1/account') return json(200, { id: accountId, object: 'account', charges_enabled: true });
    const params = method === 'POST' ? parseForm(body) : {};
    if (method === 'POST' && pathname === '/v1/checkout/sessions') {
      const key = headers['Idempotency-Key'];
      const previous = idempotency.get(key);
      if (previous) return previous.body === body ? previous.response : stripeError(400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.');
      const problem = metadataProblem(params.metadata);
      if (problem) return stripeError(400, 'invalid_request_error', problem);
      const response = json(200, publicSession(createSession(params)));
      idempotency.set(key, { body, response });
      return response;
    }
    const match = pathname.match(/^\/v1\/checkout\/sessions\/(cs_[a-z]+_[A-Za-z0-9]+)(\/expire)?$/);
    if (match) {
      const session = sessions.get(match[1]);
      if (!session) return stripeError(404, 'invalid_request_error', 'No such checkout.session', { code: 'resource_missing' });
      if (match[2]) {
        if (session.status !== 'open') return stripeError(400, 'invalid_request_error', 'Only open sessions can be expired.');
        session.status = 'expired';
        return json(200, publicSession(session));
      }
      if (method === 'GET') return json(200, publicSession(session));
      const merged = { ...session.metadata };
      for (const [k, v] of Object.entries(params.metadata || {})) { if (v === '') delete merged[k]; else merged[k] = v; }
      const problem = metadataProblem(merged);
      if (problem) return stripeError(400, 'invalid_request_error', problem);
      session.metadata = merged;
      return json(200, publicSession(session));
    }
    return stripeError(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${pathname})`);
  }

  function handleResend(headers, body) {
    if (failures.resend.length) return failures.resend.shift();
    const payload = JSON.parse(body);
    const key = headers['Idempotency-Key'];
    if (key && emailKeys.has(key)) return json(200, { id: emailKeys.get(key) });
    if (!payload.from || !Array.isArray(payload.to) || !payload.subject || !(payload.text || payload.html)) return json(422, { name: 'validation_error', message: 'Missing fields' });
    const id = 'email_' + randomId();
    if (key) emailKeys.set(key, id);
    emails.push({ id, headers, ...payload });
    return json(200, { id });
  }

  function route(method, url, headers, body) {
    if (/^https?:\/\/[^/]+\/emails$/.test(url) && method === 'POST') return handleResend(headers, body);
    return handleStripe(method, url, headers, body);
  }

  /** fetch-compatible function for in-process tests. */
  async function transport(url, init = {}) {
    const result = route(init.method || 'GET', String(url), init.headers || {}, init.body || '');
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json', ...result.headers } });
  }

  /** Simulates the buyer finishing Stripe Checkout. */
  function complete(id, { email = 'buyer@example.com', name = 'Ana Pérez', phone = '+18325550100', paymentStatus = 'paid', tax = 0, discount = 0 } = {}) {
    const session = sessions.get(id);
    if (!session) throw new Error('unknown session ' + id);
    const address = { line1: '123 Main St', line2: null, city: 'Katy', state: 'TX', postal_code: '77449', country: 'US' };
    session.status = 'complete';
    session.payment_status = paymentStatus;
    session.payment_intent = 'pi_' + randomId();
    session.customer_details = { email, name, phone, address };
    session.collected_information = session.shipping_address_collection ? { shipping_details: { name, address } } : null;
    session.total_details = { ...session.total_details, amount_tax: tax, amount_discount: discount };
    session.amount_total = session.amount_subtotal + session.total_details.amount_shipping + tax - discount;
    return publicSession(session);
  }

  function event(id, type = 'checkout.session.completed') {
    return { id: 'evt_' + randomId(), object: 'event', type, livemode, api_version: '2026-09-30.endive', created: Math.floor(Date.now() / 1000), data: { object: publicSession(sessions.get(id)) } };
  }

  return { transport, route, sessions, requests, contractErrors, emails, failures, complete, event, createSession };
}

/** Serves a fake over HTTP so a real Worker (wrangler dev) can reach it through STRIPE_API_BASE / RESEND_API_BASE. */
export async function serveFake(fake, port) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase())] = v;
      const result = fake.route(req.method, `http://127.0.0.1:${port}${req.url}`, headers, Buffer.concat(chunks).toString());
      res.writeHead(result.status, { 'Content-Type': 'application/json', ...result.headers });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}
