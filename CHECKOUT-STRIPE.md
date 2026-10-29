# Checkout único para Yuma 3D Studio

La bolsa actual suma productos, cantidades y envío. El servidor está preparado para crear **una Checkout Session por bolsa** en la cuenta de Stripe de Yuma. El comprador paga una vez por todo. Un enlace fijo por producto no representa las combinaciones de una bolsa dinámica.

Revisión del 29/10/2026: backend Worker ESM preparado para pruebas y producción, con una sesión por carrito, validación de precios y personalizaciones, firma de webhooks y retorno verificado por API. Se confirmó que Yuma3Dstudio tiene cobros y transferencias habilitados, sin requisitos de verificación pendientes. El checkout permanece deshabilitado: todavía no se creó la clave restringida, el sitio sigue privado y falta el correo transaccional. No se realizaron cobros.

## Flujo objetivo de producción

1. El navegador envía IDs de productos, cantidades, colores y textos elegidos, entrega e idioma a un endpoint propio. No envía un importe que el servidor deba aceptar como válido.
2. El servidor valida cada campo contra la configuración del producto y consulta precios del catálogo canónico. Rechaza productos sin precio, cantidades inválidas y extras cuyo importe todavía no esté definido. Guarda un pedido pendiente con una instantánea completa de la personalización.
3. Para el portafotos, primero se debe definir el precio y almacenar las imágenes en un espacio privado. El servidor guarda sus referencias en el pedido; no coloca imágenes privadas en URLs públicas ni en metadata de Stripe. Actualmente las imágenes son locales y el portafotos se cotiza.
4. El servidor crea la Checkout Session con `mode: payment`, todos los `line_items` y sus cantidades, moneda USD, referencia del pedido, URLs de retorno y cancelación y una clave de idempotencia. Usa un cliente Stripe con una clave restringida de **Yuma**, guardada en variables del servidor. No se incluye la clave en HTML, JavaScript público, repositorio ni chat.
5. El envío se calcula una sola vez en el servidor: USD 4,99; gratis desde USD 50 o para retiro. El cuestionario indica UPS, Estados Unidos y Puerto Rico. Confirmar que esa cobertura y tarifa siguen vigentes antes de activarlo. El checkout recoge la dirección para envíos; el retiro se coordina con Yuma.
6. El navegador recibe únicamente la URL de Checkout y redirige al comprador. No se exige pagar cada artículo por separado. Los medios de pago se configuran en Stripe y se muestran según elegibilidad; no se prometen Klarna o Afterpay sin activación.
7. Un webhook verifica la firma de Stripe y atiende `checkout.session.completed`, `checkout.session.async_payment_succeeded` y los fallos asíncronos. Marca el pedido pagado únicamente con pago confirmado y aplica idempotencia. La página de gracias no confirma pagos por sí sola.
8. Tras el pago verificado, un proceso persistente envía a `yuma3dstudio@gmail.com` el pedido con cada personalización, cantidades, entrega y referencias privadas de fotos; envía también la confirmación al comprador. Los reintentos no deben duplicar pedidos ni correos. El código actual notifica al negocio mediante Resend cuando se configura. El recibo al comprador requiere activar los correos de Stripe; no está verificado.

## Datos que faltan

- Configurar la integración y webhook en la cuenta de Stripe de la clienta, primero en un sandbox separado.
- El hosting del backend ya está desplegado. Falta correo transaccional y almacenamiento privado de fotos para habilitar el portafotos.
- Precio del portafotos, unidad de fotos 2 × 3 y cualquier cargo por accesorios.
- Confirmación final de envíos, impuestos aplicables y dominio público. No activar Stripe Tax sin las inscripciones correspondientes.

## Referencias oficiales

- https://docs.stripe.com/payments/checkout
- https://docs.stripe.com/api/checkout/sessions/create
- https://docs.stripe.com/checkout/fulfillment
- https://docs.stripe.com/keys

## Código y verificación actuales

- `storefront/`: interfaz original, assets y páginas. Reemplaza el antiguo directorio fuente `dist/`.
- `worker/index.js`: servidor. No contiene claves. Separa claves y sesiones por modo explícito; solo admite los identificadores conocidos de Yuma. Rechaza cualquier otra cuenta.
- `tools/build-checkout-worker.py`: empaqueta el frontend y el servidor en `dist/server/index.js`.
- `tests/checkout.test.mjs`: pruebas de precios, envío, validaciones, idempotencia, CSRF, separación de modos, bloqueo de cuentas ajenas, requisitos de activación y firmas de webhook (8 pruebas).
- `POST /api/checkout`: crea una sesión con varios artículos y cantidades; ignora precios enviados por el navegador.
- `GET /api/checkout/result`: verifica propietario por cookie, estado y detalle desde Stripe; no confía en el retorno por sí solo.
- `POST /api/stripe/webhook`: firma con tolerancia de cinco minutos, verificación del pago y correo con idempotencia del proveedor si se configura. No debe considerarse operativo hasta tener endpoint accesible, secreto de webhook y servicio de correo.

El snapshot se comprime y divide dentro de los límites de metadata de Stripe; contiene productos y personalización, sin datos de tarjeta ni imágenes privadas. El portafotos y mayoreo siguen por consulta. Los adornos de inicial distintos de estrellas/sin adorno requieren cotización antes de pagar porque su precio no está confirmado.

El sitio sigue privado. Stripe no puede entregar eventos a un endpoint protegido por el acceso de ChatGPT. Antes de activar producción hay que definir el dominio público y configurar y comprobar la entrega de webhooks. Nunca se cambia el acceso del sitio automáticamente.

La autorización más reciente permitió completar y aceptar el planificador de Checkout alojado en la cuenta real de Yuma. Se preparó el asistente para una clave restringida con permisos mínimos, sin confirmar su creación. El navegador exige confirmación puntual para crear credenciales. No se conectó ninguna cuenta de Grind.

La activación requiere `CHECKOUT_ENABLED=true`, `STRIPE_MODE=test|live`, `STRIPE_SECRET_KEY` del mismo modo, `STRIPE_ACCOUNT_ID` de Yuma correspondiente, `STRIPE_WEBHOOK_SECRET`, `ORDER_EMAIL_API_KEY` y `ORDER_EMAIL_FROM` verificado. La falta de cualquiera mantiene el botón oculto y el endpoint de creación responde 503. El webhook conserva los reintentos hasta notificar por correo; la página de retorno distingue pruebas de pagos reales. Las pruebas usan respuestas simuladas: aún falta verificar el circuito completo en Stripe.

No hay clave secreta en el repositorio, archivos descargables ni chat. No se creó ni se rotó una clave de Stripe.

El correo incluye el snapshot completo del pedido, además del resumen. Una prueba con personalización larga verifica que no se pierden datos por el límite de la descripción de Stripe y que reenviar el mismo evento no genera un segundo aviso.
