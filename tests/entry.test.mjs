import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('the Worker entry module exports only the default handler (Cloudflare rejects other named exports)', async () => {
  const entry = await import('../worker/index.js');
  assert.deepEqual(Object.keys(entry), ['default']);
  assert.equal(typeof entry.default.fetch, 'function');
  const response = await entry.default.fetch(new Request('https://shop.example/api/checkout/status'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: false, mode: 'test', webhookConfigured: false, emailConfigured: false });
  const missing = await entry.default.fetch(new Request('https://shop.example/api/nope'), {});
  assert.equal(missing.status, 404);
});

test('Vercel adapter: rebuilds the https origin that Vercel\'s Node runtime loses (http://host)', async () => {
  const { vercelRequest, vercelHandler } = await import('../worker/vercel.js');
  // What @vercel/node hands to a web handler behind https: http:// + Host, with x-forwarded-* from the edge.
  const raw = new Request('http://yuma3dstudio.com/api/checkout?x=1', { method: 'POST', body: '{"a":1}', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'yuma3dstudio.com', Origin: 'https://yuma3dstudio.com', 'Content-Type': 'application/json' } });
  const fixed = await vercelRequest(raw);
  assert.equal(fixed.url, 'https://yuma3dstudio.com/api/checkout?x=1');
  assert.equal(fixed.method, 'POST');
  assert.equal(await fixed.text(), '{"a":1}');
  assert.equal(fixed.headers.get('Origin'), new URL(fixed.url).origin, 'checkout and admin origin checks pass');
  const local = new Request('http://localhost:3000/api/checkout/status');
  assert.equal(await vercelRequest(local), local, 'untouched without forwarded headers');
  const odd = await vercelRequest(new Request('http://a.com/x', { headers: { 'x-forwarded-host': 'evil.com/path', 'x-forwarded-proto': 'gopher' } }));
  assert.equal(odd.url, 'http://a.com/x', 'malformed forwarded values ignored');
  for (const file of ['checkout/index', 'checkout/status', 'checkout/result', 'stripe/webhook', 'admin/session', 'admin/catalog']) {
    const mod = await import(`../api/${file}.js`);
    assert.deepEqual(Object.keys(mod), ['default'], file);
    assert.equal(typeof mod.default.fetch, 'function', file);
  }
  const echo = vercelHandler(async request => Response.json({ url: request.url }));
  const response = await echo.fetch(new Request('http://shop.com/api/x', { headers: { 'x-forwarded-proto': 'https' } }));
  assert.equal((await response.json()).url, 'https://shop.com/api/x');
});
