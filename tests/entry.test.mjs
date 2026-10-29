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
