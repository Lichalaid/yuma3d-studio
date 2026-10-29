// Validates outgoing Stripe requests against Stripe's official OpenAPI spec (trimmed copy in
// tests/fixtures/stripe-openapi-checkout.json, taken from github.com/stripe/openapi).
import { readFileSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../fixtures/stripe-openapi-checkout.json', import.meta.url), 'utf8'));
export const SPEC_VERSION = spec.stripeApiVersionOfSpec;
export const CHECKOUT_SESSION_FIELDS = spec.checkoutSessionFields;

/** Parses Stripe's bracket form encoding (a[b][0][c]=v) back into nested objects and arrays. */
export function parseForm(body) {
  const root = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let node = root;
    keys.forEach((key, index) => {
      const last = index === keys.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(keys[index + 1]);
      if (last) node[key] = value;
      else node = node[key] ??= nextIsIndex ? [] : {};
    });
  }
  return root;
}

function check(schema, value, path, errors) {
  if (!schema) return;
  if (schema.anyOf) {
    const attempts = schema.anyOf.map(option => { const e = []; check(option, value, path, e); return e; });
    if (!attempts.some(e => !e.length)) errors.push(`${path}: does not match any allowed shape (${attempts.map(e => e[0]).join(' | ')})`);
    return;
  }
  if (schema.enum && !schema.enum.map(String).includes(String(value))) {
    errors.push(`${path}: "${value}" is not one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path}: expected object`); return; }
      const props = schema.properties || {};
      for (const [key, child] of Object.entries(value)) {
        if (key in props) check(props[key], child, `${path}.${key}`, errors);
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, child, `${path}.${key}`, errors);
        else errors.push(`${path}.${key}: unknown parameter (Stripe would reject it)`);
      }
      for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key}: required`);
      return;
    }
    case 'array':
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
      return;
    case 'string':
      if (typeof value !== 'string') { errors.push(`${path}: expected string`); return; }
      if (schema.maxLength && Array.from(value).length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      return;
    case 'integer':
      if (!/^-?\d+$/.test(String(value))) errors.push(`${path}: expected integer, got "${value}"`);
      return;
    case 'number':
      if (!/^-?\d+(\.\d+)?$/.test(String(value))) errors.push(`${path}: expected number`);
      return;
    case 'boolean':
      if (!['true', 'false'].includes(String(value))) errors.push(`${path}: expected boolean`);
      return;
    default:
  }
}

/** Returns a list of contract violations for one HTTP request sent to api.stripe.com. */
export function validateStripeRequest({ method, url, body, headers }) {
  const errors = [];
  const { pathname, searchParams } = new URL(url);
  const route = pathname.replace(/^\/v1/, '').replace(/^\/checkout\/sessions\/cs_(test|live)_[A-Za-z0-9]+(\/expire)?$/, (_, _mode, expire) => '/checkout/sessions/{session}' + (expire || ''));
  const operation = spec.operations[`${method} /v1${route}`];
  if (!operation) return [`${method} ${pathname}: not an operation this integration is expected to call`];
  if (!headers['Stripe-Version']) errors.push('missing Stripe-Version header');
  if (!/^Bearer (sk|rk)_(test|live)_/.test(headers.Authorization || '')) errors.push('missing or malformed Authorization header');
  if (method === 'POST') {
    if (headers['Content-Type'] !== 'application/x-www-form-urlencoded') errors.push('POST must be form encoded');
    if (!headers['Idempotency-Key']) errors.push('POST without Idempotency-Key cannot be retried safely');
    check(operation.requestBody, parseForm(body || ''), operation.operationId, errors);
  } else {
    for (const key of searchParams.keys()) {
      const base = key.split('[')[0];
      if (!operation.queryParams.includes(base)) errors.push(`${operation.operationId}: unknown query parameter ${key}`);
    }
  }
  return errors;
}
