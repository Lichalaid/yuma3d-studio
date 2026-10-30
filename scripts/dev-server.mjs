#!/usr/bin/env node
/*
 * Local server that behaves like the Vercel deployment: storefront/ as static files and every
 * route under api/ as a function (same files, same Node runtime). Run: npm run dev
 *
 * Variables come from .env.local (ignored by git) or the shell; see .env.example.
 * The admin panel works without GitHub: if GITHUB_TOKEN is not set, saves are written to this
 * folder and the site is rebuilt, as a deploy would. Without ADMIN_PASSWORD_HASH it uses the
 * local password printed at start-up (only here, never on the published site).
 *
 *   --port 3000    --root <folder>   (the E2E tests run it on a copy of the project)
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite } from './build-site.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const root = path.resolve(args.root || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const port = Number(args.port || process.env.PORT || 3000);
const quiet = process.env.DEV_SERVER_QUIET === '1';
const say = (...m) => { if (!quiet) console.log(...m); };

if (process.env.VERCEL) throw new Error('dev-server is for local use only.');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !raw.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const env = { ...readEnvFile(path.join(root, '.env.local')), ...process.env };

/* ---- each local save is a new "deployment": rebuild the site and load the code fresh, like Vercel */
const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuma-dev-'));
let current, deployCount = 0;
const catalogVersion = () => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, 'catalog-products.json'))).update(fs.readFileSync(path.join(root, 'catalog-categories.json')))
  .digest('hex').slice(0, 12);

async function deploy() {
  buildSite({ dir: root, log: say });
  const target = path.join(deployDir, String(++deployCount));
  fs.cpSync(path.join(root, 'worker'), path.join(target, 'worker'), { recursive: true });
  for (const file of ['catalog-products.json', 'catalog-categories.json']) fs.copyFileSync(path.join(root, file), path.join(target, file));
  const [checkout, admin, vercel] = await Promise.all([
    import(pathToFileURL(path.join(target, 'worker/checkout.js')).href),
    import(pathToFileURL(path.join(target, 'worker/admin.js')).href),
    import(pathToFileURL(path.join(target, 'worker/vercel.js')).href),
  ]);
  current = { checkout, admin, vercel, version: catalogVersion() };
  if (deployCount > 1) say(`Sitio republicado (versión ${current.version}).`);
}

/* ---- admin storage: GitHub when configured, otherwise this folder */
function walk(dir, base = dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out); else out.add(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
const localStore = {
  async load() {
    const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    return { version: catalogVersion(), products: read('catalog-products.json'), categories: read('catalog-categories.json'), files: walk(path.join(root, 'storefront')) };
  },
  async commit({ message, files }) {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(root, file);
      if (!full.startsWith(root + path.sep)) throw new Error('Invalid path');
      if (content === null) fs.rmSync(full, { force: true });
      else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content.text !== undefined ? content.text : Buffer.from(content.base64, 'base64')); }
    }
    say(`Guardado: ${message}`);
    setTimeout(() => deploy().catch(error => console.error('Rebuild failed:', error.message)), 300);
    return catalogVersion();
  },
  liveVersion: () => current.version,
};

const adminEnv = { ...env };
const useGitHub = env.ADMIN_STORE !== 'local' && Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO);
if (!useGitHub) adminEnv.ADMIN_STORE_IMPL = localStore;
let localPassword;
if (!env.ADMIN_PASSWORD_HASH) {
  localPassword = env.ADMIN_LOCAL_PASSWORD || 'yuma-local-' + crypto.randomBytes(3).toString('hex');
  const { hashPassword } = await import(pathToFileURL(path.join(root, 'worker/admin.js')).href);
  adminEnv.ADMIN_PASSWORD_HASH = await hashPassword(localPassword, 100000);
}
if (!env.ADMIN_SESSION_SECRET) adminEnv.ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString('hex');

/* ---- HTTP: same routing as Vercel (api/<path>.js or api/<path>/index.js, the rest is static) */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };
const functionExists = pathname => !pathname.includes('..') && [`${pathname.slice(1)}.js`, `${pathname.slice(1)}/index.js`].some(f => fs.existsSync(path.join(root, f)));

async function toWebRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('x-forwarded-for', req.socket.remoteAddress || '127.0.0.1');
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
}

async function sendWeb(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sendStatic(req, res, pathname) {
  let file = path.join(root, 'storefront', decodeURIComponent(pathname));
  if (!file.startsWith(path.join(root, 'storefront'))) { res.writeHead(400); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!pathname.endsWith('/')) { res.writeHead(308, { Location: pathname + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  const found = fs.existsSync(file) && fs.statSync(file).isFile();
  const target = found ? file : path.join(root, 'storefront/404.html');
  res.writeHead(found ? 200 : 404, { 'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(target));
}

await deploy();
const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://local');
    if (pathname.startsWith('/api/')) {
      if (!functionExists(pathname)) return sendWeb(res, Response.json({ error: 'Not found' }, { status: 404 }));
      const request = await current.vercel.vercelRequest(await toWebRequest(req)); // same adapter as api/*.js
      const response = pathname.startsWith('/api/admin/') ? await current.admin.handleAdmin(request, adminEnv) : await current.checkout.handleRequest(request, env);
      return sendWeb(res, response);
    }
    sendStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    res.writeHead(500); res.end('Internal error');
  }
});
server.listen(port, '127.0.0.1', () => {
  say(`\nTienda:  http://localhost:${port}\nPanel:   http://localhost:${port}/admin/`);
  if (localPassword) say(`Contraseña local del panel: ${localPassword}  (solo en tu compu; en Vercel se usa ADMIN_PASSWORD_HASH)`);
  say(useGitHub ? 'El panel guarda en GitHub (GITHUB_REPO); la tienda local no cambia hasta hacer git pull.' : 'El panel guarda en esta carpeta y regenera el sitio al instante.');
  if (process.send) process.send({ ready: true, port, password: localPassword });
});
const stop = () => { server.close(); fs.rmSync(deployDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
