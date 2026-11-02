# Yuma 3D Studio — Proyecto completo

Entrega: 2 de noviembre de 2026.
Fuente publicada: 57fc0fe8df7154975ebf416416edf8ffa792422c.
Sitio: https://yuma3d-studio-concept.lisanzampella.chatgpt.site

## Ver la página en tu computadora

Extraé el ZIP y abrí una terminal dentro de esta carpeta. Requiere Python 3.

En Windows:

```sh
py -3 -m http.server 8000 --directory storefront
```

En macOS/Linux:

```sh
python3 -m http.server 8000 --directory storefront
```

Abrí http://localhost:8000. Mantené la terminal abierta. Para detenerlo: Ctrl+C.
Esto permite recorrer el sitio y personalizar productos; no ejecuta la API ni cobra pagos. Abrir index.html con doble clic no equivale a servir todas las rutas.

## Contenido

- storefront/: página completa, 17 fichas de producto, imágenes, fuentes y licencias, CSS y JavaScript.
- catalog-products.json: catálogo canónico, precios, variantes, textos y personalización.
- worker/index.js: backend de Checkout y webhook.
- tools/: generadores de fichas, SEO y empaquetado.
- tests/: pruebas de checkout y entrega de todas las fotos.
- dist/server/index.js: Worker ESM ya compilado, con frontend y backend incluidos.
- .env.example: nombres de variables, sin claves secretas.
- .openai/hosting.json: identidad de la publicación actual en Sites.
- CHECKOUT-STRIPE.md y README.md: documentación e historial. Algunas notas históricas describen etapas anteriores; el código y este documento reflejan esta entrega.

## Regenerar y verificar

Requiere Node.js y Python 3. No hay paquetes npm de terceros que instalar.

```sh
npm run build
npm test
node scripts/validate-artifact.mjs
```

Editá los precios y opciones en catalog-products.json y luego ejecutá el build. No edites solamente el JSON incrustado en el HTML de una ficha.

## Estado real de pagos y fotografías

El checkout está desactivado. El servidor está preparado para un único pago con varios productos, validando precios y personalizaciones. Para activarlo faltan las credenciales de Stripe de Yuma, webhook accesible y comprobado, correo transaccional y pruebas de extremo a extremo. Nunca usar Stripe de Grind. No se incluyen credenciales reales.

El portafotos cuesta USD 35, admite hasta 4 fotos y muestra tamaño 2 × 3 (unidad pendiente de confirmar). Las fotos seleccionadas se previsualizan localmente: falta almacenamiento privado y envío automático asociado al pedido. El backend no permite pagar este producto hasta completar ese flujo. Mayoreo continúa por consulta.

Navidad: elegir uno de tres sets completos por USD 10; se incluyen los tres originales recibidos. Charms: USD 15 y dos colores sólidos distintos. Las fotos originales de producto no cambian al seleccionar fuentes. Chevy sigue siendo una aproximación con Chewy; Al Bayan depende de su disponibilidad en el dispositivo. Precios tachados y promociones requieren aprobación comercial antes de ventas reales.

Para publicar fuera de Sites hace falta un entorno compatible con Cloudflare Workers o adaptar el backend al hosting elegido. Subir únicamente storefront/ entrega la interfaz estática; no activa pagos. Se conserva el acceso privado de la publicación actual.

## Validación de esta entrega

Build generado y 14 pruebas aprobadas, incluyendo integridad de todas las imágenes de catálogo. Incluye el ajuste publicado para reintentar automáticamente las cargas de imagen fallidas.
