import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSite } from '../scripts/build-site.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
function copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuma-build-'));
  for (const f of ['catalog-products.json', 'catalog-categories.json', 'site-settings.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'storefront'), path.join(dir, 'storefront'), { recursive: true });
  return dir;
}
const edit = (dir, fn) => { const file = path.join(dir, 'catalog-products.json'); fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8'))), null, 2)); };

test('build: hidden products get no page, card, sitemap entry or catalog data; text is escaped', () => {
  const dir = copy();
  edit(dir, products => products.map(p => (p.id === 'fitness-keychain' ? { ...p, hidden: true } : p.id === 'charms-keychain' ? { ...p, name: { ...p.name, en: 'Charms <script>alert(1)</script> & "co"' } } : p)));
  fs.mkdirSync(path.join(dir, 'storefront/products/old-product'), { recursive: true });
  const result = buildSite({ dir, origin: 'https://shop.example', log: () => {} });
  assert.deepEqual(result, { products: 16, hidden: 1, origin: 'https://shop.example' });
  assert.ok(!fs.existsSync(path.join(dir, 'storefront/products/fitness-keychain')));
  assert.ok(!fs.existsSync(path.join(dir, 'storefront/products/old-product')), 'stale pages removed');
  const index = fs.readFileSync(path.join(dir, 'storefront/index.html'), 'utf8');
  assert.ok(!index.includes('fitness-keychain'));
  assert.ok(!fs.readFileSync(path.join(dir, 'storefront/sitemap.xml'), 'utf8').includes('fitness-keychain'));
  assert.ok(!index.includes('<script>alert(1)'), 'name escaped in HTML');
  assert.ok(index.includes('Charms &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;co&quot;'));
  const data = JSON.parse(index.match(/<script id="catalog-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.length, 16);
  assert.ok(index.includes('<script id="category-data" type="application/json">'));
  assert.match(fs.readFileSync(path.join(dir, 'storefront/robots.txt'), 'utf8'), /Disallow: \/admin\//);
  // Building twice gives the same files (no growing blank lines).
  const page = path.join(dir, 'storefront/products/charms-keychain/index.html');
  const first = fs.readFileSync(page, 'utf8');
  buildSite({ dir, origin: 'https://shop.example', log: () => {} });
  assert.equal(fs.readFileSync(page, 'utf8'), first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build: refuses an invalid catalog (so a broken edit never reaches the store)', () => {
  const dir = copy();
  edit(dir, products => [{ ...products[0], price_cents: -5, images: ['assets/catalog/missing.webp'] }, ...products.slice(1)]);
  assert.throws(() => buildSite({ dir, origin: 'https://shop.example', log: () => {} }), /USD 0,50[\s\S]*no se encuentra la foto/);
  assert.throws(() => buildSite({ dir: copy(), origin: 'http://insecure.example', log: () => {} }), /https/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build on Vercel: the production domain becomes the canonical origin', () => {
  const dir = copy();
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'yuma3dstudio.com';
  try {
    assert.equal(buildSite({ dir, log: () => {} }).origin, 'https://yuma3dstudio.com');
    assert.match(fs.readFileSync(path.join(dir, 'storefront/products/initial-name/index.html'), 'utf8'), /<link rel="canonical" href="https:\/\/yuma3dstudio\.com\/products\/initial-name\/">/);
  } finally { delete process.env.VERCEL_PROJECT_PRODUCTION_URL; fs.rmSync(dir, { recursive: true, force: true }); }
});
