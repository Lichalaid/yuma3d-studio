/*
 * Yuma 3D Studio — "puerta de atrás": API of the admin panel (storefront/admin/).
 *
 *   GET    /api/admin/session   Is the panel configured / is this browser logged in / which version is live.
 *   POST   /api/admin/session   Log in with the password  { password }.
 *   DELETE /api/admin/session   Log out.
 *   GET    /api/admin/catalog   Full catalog (hidden products included), categories and color palette.
 *   POST   /api/admin/catalog   One change: { op: 'upsert' | 'visibility' | 'delete' | 'reorder' | 'categories', ... }
 *
 * There is no database. Every change is ONE commit to the site's GitHub repository
 * (catalog-products.json, catalog-categories.json and the photos). Vercel deploys each commit,
 * so the store, the product pages, the SEO and the Stripe prices always come from the same file.
 *
 * Configuration (host environment variables, never in code):
 *   ADMIN_PASSWORD_HASH   created with `npm run admin:password`
 *   ADMIN_SESSION_SECRET  random, 32+ characters (the same command prints one)
 *   GITHUB_TOKEN          fine-grained token, only this repository, "Contents: Read and write"
 *   GITHUB_REPO           owner/name      GITHUB_BRANCH  optional, default "main"
 * Web-standard APIs only: runs on Vercel Functions (Node) and Cloudflare Workers.
 */
import { PALETTE, LIMITS, IMAGE_PATH, catalogErrors, slugify, discountPercent } from './catalog-rules.js';

const PRODUCTS_FILE = 'catalog-products.json';
const CATEGORIES_FILE = 'catalog-categories.json';
const SITE_DIR = 'storefront/';
const UPLOAD_DIR = 'assets/catalog/uploads/';
const STRIPE_DIR = 'assets/catalog/stripe/';
const COOKIE = 'yuma_admin';
const SESSION_HOURS = 12;
const MAX_BODY = 4_400_000; // Vercel Functions accept request bodies up to 4.5 MB.
const MAX_IMAGE_BYTES = 1_500_000;
const LOGIN_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const enc = new TextEncoder();

class AdminError extends Error {
  constructor(message, status = 400, details) { super(message); this.status = status; this.details = details; }
}
class Conflict extends Error {}

/* ---------------------------------------------------------------- helpers */

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function log(level, event, details = {}) {
  const line = JSON.stringify({ level, event, area: 'admin', ...details });
  if (level === 'error') console.error(line); else if (level === 'warn') console.warn(line); else console.log(line);
}

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), c => c.charCodeAt(0));


function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

/* ---------------------------------------------------------------- password and session */

const HASH_FORMAT = /^pbkdf2-sha256\.(\d{5,7})\.([A-Za-z0-9_-]{16,})\.([A-Za-z0-9_-]{43})$/;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** "pbkdf2-sha256.<iterations>.<salt>.<hash>" — printed by `npm run admin:password`. */
export async function hashPassword(password, iterations = 600000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256.${iterations}.${b64url(salt)}.${b64url(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  const match = HASH_FORMAT.exec(stored || '');
  if (!match || typeof password !== 'string' || !password || password.length > 200) return false;
  const derived = await pbkdf2(password, fromB64url(match[2]), Number(match[1]));
  return sameBytes(derived, fromB64url(match[3]));
}

export function adminConfig(env) {
  const passwordConfigured = HASH_FORMAT.test(env.ADMIN_PASSWORD_HASH || '');
  const secretConfigured = typeof env.ADMIN_SESSION_SECRET === 'string' && env.ADMIN_SESSION_SECRET.length >= 32;
  const storeConfigured = typeof env.ADMIN_STORE_IMPL === 'object' || (/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO || '') && /^(?:github_pat_|ghp_)[A-Za-z0-9_]+$/.test(env.GITHUB_TOKEN || ''));
  return { passwordConfigured, secretConfigured, storeConfigured, configured: passwordConfigured && secretConfigured && storeConfigured };
}

// Changing the password ends every open session.
const passwordFingerprint = env => (HASH_FORMAT.exec(env.ADMIN_PASSWORD_HASH || '')?.[3] || '').slice(0, 12);

async function createSession(env) {
  const expires = Date.now() + SESSION_HOURS * 3600 * 1000;
  const body = `v1.${expires}.${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return `${body}.${b64url(await hmac(env.ADMIN_SESSION_SECRET, body + '.' + passwordFingerprint(env)))}`;
}

async function validSession(request, env) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)yuma_admin=([A-Za-z0-9._-]{20,200})/)?.[1];
  if (!token || !adminConfig(env).configured) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !(Number(parts[1]) > Date.now())) return false;
  const body = parts.slice(0, 3).join('.');
  return sameBytes(fromB64url(parts[3]), await hmac(env.ADMIN_SESSION_SECRET, body + '.' + passwordFingerprint(env)));
}

function sessionCookie(value, secure, maxAge) {
  return `${COOKIE}=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Per-instance brake on password guessing (the password hash is also slow on purpose).
const failures = new Map();
const clientKey = request => (request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || request.headers.get('X-Real-IP') || request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);

function lockedUntil(key) {
  const entry = failures.get(key);
  return entry && entry.count >= LOGIN_FAILURES && entry.until > Date.now() ? entry.until : 0;
}
function registerFailure(key) {
  const entry = failures.get(key);
  const fresh = !entry || entry.until < Date.now();
  const next = { count: fresh ? 1 : entry.count + 1, until: Date.now() + LOCK_MS };
  failures.set(key, next);
  if (failures.size > 5000) failures.delete(failures.keys().next().value);
}

/* ---------------------------------------------------------------- GitHub storage */

function localOnly(value, fallback) {
  if (!value) return fallback;
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(value)) return value; // automated tests only
  throw new AdminError('Configuración inválida del panel.', 503);
}

export function githubStore(env, fetcher = (url, init) => fetch(url, init)) {
  const api = localOnly(env.GITHUB_API_BASE, 'https://api.github.com');
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  if (!/^[\w./-]{1,100}$/.test(branch)) throw new AdminError('GITHUB_BRANCH inválido.', 503);

  async function call(method, path, body, accept = 'application/vnd.github+json') {
    const response = await fetcher(`${api}/repos/${repo}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'yuma3d-admin', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.ok) return accept.includes('raw') ? response.text() : response.json();
    const detail = await response.text().catch(() => '');
    log('error', 'github_error', { method, path: path.replace(/\?.*$/, ''), status: response.status, detail: detail.slice(0, 300) });
    if (method === 'PATCH' && response.status === 422) throw new Conflict();
    if (response.status === 401) throw new AdminError('GitHub rechazó el token (GITHUB_TOKEN vencido o inválido).', 502);
    if (response.status === 403 || response.status === 404) throw new AdminError('El token de GitHub no tiene acceso al repositorio (revisa GITHUB_REPO y el permiso "Contents: Read and write").', 502);
    throw new AdminError('GitHub no respondió. Intenta de nuevo en un minuto.', 502);
  }

  return {
    async load() {
      const head = (await call('GET', `/git/ref/heads/${branch}`)).object.sha;
      const [products, categories, commit] = await Promise.all([
        call('GET', `/contents/${PRODUCTS_FILE}?ref=${head}`, null, 'application/vnd.github.raw+json'),
        call('GET', `/contents/${CATEGORIES_FILE}?ref=${head}`, null, 'application/vnd.github.raw+json'),
        call('GET', `/git/commits/${head}`),
      ]);
      const tree = await call('GET', `/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree.truncated) log('warn', 'github_tree_truncated');
      const files = new Set(tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(SITE_DIR)).map(entry => entry.path.slice(SITE_DIR.length)));
      return { version: head, products: JSON.parse(products), categories: JSON.parse(categories), files };
    },
    async commit({ parent, message, files }) {
      const base = await call('GET', `/git/commits/${parent}`);
      const tree = [];
      for (const [path, file] of Object.entries(files)) {
        if (file === null) tree.push({ path, mode: '100644', type: 'blob', sha: null });
        else if (file.text !== undefined) tree.push({ path, mode: '100644', type: 'blob', content: file.text });
        else tree.push({ path, mode: '100644', type: 'blob', sha: (await call('POST', '/git/blobs', { content: file.base64, encoding: 'base64' })).sha });
      }
      const newTree = await call('POST', '/git/trees', { base_tree: base.tree.sha, tree });
      const commit = await call('POST', '/git/commits', { message, tree: newTree.sha, parents: [parent] });
      await call('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
      return commit.sha;
    },
  };
}

const storeFor = env => (typeof env.ADMIN_STORE_IMPL === 'object' ? env.ADMIN_STORE_IMPL : githubStore(env));

/* ---------------------------------------------------------------- catalog changes */

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const str = (value, max = 2000) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '').slice(0, max);
const line = (value, max) => str(value, max * 2).replace(/\s+/g, ' ');

function bilingualInput(value, max) {
  const es = line(value?.es, max);
  const en = line(value?.en, max) || es; // English is optional: the Spanish text is used.
  return { en, es };
}

function paragraphs(text) {
  return str(text, 12000).split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

function sniffImage(bytes) {
  if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

function decodeUpload(upload) {
  if (!isObject(upload) || typeof upload.data !== 'string' || upload.data.length > MAX_IMAGE_BYTES * 1.4) throw new AdminError(`Cada foto puede pesar hasta ${MAX_IMAGE_BYTES / 1e6} MB.`, 413);
  let bytes;
  try { bytes = Uint8Array.from(atob(upload.data), c => c.charCodeAt(0)); } catch { throw new AdminError('Una de las fotos llegó dañada. Vuelve a elegirla.'); }
  const kind = sniffImage(bytes);
  if (!kind) throw new AdminError('Las fotos tienen que ser JPG, PNG o WebP.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new AdminError(`Cada foto puede pesar hasta ${MAX_IMAGE_BYTES / 1e6} MB.`, 413);
  return { kind, base64: upload.data };
}

const randomTag = () => b64url(crypto.getRandomValues(new Uint8Array(5))).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'img';

function uniqueId(base, products) {
  let id = base, n = 2;
  while (products.some(p => p.id === id)) id = `${base}-${n++}`;
  return id;
}

function fieldsInput(list, previous = [], prefix, { text = false } = {}) {
  if (!Array.isArray(list)) return previous;
  const rows = list.slice(0, text ? LIMITS.textFields : LIMITS.colorFields).map(raw => ({ raw, label: bilingualInput(raw?.label, 60) })).filter(row => row.label.es);
  // Keep the key of every part that already existed (carts and orders refer to it); new parts get a fresh one.
  const kept = new Set();
  for (const row of rows) {
    if (typeof row.raw?.key === 'string' && previous.some(f => f.key === row.raw.key) && !kept.has(row.raw.key)) { row.key = row.raw.key; kept.add(row.key); }
  }
  const taken = new Set([...kept, ...previous.map(f => f.key)]);
  let n = 1;
  return rows.map(({ raw, label, key }) => {
    if (!key && text && raw?.kind === 'name') key = ['name', 'second-name'].find(k => !taken.has(k)); // the store offers name fonts for these keys
    if (!key) { do key = `${prefix}-${n++}`; while (taken.has(key)); }
    taken.add(key);
    const field = { key, label };
    if (text) {
      const old = previous.find(f => f.key === key);
      const max = Number.isInteger(raw?.max_length) ? raw.max_length : old?.max_length;
      if (max) field.max_length = Math.min(Math.max(max, 1), LIMITS.textMax);
      const kind = ['name', 'initial'].includes(raw?.kind) ? raw.kind : raw?.kind === 'text' ? undefined : old?.kind;
      if (kind) field.kind = kind;
    }
    return field;
  });
}

/** Can the panel edit the parts of this product? (special products keep their code-defined options) */
export function partsEditable(product) {
  return !product || (product.personalization?.type === 'colors' && !product.personalization.design_options?.length);
}

function uploadsOnlyHere(path, products) {
  return path.startsWith(UPLOAD_DIR) && !products.some(p => p.images.includes(path));
}

/**
 * Applies one change to the catalog. Pure: returns the new catalog, the files to write in the
 * repository (path → {text} | {base64} | null to delete) and the commit message.
 */
export function applyChange(state, change) {
  if (!isObject(change)) throw new AdminError('Cambio inválido.');
  let products = structuredClone(state.products);
  let categories = structuredClone(state.categories);
  const files = {};
  let message;

  if (change.op === 'upsert') {
    const input = change.product;
    if (!isObject(input)) throw new AdminError('Faltan los datos del producto.');
    const existing = input.id ? products.find(p => p.id === input.id) : null;
    if (input.id && !existing) throw new AdminError('Ese producto ya no existe. Vuelve a cargar el panel.', 409);
    const name = bilingualInput(input.name, LIMITS.name);
    if (!name.es) throw new AdminError('Escribe el nombre del producto.');
    const id = existing ? existing.id : uniqueId(slugify(name.en || name.es), products);
    const description = { es: paragraphs(input.description?.es), en: [] };
    description.en = paragraphs(input.description?.en);
    if (!description.en.length) description.en = description.es.slice();
    if (!description.es.length) throw new AdminError('Escribe la descripción del producto.');
    let price = null;
    if (input.price_cents !== null) {
      if (!Number.isInteger(input.price_cents)) throw new AdminError('Escribe el precio o marca «Precio a consultar».');
      price = input.price_cents;
    }
    // Optional crossed-out price ("antes"); the sale badge percentage is computed from it.
    let compareAt = input.compare_at_cents === undefined ? existing?.compare_at_cents ?? null : input.compare_at_cents;
    if (price === null) compareAt = null;
    if (compareAt !== null && (!Number.isInteger(compareAt) || compareAt <= price)) throw new AdminError('El precio anterior (tachado) tiene que ser mayor que el precio de venta, o déjalo vacío.');
    const uploads = Array.isArray(change.uploads) ? change.uploads : [];
    if (uploads.length > LIMITS.images) throw new AdminError(`Puedes subir hasta ${LIMITS.images} fotos por producto.`);
    const decoded = uploads.map(decodeUpload);
    if (!Array.isArray(input.images)) throw new AdminError('Agrega al menos una foto.');
    const images = input.images.map(image => {
      if (typeof image === 'string') {
        const allowed = existing?.images.includes(image) || (IMAGE_PATH.test(image) && !image.includes('..') && state.files.has(image));
        if (!allowed) throw new AdminError('Una de las fotos ya no existe. Vuelve a cargar el panel.', 409);
        return image;
      }
      const upload = decoded[image?.upload];
      if (!upload) throw new AdminError('Falta una de las fotos nuevas.');
      if (upload.path) throw new AdminError('Hay una foto repetida.');
      upload.path = `${UPLOAD_DIR}${id}-${randomTag()}.${upload.kind}`;
      files[SITE_DIR + upload.path] = { base64: upload.base64 };
      return upload.path;
    });
    if (!images.length) throw new AdminError('Agrega al menos una foto.');

    const previous = existing?.personalization;
    const editable = partsEditable(existing);
    const plain = previous?.type === 'plain'; // sold as pictured: no colors or texts to choose
    const colors = Array.isArray(input.colors) ? PALETTE.map(c => c.id).filter(id => input.colors.includes(id)) : previous?.colors || [];
    const personalization = editable
      ? { ...(previous || {}), type: 'colors', colors, color_fields: fieldsInput(input.color_fields, previous?.color_fields || [], 'part'), component_mode: true }
      : plain ? previous : { ...previous, colors };
    if (editable) {
      const textFields = fieldsInput(input.text_fields, previous?.text_fields || [], 'text', { text: true });
      if (textFields.length) personalization.text_fields = textFields; else delete personalization.text_fields;
    }
    const product = {
      ...(existing || {}),
      id, category: typeof input.category === 'string' ? input.category : '', name, price_cents: price, currency: 'USD', images, description, personalization,
      production_mode: existing?.production_mode || 'made_to_order',
    };
    if (compareAt !== null) Object.assign(product, { compare_at_cents: compareAt, discount_percent: discountPercent(compareAt, price) });
    else { delete product.compare_at_cents; delete product.discount_percent; }
    if (input.hidden === true) product.hidden = true; else delete product.hidden;
    if (existing) products = products.map(p => (p.id === id ? product : p));
    else products = change.position === 'start' ? [product, ...products] : [...products, product];

    if (change.stripe_thumbnail) {
      const thumb = decodeUpload(change.stripe_thumbnail);
      if (thumb.kind !== 'jpg') throw new AdminError('La miniatura para Stripe tiene que ser JPG.');
      files[`${SITE_DIR}${STRIPE_DIR}${id}.jpg`] = { base64: thumb.base64 };
    }
    for (const old of existing?.images || []) if (uploadsOnlyHere(old, products)) files[SITE_DIR + old] = null;
    message = `Panel: ${existing ? 'edita' : 'crea'} «${name.es}»`;
  } else if (change.op === 'visibility') {
    const product = products.find(p => p.id === change.id);
    if (!product) throw new AdminError('Ese producto ya no existe. Vuelve a cargar el panel.', 409);
    if (change.hidden === true) product.hidden = true; else delete product.hidden;
    message = `Panel: ${change.hidden ? 'oculta' : 'muestra'} «${product.name.es}»`;
  } else if (change.op === 'delete') {
    const product = products.find(p => p.id === change.id);
    if (!product) throw new AdminError('Ese producto ya no existe. Vuelve a cargar el panel.', 409);
    products = products.filter(p => p.id !== change.id);
    for (const image of product.images) if (uploadsOnlyHere(image, products)) files[SITE_DIR + image] = null;
    if (state.files.has(`${STRIPE_DIR}${product.id}.jpg`)) files[`${SITE_DIR}${STRIPE_DIR}${product.id}.jpg`] = null;
    message = `Panel: borra «${product.name.es}»`;
  } else if (change.op === 'reorder') {
    const ids = change.ids;
    if (!Array.isArray(ids) || ids.length !== products.length || new Set(ids).size !== ids.length || !ids.every(id => products.some(p => p.id === id))) {
      throw new AdminError('El catálogo cambió mientras ordenabas. Vuelve a cargar el panel.', 409);
    }
    products = ids.map(id => products.find(p => p.id === id));
    message = 'Panel: cambia el orden del catálogo';
  } else if (change.op === 'categories') {
    if (!Array.isArray(change.categories)) throw new AdminError('Faltan las categorías.');
    const next = [];
    for (const raw of change.categories.slice(0, LIMITS.categories)) {
      const name = bilingualInput(raw?.name, LIMITS.categoryName);
      if (!name.es) throw new AdminError('Cada categoría necesita un nombre.');
      const known = typeof raw?.id === 'string' && categories.some(c => c.id === raw.id) ? raw.id : null;
      next.push({ id: known || uniqueId(slugify(name.en || name.es), [...categories, ...next]), name });
    }
    const missing = products.filter(p => !next.some(c => c.id === p.category));
    if (missing.length) throw new AdminError(`No puedes borrar una categoría con productos: mueve antes ${missing.slice(0, 3).map(p => `«${p.name.es}»`).join(', ')}${missing.length > 3 ? '…' : ''}.`);
    categories = next;
    message = 'Panel: actualiza las categorías';
  } else {
    throw new AdminError('Cambio desconocido.');
  }

  const newFiles = new Set(Object.entries(files).filter(([, f]) => f).map(([p]) => p.slice(SITE_DIR.length)));
  const errors = catalogErrors(products, categories, { imageExists: image => newFiles.has(image) || (state.files.has(image) && files[SITE_DIR + image] !== null) });
  if (errors.length) throw new AdminError(errors[0], 400, errors);
  files[PRODUCTS_FILE] = { text: JSON.stringify(products, null, 2) + '\n' };
  files[CATEGORIES_FILE] = { text: JSON.stringify(categories, null, 2) + '\n' };
  return { products, categories, files, message };
}

/* ---------------------------------------------------------------- router */

async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new AdminError('Formato inválido.', 415);
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new AdminError('Las fotos pesan demasiado juntas. Súbelas de a pocas.', 413);
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw new AdminError('Las fotos pesan demasiado juntas. Súbelas de a pocas.', 413);
  try { return JSON.parse(raw); } catch { throw new AdminError('Formato inválido.'); }
}

const liveVersion = env => (typeof env.ADMIN_STORE_IMPL?.liveVersion === 'function' ? env.ADMIN_STORE_IMPL.liveVersion() : env.VERCEL_GIT_COMMIT_SHA || null);

async function sessionRoute(request, env, url) {
  const config = adminConfig(env);
  if (request.method === 'GET') {
    return json({ configured: config.configured, missing: Object.entries({ ADMIN_PASSWORD_HASH: config.passwordConfigured, ADMIN_SESSION_SECRET: config.secretConfigured, 'GITHUB_TOKEN / GITHUB_REPO': config.storeConfigured }).filter(([, ok]) => !ok).map(([k]) => k), authenticated: await validSession(request, env), live: liveVersion(env) });
  }
  if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url.protocol === 'https:', 0) });
  if (request.method !== 'POST') throw new AdminError('Método no permitido.', 405);
  if (!config.configured) throw new AdminError('El panel todavía no está configurado.', 503);
  const key = clientKey(request);
  if (lockedUntil(key)) throw new AdminError('Demasiados intentos. Espera 15 minutos.', 429);
  const { password } = await readJson(request);
  if (!await verifyPassword(password, env.ADMIN_PASSWORD_HASH)) {
    registerFailure(key);
    log('warn', 'admin_login_failed', { client: key });
    await new Promise(resolve => setTimeout(resolve, 400));
    throw new AdminError('Contraseña incorrecta.', 401);
  }
  failures.delete(key);
  log('info', 'admin_login');
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(await createSession(env), url.protocol === 'https:', SESSION_HOURS * 3600) });
}

async function catalogRoute(request, env) {
  const store = storeFor(env);
  if (request.method === 'GET') {
    const state = await store.load();
    return json({ version: state.version, live: liveVersion(env), products: state.products, categories: state.categories, palette: PALETTE, limits: LIMITS });
  }
  if (request.method !== 'POST') throw new AdminError('Método no permitido.', 405);
  const change = await readJson(request);
  // If the repository moved while saving (another commit), the change is applied again on top of it.
  for (let attempt = 1; ; attempt++) {
    const state = await store.load();
    const result = applyChange(state, change);
    try {
      const version = await store.commit({ parent: state.version, message: result.message, files: result.files });
      log('info', 'admin_saved', { op: change.op, version, message: result.message });
      return json({ ok: true, version, live: liveVersion(env), message: result.message, products: result.products, categories: result.categories });
    } catch (error) {
      if (!(error instanceof Conflict) || attempt >= 3) throw error instanceof Conflict ? new AdminError('El repositorio cambió mientras guardabas. Intenta de nuevo.', 409) : error;
    }
  }
}

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  try {
    if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('Origin') !== url.origin) throw new AdminError('Vuelve a cargar el panel.', 403);
    if (url.pathname === '/api/admin/session') return await sessionRoute(request, env, url);
    if (url.pathname === '/api/admin/catalog') {
      if (!await validSession(request, env)) throw new AdminError('Tu sesión terminó. Vuelve a entrar.', 401);
      return await catalogRoute(request, env);
    }
    return json({ error: 'No encontrado.' }, 404);
  } catch (error) {
    if (error instanceof AdminError) return json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
    log('error', 'admin_unhandled', { path: url.pathname, message: String(error?.message || error) });
    return json({ error: 'No se pudo completar. Intenta de nuevo.' }, 500);
  }
}
