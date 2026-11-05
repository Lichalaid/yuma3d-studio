# Checkout con Stripe — referencia técnica

Para activar los pagos, seguí [ACTIVAR-STRIPE.md](ACTIVAR-STRIPE.md). Este documento explica cómo funciona.

## Flujo

1. **Navegador.** La bolsa envía a `POST /api/checkout` los IDs de producto, las cantidades, los colores y textos elegidos, la entrega, el idioma y un `nonce` por intento. Ningún precio enviado por el navegador se usa.
2. **Servidor** (`worker/checkout.js`, que corre como función de Vercel en `api/` o como Cloudflare Worker):
   - Valida cada producto contra `catalog-products.json`, el mismo archivo que edita el panel ([PANEL-ADMIN.md](PANEL-ADMIN.md)): colores ofrecidos, campos obligatorios, letra inicial, largo de los nombres y perfiles sociales. Los productos ocultos no se pueden comprar.
   - Calcula subtotal y envío: USD 2,99, o gratis desde USD 50 o con retiro.
   - Crea **una** Checkout Session con todos los productos y una clave de idempotencia igual al hash de la solicitud.
   - El pedido completo viaja comprimido en la metadata de la sesión. No hay base de datos.
3. **Stripe Checkout:**
   - Muestra cada producto con su descripción legible (por ejemplo `Initial: E · Name: Emma · Initial color: Blue`) y una miniatura JPEG (`assets/catalog/stripe/`, generada por el panel al guardar o por `tools/prepare-stripe-images.py`) cuando el sitio está en https. Si Stripe objetara una imagen, el checkout se crea igual, sin fotos.
   - Pide teléfono y dirección (EE.UU. y Puerto Rico); con retiro, no pide dirección.
   - Muestra el plazo de entrega (3 a 7 días hábiles) y el aviso de fabricación a pedido.
4. **Webhook** (`POST /api/stripe/webhook`):
   - Verifica la firma con una tolerancia de 5 minutos.
   - Vuelve a leer la sesión en Stripe y, solo con el pago confirmado (`paid`), envía los dos emails: el pedido a Yuma y la confirmación al comprador.
   - Marca cada envío en la metadata (`shop_notified`, `buyer_notified`) para no repetirlo, y además usa claves de idempotencia en Resend.
5. **Página de regreso** (`/checkout-result/`): consulta `GET /api/checkout/result`, que lee el estado en Stripe. El detalle del pedido solo lo ve el navegador que inició la compra (cookie `yuma_checkout`). Si el pago queda pendiente, la página vuelve a consultar sola.

## Decisiones de robustez

| Riesgo | Cómo se evita |
| --- | --- |
| Precios alterados desde el navegador | Precios, envío y totales se recalculan en el servidor. |
| Pedido pagado sin aviso a Yuma | Si Resend falla, el webhook responde 503 y Stripe reintenta hasta 3 días. |
| Emails duplicados por reintentos | Marcas en la metadata de Stripe más claves de idempotencia en Resend. |
| Descuentos o impuestos que rompen la verificación | Se comparan el subtotal y el envío fijados por el servidor, no el total. Si no coinciden, igual se avisa a Yuma, con una advertencia. |
| Otros cobros de la misma cuenta (Payment Links) | El webhook ignora las sesiones sin el formato de pedido de la tienda y responde 200. |
| Pagos diferidos | Se espera `checkout.session.async_payment_succeeded`. Un `completed` sin pago confirmado no envía nada. |
| Clave de otra cuenta o de otro modo | Solo acepta las cuentas de Yuma (`YUMA_ACCOUNTS`) y verifica la cuenta en Stripe, con caché de 10 minutos. |
| Errores de Stripe sin diagnóstico | Cada error queda registrado con tipo, código, parámetro y `request_id` (Vercel → Logs). La clave nunca se registra. |
| Cortes momentáneos de Stripe | Reintentos con espera exponencial; todos los POST llevan clave de idempotencia. |
| Abuso del endpoint de checkout | Exige origen propio y cookie de visitante. En Cloudflare admite un limitador (binding `CHECKOUT_LIMITER`); en Vercel, una regla de Vercel Firewall. |

## Hosting

**Vercel (principal).** `vercel.json` publica `storefront/` como sitio estático y cada archivo de `api/` como función Node:

- Las funciones solo conectan la ruta con `worker/checkout.js` o `worker/admin.js` a través de `worker/vercel.js`.
- Ese adaptador corrige un detalle de Vercel: su runtime Node arma `request.url` con `http://` aunque el sitio esté en https. Sin la corrección, el control de origen rechazaría todos los pagos con 403 y la cookie perdería `Secure`. Esto se verificó con el adaptador real de `@vercel/node`.
- El build (`scripts/build-site.mjs`) regenera la tienda desde el catálogo en cada deploy.

**Cloudflare Workers (alternativa).** `wrangler.jsonc` publica la misma carpeta como Static Assets y `worker/index.js` como Worker:

- `worker/index.js` solo exporta `default`. Workers trata cada export con nombre del módulo principal como un punto de entrada y no arranca si hay otro tipo de export.
- El cliente de Stripe llama a `fetch` como función suelta. Llamarlo como método de otro objeto (`this.transport(...)`) provoca "Illegal invocation" en Workers; eso rompía la versión anterior en el primer cobro.

## Pruebas

- `tests/checkout.test.mjs`: precios, validaciones, idempotencia, reintentos, emails, webhooks, página de regreso, configuración y seguridad.
- `tests/contract.test.mjs`:
  - Cada solicitud a Stripe, de los 15 productos con precio, en los dos idiomas y con envío o retiro, se valida contra la especificación OpenAPI oficial de Stripe (`tests/fixtures/stripe-openapi-checkout.json`, versión `2026-10-28.endive`).
  - Las firmas de webhook se generan con el SDK oficial de Stripe.
- `tests/e2e/checkout.e2e.mjs`: Chromium real contra el servidor local con el motor de Vercel (`E2E_SERVER=node`) o contra `wrangler dev` (motor de Cloudflare). Cubre compras con envío, con envío gratis y con retiro, cancelación y regreso, celular, reintento del webhook y precio manipulado.
- `tests/e2e/admin.e2e.mjs`: el panel completo en Chromium. Crea un producto con fotos, partes y texto; lo compra en la tienda con el precio cargado; lo edita, oculta, ordena y borra; gestiona categorías; prueba celular y cierre de sesión.
- `tests/admin.test.mjs` y `tests/build.test.mjs`: login, sesión, bloqueo por intentos, commits contra un GitHub simulado (incluido el reintento si el repo cambió mientras se guardaba), reglas del catálogo y build.

## Pendientes comerciales (no técnicos)

- Precio de los adornos de inicial que no son estrellas ni "sin adorno": hoy se cotizan.
- Portafotos y mayoreo: siguen por consulta.
- Sales tax de Texas: decidirlo con la clienta antes de activar `STRIPE_AUTOMATIC_TAX`.
- Confirmar con Yuma la cobertura de envío (EE.UU. y Puerto Rico) y la tarifa.
