import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { handleAdmin, hashPassword, verifyPassword, applyChange, githubStore, adminConfig } from '../worker/admin.js';
import { PALETTE, catalogErrors } from '../worker/catalog-rules.js';
import { createFakeGitHub } from './helpers/fake-github.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PRODUCTS = fs.readFileSync(ROOT + 'catalog-products.json', 'utf8');
const CATEGORIES = fs.readFileSync(ROOT + 'catalog-categories.json', 'utf8');
const ORIGIN = 'https://yuma.example';
const PASSWORD = 'una-clave-larga-123';
const HASH = await hashPassword(PASSWORD, 20000);
const SECRET = 'x'.repeat(40);
const WEBP = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'), Buffer.alloc(40, 1)]).toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]).toString('base64');

function repoFiles() {
  const files = { 'catalog-products.json': PRODUCTS, 'catalog-categories.json': CATEGORIES, 'storefront/index.html': '<html>' };
  for (const product of JSON.parse(PRODUCTS)) {
    for (const image of product.images) files['storefront/' + image] = 'img';
    files[`storefront/assets/catalog/stripe/${product.id}.jpg`] = 'jpg';
  }
  return files;
}
function setup(extra = {}) {
  const github = createFakeGitHub({ files: repoFiles() });
  const env = { ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET, GITHUB_REPO: github.repo, GITHUB_TOKEN: github.token, VERCEL_GIT_COMMIT_SHA: 'live123', ...extra };
  env.ADMIN_STORE_IMPL = githubStore(env, github.fetch);
  return { github, env };
}
const call = (env, path, { method = 'GET', body, cookie, origin = ORIGIN, ip = '1.1.1.1' } = {}) => handleAdmin(new Request(ORIGIN + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), 'X-Forwarded-For': ip },
}), env);
async function login(env, ip) {
  const response = await call(env, '/api/admin/session', { method: 'POST', body: { password: PASSWORD }, ip });
  assert.equal(response.status, 200);
  return response.headers.get('Set-Cookie').split(';')[0];
}
const newProduct = (over = {}) => ({
  name: { es: 'Llavero estrella', en: '' }, description: { es: 'Una estrella.\n\nHecha a pedido.', en: '' }, price_cents: 900,
  category: 'keychains', images: [{ upload: 0 }], colors: ['blue', 'pink'], color_fields: [{ label: { es: 'Estrella', en: 'Star' } }], text_fields: [], ...over,
});

test('passwords: PBKDF2 hash round-trip, wrong or malformed hashes fail', async () => {
  assert.match(HASH, /^pbkdf2-sha256\.20000\.[\w-]+\.[\w-]{43}$/);
  assert.equal(await verifyPassword(PASSWORD, HASH), true);
  assert.equal(await verifyPassword(PASSWORD + 'x', HASH), false);
  assert.equal(await verifyPassword(PASSWORD, 'plain-text'), false);
  assert.equal(await verifyPassword('', HASH), false);
  assert.notEqual(await hashPassword(PASSWORD, 20000), HASH, 'random salt');
});

test('configuration: the panel stays closed until every variable is valid', async () => {
  assert.equal(adminConfig({}).configured, false);
  assert.equal(adminConfig({ ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: 'short', GITHUB_REPO: 'a/b', GITHUB_TOKEN: 'github_pat_x' }).configured, false);
  assert.equal(adminConfig({ ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET, GITHUB_REPO: 'a/b', GITHUB_TOKEN: 'github_pat_x' }).configured, true);
  assert.equal(adminConfig({ ADMIN_PASSWORD_HASH: HASH, ADMIN_SESSION_SECRET: SECRET, ADMIN_STORE_IMPL: 'string-from-env', GITHUB_REPO: '', GITHUB_TOKEN: '' }).configured, false);
  const response = await call({}, '/api/admin/session');
  assert.deepEqual(await response.json(), { configured: false, missing: ['ADMIN_PASSWORD_HASH', 'ADMIN_SESSION_SECRET', 'GITHUB_TOKEN / GITHUB_REPO'], authenticated: false, live: null });
  assert.equal((await call({}, '/api/admin/session', { method: 'POST', body: { password: 'x' } })).status, 503);
});

test('login: signed HttpOnly cookie; catalog needs it; tampering, expiry of the password and logout end it', async () => {
  const { env } = setup();
  assert.equal((await call(env, '/api/admin/catalog')).status, 401);
  const bad = await call(env, '/api/admin/session', { method: 'POST', body: { password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'Contraseña incorrecta.');
  const response = await call(env, '/api/admin/session', { method: 'POST', body: { password: PASSWORD } });
  const cookieHeader = response.headers.get('Set-Cookie');
  assert.match(cookieHeader, /^yuma_admin=v1\.\d+\.[\w-]+\.[\w-]+; Path=\/api\/admin; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const cookie = cookieHeader.split(';')[0];
  assert.equal((await (await call(env, '/api/admin/session', { cookie })).json()).authenticated, true);
  const catalog = await call(env, '/api/admin/catalog', { cookie });
  assert.equal(catalog.status, 200);
  const data = await catalog.json();
  assert.equal(data.products.length, JSON.parse(PRODUCTS).length);
  assert.equal(data.live, 'live123');
  assert.deepEqual(data.palette, PALETTE);
  const forged = cookie.replace(/\.(\d+)\./, (_, t) => `.${Number(t) + 999999}.`);
  assert.equal((await call(env, '/api/admin/catalog', { cookie: forged })).status, 401, 'changed expiry breaks the signature');
  assert.equal((await call({ ...env, ADMIN_SESSION_SECRET: 'y'.repeat(40) }, '/api/admin/catalog', { cookie })).status, 401, 'other secret');
  assert.equal((await call({ ...env, ADMIN_PASSWORD_HASH: await hashPassword('otra-clave-nueva', 20000) }, '/api/admin/catalog', { cookie })).status, 401, 'new password closes sessions');
  const logout = await call(env, '/api/admin/session', { method: 'DELETE', cookie });
  assert.match(logout.headers.get('Set-Cookie'), /^yuma_admin=; .*Max-Age=0/);
});

test('login: 5 wrong passwords lock that client for 15 minutes; requests from other sites are refused', async () => {
  const { env } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await call(env, '/api/admin/session', { method: 'POST', body: { password: 'wrong' }, ip: '9.9.9.9' })).status, 401);
  const locked = await call(env, '/api/admin/session', { method: 'POST', body: { password: PASSWORD }, ip: '9.9.9.9' });
  assert.equal(locked.status, 429);
  assert.equal((await call(env, '/api/admin/session', { method: 'POST', body: { password: PASSWORD }, ip: '8.8.8.8' })).status, 200, 'other clients unaffected');
  const cookie = await login(env, '7.7.7.7');
  assert.equal((await call(env, '/api/admin/catalog', { method: 'POST', cookie, body: { op: 'reorder', ids: [] }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(env, '/api/admin/catalog', { method: 'POST', cookie, body: { op: 'reorder', ids: [] }, origin: null })).status, 403);
});

test('save = one GitHub commit with the catalog, the photo and the Stripe thumbnail', async () => {
  const { github, env } = setup();
  const cookie = await login(env, '2.2.2.2');
  const before = github.head();
  const response = await call(env, '/api/admin/catalog', { method: 'POST', cookie, body: { op: 'upsert', product: newProduct(), uploads: [{ data: WEBP }], stripe_thumbnail: { data: JPEG }, position: 'start' } });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.equal(result.version, github.head());
  assert.equal(result.message, 'Panel: crea «Llavero estrella»');
  const commit = github.commit(github.head());
  assert.deepEqual(commit.parents, [before]);
  const saved = JSON.parse(github.file('catalog-products.json'));
  const product = saved[0];
  assert.equal(product.id, 'llavero-estrella');
  assert.deepEqual(product.name, { es: 'Llavero estrella', en: 'Llavero estrella' });
  assert.deepEqual(product.description.en, ['Una estrella.', 'Hecha a pedido.']);
  assert.deepEqual(product.personalization, { type: 'colors', colors: ['blue', 'pink'], color_fields: [{ key: 'part-1', label: { en: 'Star', es: 'Estrella' } }], component_mode: true });
  assert.equal(product.production_mode, 'made_to_order');
  assert.match(product.images[0], /^assets\/catalog\/uploads\/llavero-estrella-[a-z0-9]+\.webp$/);
  assert.deepEqual(github.file('storefront/' + product.images[0]), Buffer.from(WEBP, 'base64'));
  assert.deepEqual(github.file('storefront/assets/catalog/stripe/llavero-estrella.jpg'), Buffer.from(JPEG, 'base64'));
  assert.equal(github.file('catalog-products.json').toString(), JSON.stringify(saved, null, 2) + '\n');
  assert.deepEqual(catalogErrors(saved, JSON.parse(github.file('catalog-categories.json'))), []);
  // Unchanged existing products keep every field (source, design options…).
  assert.deepEqual(saved.slice(1), JSON.parse(PRODUCTS));
  for (const r of github.requests) assert.equal(r.headers.authorization, `Bearer ${github.token}`);
});

test('if the repository moved while saving, the change is applied again on top (no lost commits)', async () => {
  const { github, env } = setup();
  const store = env.ADMIN_STORE_IMPL;
  let pushed = false;
  env.ADMIN_STORE_IMPL = {
    load: store.load,
    async commit(args) { if (!pushed) { pushed = true; github.pushExternal('README.md', 'code change'); } return store.commit(args); },
  };
  const cookie = await login(env, '3.3.3.3');
  const response = await call(env, '/api/admin/catalog', { method: 'POST', cookie, body: { op: 'visibility', id: 'fitness-keychain', hidden: true } });
  assert.equal(response.status, 200);
  assert.equal(github.file('README.md').toString(), 'code change', 'external commit kept');
  assert.equal(JSON.parse(github.file('catalog-products.json')).find(p => p.id === 'fitness-keychain').hidden, true);
  assert.equal(github.commit(github.head()).message, 'Panel: oculta «Llavero fitness»');
});

test('GitHub errors become clear messages (bad token, no access)', async () => {
  const { env } = setup({ GITHUB_TOKEN: 'github_pat_wrong' });
  env.ADMIN_STORE_IMPL = githubStore(env, createFakeGitHub({ files: repoFiles() }).fetch);
  const cookie = await login(env, '4.4.4.4');
  const response = await call(env, '/api/admin/catalog', { cookie });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /GITHUB_TOKEN vencido o inválido/);
  assert.throws(() => githubStore({ ...env, GITHUB_API_BASE: 'https://evil.example' }), /Configuración inválida/);
});

/* ---- applyChange: rules on every kind of change ---- */

const state = () => ({ version: 'v1', products: JSON.parse(PRODUCTS), categories: JSON.parse(CATEGORIES), files: new Set(Object.keys(repoFiles()).filter(p => p.startsWith('storefront/')).map(p => p.slice(11))) });

test('new products get a unique URL id; the English name drives it when present', () => {
  const s = state();
  assert.equal(applyChange(s, { op: 'upsert', product: newProduct({ name: { es: 'Llavero fitness', en: '' } }), uploads: [{ data: WEBP }] }).products.at(-1).id, 'llavero-fitness');
  assert.equal(applyChange(s, { op: 'upsert', product: newProduct({ name: { es: 'Llavero', en: 'Fitness keychain' } }), uploads: [{ data: WEBP }] }).products.at(-1).id, 'fitness-keychain-2');
});

test('rejects bad prices, empty names, missing photos, fake images and foreign paths', () => {
  const s = state();
  const err = change => { try { applyChange(s, change); return null; } catch (e) { return e.message; } };
  assert.match(err({ op: 'upsert', product: newProduct({ price_cents: 10 }), uploads: [{ data: WEBP }] }), /USD 0,50/);
  assert.match(err({ op: 'upsert', product: newProduct({ price_cents: 12.5 }), uploads: [{ data: WEBP }] }), /precio/);
  assert.match(err({ op: 'upsert', product: newProduct({ name: { es: '  ' } }), uploads: [{ data: WEBP }] }), /nombre/);
  assert.match(err({ op: 'upsert', product: newProduct({ images: [] }) }), /foto/);
  assert.match(err({ op: 'upsert', product: newProduct(), uploads: [{ data: Buffer.from('<svg onload=alert(1)>').toString('base64') }] }), /JPG, PNG o WebP/);
  assert.match(err({ op: 'upsert', product: newProduct({ images: ['assets/../../catalog-products.json'] }) }), /ya no existe/);
  assert.match(err({ op: 'upsert', product: newProduct({ images: ['assets/catalog/clean-v2/missing.webp'] }) }), /ya no existe/);
  assert.match(err({ op: 'upsert', product: newProduct({ category: 'nope' }), uploads: [{ data: WEBP }] }), /categoría existente/);
  assert.match(err({ op: 'upsert', product: newProduct({ colors: [] }), uploads: [{ data: WEBP }] }), /al menos un color/);
  assert.match(err({ op: 'upsert', product: { ...newProduct(), id: 'ghost' }, uploads: [{ data: WEBP }] }), /ya no existe/);
  assert.match(err({ op: 'upsert', product: newProduct(), uploads: [{ data: WEBP }], stripe_thumbnail: { data: WEBP } }), /JPG/);
  assert.match(err({ op: 'nuke' }), /desconocido/);
  // Unknown colors are dropped, not stored.
  assert.deepEqual(applyChange(s, { op: 'upsert', product: newProduct({ colors: ['blue', 'gold', '<b>'] }), uploads: [{ data: WEBP }] }).products.at(-1).personalization.colors, ['blue']);
});

test('editing a special product only changes its basic data; its options stay as coded', () => {
  const s = state();
  const before = s.products.find(p => p.id === 'initial-name');
  const result = applyChange(s, { op: 'upsert', product: { id: 'initial-name', name: { es: 'Inicial', en: 'Initial' }, description: { es: 'Texto', en: 'Text' }, price_cents: 3800, category: 'names', images: before.images, colors: ['blue', 'white'], color_fields: [], text_fields: [] } });
  const after = result.products.find(p => p.id === 'initial-name');
  assert.equal(after.price_cents, 3800);
  assert.deepEqual(after.personalization, { ...before.personalization, colors: ['blue', 'white'] });
  assert.deepEqual(after.source, before.source);
  assert.equal(result.message, 'Panel: edita «Inicial»');
});

test('editing parts keeps existing keys (orders refer to them) and numbers the new ones', () => {
  const s = state();
  const keychain = s.products.find(p => p.id === 'fitness-keychain');
  const result = applyChange(s, { op: 'upsert', product: {
    id: keychain.id, name: keychain.name, description: { es: keychain.description.es.join('\n\n'), en: keychain.description.en.join('\n\n') }, price_cents: 800, category: 'keychains', images: keychain.images, colors: keychain.personalization.colors,
    color_fields: [{ key: 'detailColor', label: { es: 'Pesa', en: 'Kettlebell' } }, { label: { es: 'Argolla', en: '' } }, { key: 'invented', label: { es: 'Otra', en: '' } }],
    text_fields: [{ label: { es: 'Iniciales', en: 'Initials' }, max_length: 99, kind: 'text' }],
  } });
  const config = result.products.find(p => p.id === 'fitness-keychain').personalization;
  assert.deepEqual(config.color_fields.map(f => f.key), ['detailColor', 'part-1', 'part-2']);
  assert.deepEqual(config.text_fields, [{ key: 'text-1', label: { en: 'Initials', es: 'Iniciales' }, max_length: 40 }]);
  assert.deepEqual(result.products.find(p => p.id === 'fitness-keychain').description, keychain.description);
});

test('delete removes only the photos uploaded for that product; originals are never deleted', () => {
  const s = state();
  const created = applyChange(s, { op: 'upsert', product: newProduct(), uploads: [{ data: WEBP }], stripe_thumbnail: { data: JPEG } });
  const product = created.products.at(-1);
  const s2 = { ...s, products: created.products, files: new Set([...s.files, product.images[0], `assets/catalog/stripe/${product.id}.jpg`]) };
  const removed = applyChange(s2, { op: 'delete', id: product.id });
  assert.equal(removed.files['storefront/' + product.images[0]], null);
  assert.equal(removed.files[`storefront/assets/catalog/stripe/${product.id}.jpg`], null);
  const original = applyChange(s, { op: 'delete', id: 'fitness-keychain' });
  assert.ok(!Object.keys(original.files).some(path => path.includes('clean-v2')), 'catalog originals kept');
  // A replaced uploaded photo is deleted with the edit.
  const edit = applyChange(s2, { op: 'upsert', product: { ...newProduct(), id: product.id, images: [{ upload: 0 }] }, uploads: [{ data: WEBP }] });
  assert.equal(edit.files['storefront/' + product.images[0]], null);
});

test('categories: rename, add, and a category with products cannot be removed; reorder must keep every product', () => {
  const s = state();
  const result = applyChange(s, { op: 'categories', categories: [...s.categories.map(c => ({ id: c.id, name: c.name })), { name: { es: 'Decoración', en: '' } }] });
  assert.deepEqual(result.categories.at(-1), { id: 'decoracion', name: { en: 'Decoración', es: 'Decoración' } });
  assert.throws(() => applyChange(s, { op: 'categories', categories: s.categories.slice(1) }), /No puedes borrar una categoría con productos/);
  assert.throws(() => applyChange(s, { op: 'reorder', ids: s.products.slice(1).map(p => p.id) }), /cambió/);
  const ids = s.products.map(p => p.id).reverse();
  assert.deepEqual(applyChange(s, { op: 'reorder', ids }).products.map(p => p.id), ids);
});

test('the palette matches the storefront and the checkout', () => {
  const app = fs.readFileSync(ROOT + 'storefront/app.js', 'utf8');
  const checkout = fs.readFileSync(ROOT + 'worker/checkout.js', 'utf8');
  for (const color of PALETTE) {
    assert.ok(app.includes(`{id:'${color.id}',en:'${color.en}',es:'${color.es}',hex:'${color.hex}'`), `app.js ${color.id}`);
    assert.ok(checkout.includes(`${color.id}: { en: '${color.en}', es: '${color.es}' }`), `checkout.js ${color.id}`);
  }
});
