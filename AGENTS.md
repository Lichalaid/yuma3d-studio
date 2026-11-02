# Instructions for coding agents (Codex, Claude, etc.)

Yuma 3D Studio: static storefront + Stripe checkout + admin panel, deployed on Vercel from `main`.

## Data comes from the catalog
- Products, prices, photos and categories live in `catalog-products.json` and `catalog-categories.json`.
- The store owner edits them from the admin panel (`/admin/`), which commits to `main`. **Never edit these two files by hand** and never hardcode products, prices or categories in HTML/JS: read them from `#catalog-data` / `#category-data` (embedded by the build).
- `scripts/build-site.mjs` runs on every Vercel deploy: it embeds the catalog in `storefront/index.html`, generates `storefront/products/<id>/`, SEO, `sitemap.xml` and `robots.txt`. Do not edit generated product pages; change the template (`storefront/index.html`) or the build script.
- Run `git pull` before starting: the panel may have added commits.

## Do not break
- `worker/checkout.js`: server-side prices and personalization validation, Stripe Checkout, webhook. Any option the storefront sends (colors, texts, fonts, designs) must be accepted here, or payments fail.
- `worker/admin.js`, `worker/catalog-rules.js`, `storefront/admin/`: the panel. New catalog fields must pass `catalogErrors()` in `worker/catalog-rules.js` and be preserved by `applyChange()`.
- `api/*.js` + `worker/vercel.js`: Vercel functions (keep `export default vercelHandler(...)`).
- The color palette must stay identical in `storefront/app.js`, `worker/checkout.js` and `worker/catalog-rules.js` (a test checks it).

## Before committing
- `npm test` (unit, Stripe contract, panel and build).
- If you changed the storefront or checkout: `npm run test:e2e` (needs Playwright + Chromium).
- `node scripts/build-site.mjs` must succeed.
