#!/usr/bin/env node
/*
 * Builds the store from the catalog files. Runs on every deploy (Vercel: vercel.json → buildCommand)
 * and locally with `npm run build:site`. Only needs Node.
 *
 *   catalog-products.json    products (the admin panel edits this file)
 *   catalog-categories.json  categories (also edited from the panel)
 *   site-settings.json       public origin and credits
 *
 * Writes into storefront/: the catalog embedded in index.html, the category filters,
 * one page per visible product at /products/<id>/, SEO metadata, sitemap.xml, robots.txt and 404.html.
 * Replaces tools/build-product-pages.py + tools/prepare-seo.py (same output, no Python needed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogErrors, visibleProducts } from '../worker/catalog-rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildSite({ dir = root, origin: originOverride, log = console.log } = {}) {
  const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const settings = read('site-settings.json');
  const allProducts = read('catalog-products.json');
  const categories = read('catalog-categories.json');
  const storefront = path.join(dir, 'storefront');

  const errors = catalogErrors(allProducts, categories, { imageExists: image => fs.existsSync(path.join(storefront, image)) });
  if (errors.length) throw new Error('El catálogo tiene errores:\n- ' + errors.join('\n- '));

  const origin = siteOrigin(settings, originOverride);
  const products = visibleProducts(allProducts);
  const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));

  /* 1. Catalog data, category data and filters inside index.html */
  const indexPath = path.join(storefront, 'index.html');
  let index = fs.readFileSync(indexPath, 'utf8');
  index = replaceOnce(index, /<script id="catalog-data" type="application\/json">[\s\S]*?<\/script>/,
    '<script id="catalog-data" type="application/json">' + pyJson(products).replace(/</g, '\\u003c') + '</script>', 'catalog-data');
  const categoryData = '<script id="category-data" type="application/json">' + pyJson(categories).replace(/</g, '\\u003c') + '</script>';
  index = /<script id="category-data"/.test(index)
    ? index.replace(/<script id="category-data" type="application\/json">[\s\S]*?<\/script>/, () => categoryData)
    : index.replace(/(<script id="catalog-data"[\s\S]*?<\/script>)/, (_, data) => data + categoryData);
  const used = categories.filter(c => products.some(p => p.category === c.id));
  const filters = '<div class="catalog-filters" aria-label="Product categories"><button data-filter="all" aria-pressed="true" data-en="All" data-es="Todos">All</button>'
    + used.map(c => `<button data-filter="${esc(c.id)}" aria-pressed="false" data-en="${esc(c.name.en)}" data-es="${esc(c.name.es)}">${esc(c.name.en)}</button>`).join('') + '</div>';
  index = replaceOnce(index, /<div class="catalog-filters" aria-label="Product categories">[\s\S]*?<\/div>/, filters, 'catalog-filters');
  fs.writeFileSync(indexPath, index);

  /* 2. One page per visible product; pages of removed or hidden products are deleted */
  const productsDir = path.join(storefront, 'products');
  fs.mkdirSync(productsDir, { recursive: true });
  for (const entry of fs.readdirSync(productsDir)) {
    if (!products.some(p => p.id === entry)) fs.rmSync(path.join(productsDir, entry), { recursive: true, force: true });
  }
  const template = index;
  for (const product of products) {
    let page = template.replace('<head>', '<head>\n<base href="/">');
    page = page.replace('<body>', '<body data-product-id="' + product.id + '">');
    page = page.replace('<main id="main">', '<main id="main" hidden>');
    page = page.replace('<main id="product-page" hidden', '<main id="product-page"');
    const name = esc(product.name.en);
    page = page.replace('<h1 id="product-title"></h1>', () => '<h1 id="product-title">' + name + '</h1>');
    page = page.replace('<span id="product-crumb-name"></span>', () => '<span id="product-crumb-name">' + name + '</span>');
    page = page.replace('<p class="product-detail-price" id="product-price"></p>', () => '<p class="product-detail-price" id="product-price">' + pagePrice(product) + '</p>');
    page = page.replace('<div class="product-description" id="product-description"></div>',
      () => '<div class="product-description" id="product-description">' + product.description.en.map(p => '<p>' + esc(p) + '</p>').join('') + '</div>');
    page = page.replace('<img id="product-main-image" alt="">', () => '<img id="product-main-image" src="' + esc(product.images[0]) + '" alt="' + name + '" width="1024" height="1024">');
    fs.mkdirSync(path.join(productsDir, product.id), { recursive: true });
    fs.writeFileSync(path.join(productsDir, product.id, 'index.html'), page);
  }

  /* 3. Crawlable catalog grid and metadata (index + every product page) */
  const cards = products.map(product => {
    const name = esc(product.name.en); const url = '/products/' + product.id + '/';
    const badge = product.discount_percent ? `<span class="sale-badge">${product.discount_percent}% off</span>` : '';
    const setNote = product.id === 'christmas-sets' ? '<p class="catalog-set-note">Choose 1 complete set · $10 each</p>' : '';
    return `<article class="catalog-card"><a class="catalog-photo" href="${url}" aria-label="View ${name}"><img src="${esc(product.images[0])}" alt="${name}" loading="lazy" width="1024" height="1024"><span class="round-arrow" aria-hidden="true">↗</span>${badge}</a><p class="catalog-category">${esc(categoryName[product.category].en)}</p><div class="catalog-product-line"><h3><a href="${url}">${name}</a></h3>${setNote}<p>${cardPrice(product)}</p></div><a class="text-link" href="${url}">View piece ↗</a></article>`;
  });
  const catalog = '<!--CATALOG:START-->' + cards.join('') + '<!--CATALOG:END-->';
  const files = [indexPath, ...products.map(p => path.join(productsDir, p.id, 'index.html'))];
  for (const file of files) {
    let page = fs.readFileSync(file, 'utf8');
    page = page.includes('<!--CATALOG:START-->')
      ? page.replace(/<!--CATALOG:START-->[\s\S]*?<!--CATALOG:END-->/, () => catalog)
      : page.replace('<div class="catalog-grid" id="catalog-grid"></div>', () => '<div class="catalog-grid" id="catalog-grid">' + catalog + '</div>');
    const product = file === indexPath ? null : products.find(p => p.id === path.basename(path.dirname(file)));
    if (product) {
      const url = origin + '/products/' + product.id + '/';
      const schema = { '@type': 'Product', '@id': url + '#product', name: product.name.en, description: product.description.en.join(' '), image: product.images.map(f => origin + '/' + f), url, sku: product.id, brand: { '@type': 'Brand', name: 'Yuma 3D Studio' } };
      if (product.price_cents !== null) schema.offers = { '@type': 'Offer', url, priceCurrency: 'USD', price: (product.price_cents / 100).toFixed(2), seller: { '@id': origin + '/#studio' } };
      const breadcrumb = { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'The collection', item: origin + '/#shop' }, { '@type': 'ListItem', position: 2, name: product.name.en, item: url }] };
      page = metadata(page, { settings, origin, title: product.name.en + ' | Yuma 3D Studio', description: product.description.en[0], url, image: product.images[0], extra: [schema, breadcrumb] });
    } else {
      const items = { '@type': 'ItemList', itemListElement: products.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: origin + '/products/' + p.id + '/', name: p.name.en })) };
      page = metadata(page, { settings, origin, title: 'Yuma 3D Studio | Personalized 3D Gifts in Houston', description: 'Personalized 3D-printed name signs, keychains, photo frames and business displays. Made to order in Houston, Texas. Shipping across the US and Puerto Rico.', url: origin + '/', image: 'assets/catalog/clean-v2/charms-keychain.webp', extra: [items] });
    }
    fs.writeFileSync(file, page);
  }
  const urls = [origin + '/', ...products.map(p => origin + '/products/' + p.id + '/')];
  fs.writeFileSync(path.join(storefront, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls.map(u => '<url><loc>' + xmlEsc(u) + '</loc></url>').join('') + '</urlset>\n');
  fs.writeFileSync(path.join(storefront, 'robots.txt'), 'User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ' + origin + '/sitemap.xml\n');
  fs.writeFileSync(path.join(storefront, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | Yuma 3D Studio</title><body style="font:18px/1.7 Arial,sans-serif;background:#fcf9f2;color:#343b31;padding:10vw"><h1>This page has moved.</h1><p>Find your next personalized piece in the collection.</p><a href="/">Back to Yuma 3D Studio ↗</a></body></html>');
  log(`Sitio generado: ${products.length} productos visibles (${allProducts.length - products.length} ocultos), ${used.length} categorías, origen ${origin}`);
  return { products: products.length, hidden: allProducts.length - products.length, origin };
}

/** SITE_ORIGIN, then the Vercel production domain, then site-settings.json. */
function siteOrigin(settings, override) {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : '';
  const origin = (override || process.env.SITE_ORIGIN || vercel || settings.origin).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) throw new Error('SITE_ORIGIN tiene que ser un origen https, por ejemplo https://yuma3dstudio.com');
  return origin;
}

function metadata(page, { settings, origin, title, description, url, image, extra }) {
  page = page.replace(/<title>.*?<\/title>\n?/, '');
  page = page.replace(/<meta (?:name="(?:description|author|robots|theme-color|twitter:[^"]*)"|property="og:[^"]*")[^>]*>\n?/g, '');
  page = page.replace(/<link rel="(?:canonical|icon)"[^>]*>\n?/g, '');
  page = page.replace(/<script id="site-schema"[\s\S]*?<\/script>\n?/g, '');
  const organization = { '@type': 'Organization', '@id': origin + '/#studio', name: 'Yuma 3D Studio', url: origin + '/', logo: origin + '/assets/logo-original.png', telephone: '+18325072768', email: 'yuma3dstudio@gmail.com', address: { '@type': 'PostalAddress', addressLocality: 'Houston', addressRegion: 'TX', addressCountry: 'US' }, sameAs: ['https://www.instagram.com/yuma3dstudio/', 'https://www.facebook.com/share/1DoxDMzkqH/'] };
  const creator = { '@type': 'Person', '@id': origin + '/#web-creator', name: settings.creator, worksFor: { '@type': 'Organization', name: settings.agency, url: settings.agency_url } };
  const website = { '@type': 'WebSite', '@id': origin + '/#website', url: origin + '/', name: 'Yuma 3D Studio', publisher: { '@id': origin + '/#studio' }, creator: { '@id': origin + '/#web-creator' }, inLanguage: ['en', 'es'] };
  const tags = [`<title>${esc(title)}</title>`, `<meta name="description" content="${esc(description)}">`, `<meta name="author" content="${esc(settings.creator + ' · ' + settings.agency)}">`, '<meta name="robots" content="index,follow,max-image-preview:large">', '<meta name="theme-color" content="#fcf9f2">', `<link rel="canonical" href="${esc(url)}">`, '<link rel="icon" type="image/png" href="assets/logo-original.png">'];
  const og = { 'og:type': url === origin + '/' ? 'website' : 'product', 'og:site_name': 'Yuma 3D Studio', 'og:title': title, 'og:description': description, 'og:url': url, 'og:image': origin + '/' + image, 'og:image:alt': title, 'og:locale': 'en_US' };
  for (const [key, value] of Object.entries(og)) tags.push(`<meta property="${key}" content="${esc(value)}">`);
  tags.push('<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="${esc(description)}">`, `<meta name="twitter:image" content="${origin}/${image}">`);
  const schema = pyJson({ '@context': 'https://schema.org', '@graph': [organization, creator, website, ...extra] }).replace(/</g, '\\u003c');
  tags.push('<script id="site-schema" type="application/ld+json">' + schema + '</script>');
  return page.replace('</head>', () => tags.join('\n') + '\n</head>');
}

const dollars = cents => '$' + (cents / 100).toFixed(2);
// Same markup as the storefront renders (sale label + crossed-out catalog price when there is a discount).
function pagePrice(product) {
  if (product.price_cents === null) return 'Request a quote';
  const sale = product.discount_percent ? `<span class="sale-label">${product.discount_percent}% off catalog price</span>` : '';
  const before = product.discount_percent ? `<del>${dollars(product.compare_at_cents)}</del>` : '';
  return `${sale}<span class="price-pair">${before}<strong>${dollars(product.price_cents)} <small>USD</small></strong></span>`;
}
function cardPrice(product) {
  if (product.price_cents === null) return 'Request a quote';
  const before = product.discount_percent ? `<del>${dollars(product.compare_at_cents)}</del>` : '';
  return `<span class="price-pair">${before}<strong>${dollars(product.price_cents)}</strong></span>`;
}

function replaceOnce(text, pattern, replacement, label) {
  if (!pattern.test(text)) throw new Error(`storefront/index.html: no se encontró ${label}`);
  return text.replace(pattern, () => replacement);
}

// Same escaping as Python's html.escape (quote=True), which the previous build used.
function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function xmlEsc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// JSON with Python's default separators (", " and ": "), so rebuilt files stay byte-compatible.
function pyJson(value) {
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => JSON.stringify(k) + ': ' + pyJson(v)).join(', ') + '}';
  return JSON.stringify(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildSite(); } catch (error) { console.error(error.message); process.exit(1); }
}
