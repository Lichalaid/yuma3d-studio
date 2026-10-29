# Activar los pagos con Stripe — Yuma 3D Studio

El checkout está completo y probado. Un solo pago de Stripe cubre toda la bolsa, y el servidor recalcula precios, envío y personalización. Al confirmarse el pago, Yuma recibe el pedido por email en español y el comprador recibe su confirmación.

Solo faltan las credenciales de Yuma y publicar el sitio. Se pueden probar los pagos completos **en tu compu antes de publicar**, con el Stripe CLI (paso 2).

## 0. Qué necesitás

- Node.js 20 o más nuevo, y Python 3 (solo para regenerar las páginas de producto).
- En esta carpeta: `npm install`.
- Acceso al Stripe de Yuma, primero al **sandbox** (`acct_1UVZa22S141stGeG`).
- Una cuenta de Cloudflare a nombre de Yuma. El plan gratis alcanza.
- El [Stripe CLI](https://docs.stripe.com/stripe-cli) para el paso 2.

## 1. Crear la clave restringida del sandbox

En Stripe, con el sandbox de Yuma seleccionado, entrá a **Desarrolladores → Claves de API → Crear clave restringida**. Nombre sugerido: `Yuma tienda - test`.

| Recurso | Permiso |
| --- | --- |
| Checkout Sessions | Escritura |
| Products | Escritura |
| Prices | Escritura |
| Shipping Rates | Escritura |
| Account (Accounts) | Lectura |
| Todo lo demás | Ninguno |

Guardá la clave (`rk_test_…`) en `.dev.vars` (paso 2) y corré:

```sh
npm run stripe:check
```

El script crea un checkout de prueba, verifica que la clave sea del sandbox de Yuma, lee el pedido guardado y vence la sesión, sin cobrar nada. Si falta un permiso, muestra el motivo exacto de Stripe: agregá solo ese permiso a la clave.

## 2. Probar todo en tu compu, sin publicar

1. `cp .dev.vars.example .dev.vars` y completá `STRIPE_SECRET_KEY`. Este archivo nunca se sube a git.
2. En una terminal, con la cuenta de Yuma y su sandbox:

   ```sh
   stripe login
   stripe listen --forward-to localhost:8787/api/stripe/webhook
   ```

   Copiá el `whsec_…` que imprime en `STRIPE_WEBHOOK_SECRET` dentro de `.dev.vars`.
3. En otra terminal: `npm run dev` y abrí http://localhost:8787.
4. Comprá con la tarjeta `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC.

Al pagar, Stripe manda el evento a tu compu. Como `.dev.vars.example` trae `ORDER_EMAIL_MODE=log`, los dos emails se imprimen en la terminal de `npm run dev` y no se envían. Ese modo solo existe en pruebas.

## 3. Publicar en Cloudflare

```sh
npx wrangler login          # con la cuenta de Cloudflare de Yuma
npm run deploy              # devuelve la URL, por ejemplo https://yuma3d-studio.<cuenta>.workers.dev
```

Con la URL definitiva (o el dominio propio, cuando esté), regenerá las páginas para que el SEO apunte ahí y volvé a publicar:

```sh
SITE_ORIGIN=https://yuma3d-studio.<cuenta>.workers.dev npm run build:pages
npm run deploy
```

En Windows (PowerShell): `$env:SITE_ORIGIN="https://…"; npm run build:pages`.

El Worker pesa unos 20 KB y las imágenes se sirven como archivos estáticos de Cloudflare, así que entra en el plan gratis.

## 4. Webhook, correo y variables del sitio publicado

**Webhook.** En Stripe (sandbox), entrá a **Workbench → Webhooks → Agregar destino**. Elegí eventos de tu cuenta, versión `2026-09-30.endive`, y estos tres:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
```

La URL es `https://TU-URL/api/stripe/webhook`. Guardá el secreto `whsec_…` de ese destino. Es distinto del que imprime el Stripe CLI.

**Correo (Resend).** En [resend.com](https://resend.com):
1. Verificá un dominio de Yuma.
2. Creá una clave con permiso **Sending access**.
3. Usá como remitente una dirección de ese dominio, por ejemplo `Yuma 3D Studio <orders@yuma3dstudio.com>`.

El destinatario sigue siendo `yuma3dstudio@gmail.com`, que no puede ser el remitente.

**Variables.** Creá un archivo `secrets.test.json`. El `.gitignore` ya lo excluye.

```json
{
  "CHECKOUT_ENABLED": "true",
  "STRIPE_MODE": "test",
  "STRIPE_ACCOUNT_ID": "acct_1UVZa22S141stGeG",
  "STRIPE_SECRET_KEY": "rk_test_…",
  "STRIPE_WEBHOOK_SECRET": "whsec_…",
  "ORDER_EMAIL_API_KEY": "re_…",
  "ORDER_EMAIL_FROM": "Yuma 3D Studio <orders@tu-dominio.com>"
}
```

Cargalo y borralo:

```sh
npx wrangler secret bulk secrets.test.json
rm secrets.test.json
```

Se guardan como secretos, así que `npm run deploy` nunca los pisa. No los cargues como "variables de texto" en el panel de Cloudflare: cada deploy borra esas. Comprobá `https://TU-URL/api/checkout/status`. Tiene que mostrar `configured: true`, `mode: "test"` y los otros dos valores en `true`.

## 5. Prueba en el sitio publicado (sandbox)

1. Inicial + nombre (USD 35) y un llavero (USD 8): el total tiene que ser **USD 47,99** (43 + 4,99 de envío).
2. Inicial + nombre y dos llaveros: **USD 51,00**, con envío gratis.
3. Retiro en Katy: envío en USD 0 y Stripe no pide dirección.
4. Pagá con `4242…`. La página de regreso dice "Test payment confirmed" y muestra el pedido completo.
5. En Stripe → Webhooks, el evento tiene respuesta **200**.
6. Llegan dos emails: el pedido a `yuma3dstudio@gmail.com`, con la letra, el nombre y los colores de cada pieza, y la confirmación al comprador.
7. Reenviá el mismo evento desde Stripe: no llegan emails repetidos.
8. Empezá otro pago y tocá "volver" en Stripe: la tienda dice "Pago cancelado" y la bolsa sigue ahí.

## 6. Pasar a pagos reales

1. En la cuenta real de Yuma (`acct_1UVgaICbK0UdCU0G`), repetí el paso 1 (clave `rk_live_…`) y el webhook del paso 4.
2. Creá `secrets.live.json` con `STRIPE_MODE=live`, `STRIPE_ACCOUNT_ID=acct_1UVgaICbK0UdCU0G` y las claves reales. Cargalo con `npx wrangler secret bulk` y borralo.
3. `/api/checkout/status` tiene que mostrar `mode: "live"`. El botón pasa a decir "Pay securely with Stripe".
4. Hacé una compra real chica y reembolsala desde Stripe.

Para pausar los pagos: `npx wrangler secret put CHECKOUT_ENABLED` con el valor `false`.

## 7. Medios de pago y avisos de Stripe

- **Klarna, Afterpay, Apple Pay y Google Pay:** se activan en Stripe → Configuración → Métodos de pago. El checkout los muestra solo si el monto y el país califican; Klarna aparece desde USD 10. No hace falta tocar código.
- **Recibo de Stripe al comprador:** Configuración → Correos a clientes → Pagos exitosos. Es opcional, porque la tienda ya envía su propia confirmación.
- **Aviso de respaldo para Yuma:** en su perfil de Stripe, activar las notificaciones por email de pagos exitosos. Si un día falla Resend, igual se entera, y el webhook reintenta solo hasta 3 días.

## 8. Opciones que se activan sin tocar código

| Variable | Qué hace |
| --- | --- |
| `ALLOW_PROMOTION_CODES=true` | Muestra el campo de cupón en Stripe. Los cupones se crean en Stripe → Catálogo de productos → Cupones. |
| `STRIPE_AUTOMATIC_TAX=true` | Calcula el sales tax con Stripe Tax. Activarlo solo después de registrar Texas en Stripe Tax y probarlo en el sandbox (`npm run stripe:check`). |
| `BUYER_CONFIRMATION_EMAIL=off` | Deja de enviar la confirmación propia al comprador. |

Los descuentos y los impuestos no rompen la verificación del pedido: el servidor controla los productos y el envío que fijó él mismo.

## 9. Si algo falla

`npm run logs` muestra en vivo el registro del Worker. Cada error de Stripe aparece con su motivo exacto, por ejemplo `"event":"stripe_api_error","message":"…"`.

| Síntoma | Qué revisar |
| --- | --- |
| No aparece el botón de pago | `/api/checkout/status` y las variables del paso 4. |
| "Stripe could not process this request" | `npm run logs`: el `message` dice qué parámetro o permiso falta. |
| El webhook responde 400 | El `whsec_` es de otro destino o de otro modo (test/live). |
| El webhook responde 503 | Resend rechazó el email: dominio, clave o remitente. Stripe reintenta solo; al corregirlo, sale. |
| Se cambió el catálogo y la web no | `npm run build:pages` (regenera páginas y miniaturas de Stripe) y `npm run deploy`. |

## Comandos

| Comando | Para qué |
| --- | --- |
| `npm test` | 33 pruebas: precios, validaciones, firma de webhooks y contrato con la API de Stripe. |
| `npm run test:e2e` | Compra completa en un navegador real contra el Worker local. Requiere `npm i -D playwright && npx playwright install chromium`. |
| `npm run stripe:check` | Verifica la clave real del sandbox. |
| `npm run dev` | Tienda y pagos de prueba en http://localhost:8787. |
| `npm run deploy` | Publica en Cloudflare. |
| `npm run logs` | Registro en vivo del sitio publicado. |
| `npm run build` | Versión de un solo archivo (`dist/server/index.js`) para el hosting privado de chatgpt.site. |
