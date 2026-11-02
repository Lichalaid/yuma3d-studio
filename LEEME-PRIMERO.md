# Yuma 3D Studio — tienda, pagos y panel

Proyecto completo y listo para Vercel: la landing y la tienda (diseño de Codex al 2 de noviembre de 2026), el checkout con Stripe y el panel de administración en `/admin/`.

## Publicar

1. Este repositorio en GitHub, importado en Vercel (**Add New → Project**). La configuración está en `vercel.json`: no hay que tocar nada.
2. Variables en Vercel: las del panel ([PANEL-ADMIN.md](PANEL-ADMIN.md)) y las de Stripe ([ACTIVAR-STRIPE.md](ACTIVAR-STRIPE.md)).
3. Para una tienda que cobra, Vercel pide el plan Pro.

Cada `git push` a `main` publica solo. Cada cambio que la clienta guarda en el panel también, porque es un commit en `main`. Por eso, antes de trabajar en el código: `git pull`.

## Probar en tu compu

```sh
npm install
npm run dev     # tienda en http://localhost:3000 y panel en http://localhost:3000/admin/
```

El panel usa la contraseña temporal que imprime la terminal y guarda en esta carpeta.

## Dónde está cada cosa

| Qué | Dónde |
| --- | --- |
| Diseño de la tienda | `storefront/index.html`, `storefront/styles.css`, `storefront/app.js` |
| Productos y categorías | `catalog-products.json`, `catalog-categories.json`. Se editan desde el panel, no a mano. |
| Páginas de producto, SEO y sitemap | Se generan en cada deploy con `scripts/build-site.mjs` |
| Pagos | `worker/checkout.js` (en Vercel corre desde `api/`) |
| Panel | `storefront/admin/` y `worker/admin.js` |
| Guía para la clienta | [GUIA-PARA-YUMA.md](GUIA-PARA-YUMA.md) |

## Reglas para editar el código (también con Codex)

- No escribir productos ni precios en el HTML: la tienda los lee del catálogo.
- No editar a mano `catalog-products.json` ni `catalog-categories.json`, ni tocar `worker/`, `api/` o `storefront/admin/` sin correr las pruebas.
- Antes de subir: `npm test`.

Estas reglas también están en [AGENTS.md](AGENTS.md), que Codex lee solo.
