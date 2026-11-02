import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// From Codex (2 Nov 2026), adapted: the single-file build is gone, so check the files Vercel serves.
const products = JSON.parse(readFileSync(new URL('../catalog-products.json', import.meta.url), 'utf8'));
const magic = bytes => (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') || (bytes[0] === 0xff && bytes[1] === 0xd8) || bytes.subarray(1, 4).toString() === 'PNG';

test('every catalog photo exists in storefront/ and is a real image; every buyable product has a Stripe thumbnail', () => {
  for (const path of new Set(products.flatMap(p => p.images))) {
    const file = new URL('../storefront/' + path, import.meta.url);
    assert.ok(existsSync(file), path);
    assert.ok(magic(readFileSync(file)), path);
  }
  for (const product of products.filter(p => p.price_cents !== null)) {
    assert.ok(existsSync(new URL(`../storefront/assets/catalog/stripe/${product.id}.jpg`, import.meta.url)), product.id);
  }
});
