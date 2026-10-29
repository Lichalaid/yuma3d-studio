# Yuma 3D Studio — Boceto de ecommerce

Boceto estático bilingüe (inglés por defecto y español), basado en el cuestionario de la clienta y en las cinco capturas de su catálogo de Canva. El logo y las fotografías originales de inicio provienen del DOCX adjunto.

## Incluye
- Inicio, catálogo de 16 productos con filtros por categoría y fichas individuales, personalizador, bolsa con cantidades, elección envío/retiro, resumen y preguntas frecuentes.
- Se extrajeron 17 fotos: el exhibidor NFC tiene dos imágenes en una sola ficha porque ambas referencias comparten nombre y precio.
- `catalog-products.json` conserva nombres ES/EN, precios en centavos, fotos y trazabilidad de cada captura. No se inventaron tamaños, materiales ni variantes para los nuevos productos.
- Llaveros a mayoreo: precio por consulta, sin agregar un importe ficticio ni permitir sumarlos a la bolsa con precio cero.
- Las fichas publicadas usan `/products/<id>/`. El HTML único descargable usa `#product/<id>` para navegación sin servidor.
- Inicial + nombre: USD 35; 25 × 25 cm; PLA; máximo 15 caracteres.
- El dato del cuestionario sobre juguetes sensoriales (USD 9,99) se conserva como referencia; no se inventó una foto ni se mezcló con los 16 productos de las capturas.
- Letra inicial, nombre, adorno, colores y cantidad en la ficha de inicial + nombre, sin un personalizador adicional debajo. Nacimiento agrega fecha, hora y peso.
- Fabricación hasta 2 días, envío UPS USD 4,99, gratuito desde USD 50, entrega 3–5 días luego de producción. Retiro en Katy, TX 77449.
- Bolsa de prueba almacenada en sessionStorage. La revisión prepara un correo dirigido al negocio para revisión y envío manual desde la aplicación de email del visitante. Sin cobros, pedidos confirmados ni correo automático.

## Pagos con Stripe
Checkout completo: un solo pago de Stripe por bolsa, precios y personalización validados en el servidor, webhook firmado, email del pedido a Yuma y confirmación al comprador. Para activarlo, ver [ACTIVAR-STRIPE.md](ACTIVAR-STRIPE.md); el funcionamiento técnico está en [CHECKOUT-STRIPE.md](CHECKOUT-STRIPE.md).

## Confirmaciones pendientes
1. Credenciales de Stripe de la clienta (clave restringida y webhook) y dominio de correo para Resend. Ver ACTIVAR-STRIPE.md.
2. Colores de filamento para nombres: paleta ilustrativa, a validar.
3. Precio e inclusión de accesorios, formatos de nacimiento y tipografía final.
4. Para sumar los juguetes sensoriales al catálogo fotografiado, faltan fotos, formas/modelos, stock, edad recomendada y advertencias. No se inventaron certificaciones ni beneficios terapéuticos.
5. Política de devoluciones para stock, productos dañados, errores de fabricación y cancelaciones. Solo se incluyó la condición suministrada de no devolución de personalizados.
6. Dirección, horarios y condiciones de retiro. No asumir condiciones adicionales al cuestionario.
7. Backend y panel privado para editar catálogo, precios y fotos: fuera de este boceto. No usar un panel sin autenticación.
8. Disponibilidad y conexión de yuma3dstudio.com: no verificada.
9. Tratamiento definitivo de las imágenes. Se conservaron originales; no se inventaron productos ni reseñas.

## Diseño
Crema, rosa apagado, verde salvia y lila. Tipografía Manrope. Fotos reales, tamaños y precios visibles. Sin reseñas inventadas, contadores de urgencia, promesas genéricas ni animaciones automáticas.

## Importación del catálogo

La captura `124111` contiene dos referencias del mismo exhibidor NFC (USD 60), logos para negocios (USD 70) y llavero con chip para redes (USD 15). `124119`: cuatro nombres decorativos (USD 35, 30, 35, 50). `124138`: cuatro llaveros de USD 8. `124144`: dos nombres + accesorio (USD 15), abridor (USD 5), mayoreo (consulta) y charms (USD 15). `124152`: termo enfriador personalizado (USD 30).

Las fotografías originales recortadas se conservan en `dist/assets/catalog`. La versión usada en la tienda se restauró con la herramienta integrada image_gen a partir de las capturas completas, eliminando etiquetas, recuperando las zonas cortadas u ocultas y mejorando la definición. Se revisaron nombres, colores y accesorios contra el catálogo. Al partir de capturas pequeñas, la restauración reconstruye detalle; las capturas originales siguen siendo la referencia.

Las imágenes de entrega se guardan en `dist/assets/catalog/clean-v2`, formato WebP de 1024 × 1024 px. Las tarjetas y fichas usan formato cuadrado y object-fit contain, sin zoom de hover ni recorte del producto.

## Contacto para pedidos a medida

Se añadió una sección entre preguntas frecuentes y pie de página con enlaces a Instagram, WhatsApp (mensaje inicial localizado en inglés o español) y llamada al número suministrado por la clienta. El selector de idioma ahora ofrece botones EN y ES independientes, con estado activo visible y área de toque mayor. Verificado en escritorio y ancho móvil de 375 px sin desbordes.

## Descripciones de producto

Las 16 fichas tienen ahora dos párrafos en inglés y español en `description.en` y `description.es`. Se retiró el nombre original español que aparecía debajo de los títulos ingleses. La tipografía de las descripciones pasó a 16 px en escritorio y 15 px en móvil. Los textos describen la referencia del catálogo y mantienen explícitas las especificaciones que faltan, sin atribuir materiales, medidas o funciones sin confirmar.

## Opciones de la clienta — 28/10/2026

Los dos productos con chip ahora piden red social y nombre/usuario exacto, sin URL obligatoria, además de color de pieza y detalles. El exhibidor permite varios perfiles. La bolsa y la revisión conservan esa configuración. `personalization` en el JSON identifica estos productos.

El acceso «Personaliza con fotos» al final del catálogo abre un formulario local de 1–4 JPG/PNG/WebP de hasta 10 MiB, con vistas previas, eliminación, colores y notas. Se revisa la configuración antes de abrir WhatsApp. Las fotos no se envían: el visitante debe adjuntarlas en el chat. No se guardan en sessionStorage ni hay almacenamiento de archivos en servidor.

La medida solicitada es 2 × 3, sin unidad confirmada. La referencia del diseño no vino adjunta; por eso el formulario es independiente y por consulta, sin atribuirle una foto o precio de otro producto. Confirmar referencia, unidad y precio; para comercio real implementar recepción privada de imágenes asociada al pedido.

Chips y fotos reutilizan azul, rosado, rojo, arcoíris, amarillo, verde y morado del cuestionario, cuya lista original era de juguetes sensoriales. Confirmar disponibilidad para estos modelos. La bio de Yumarys se muestra en About / Quiénes somos, después de productos y personalizador, en inglés y español. La foto vigente de Yumarys es `WhatsApp Image 2026-10-28 at 5.50.37 PM.jpeg`, donde aparece junto a la impresora y sus piezas. Se conserva completa, sin retoques, en `dist/assets/yumarys-3d-studio.jpeg`, a 940 × 1267 px, con marco vertical adaptable y máximo de 480 px de ancho. Reemplaza el retrato cuadrado anterior.


## Colores en todas las piezas

Las 16 fichas ahora incluyen dos selecciones de color: principal/base/inicial y nombre/letras/detalles, según el modelo. Paleta unificada: azul, rosado, rojo, arcoíris, amarillo, verde, morado, blanco y negro. Los siete primeros vienen del cuestionario; los neutros se añadieron como colores principales en esta ampliación. Disponibilidad por modelo pendiente de validar con producción.

Las selecciones son obligatorias, se guardan por producto durante la carga de la página y pasan a la bolsa y al resumen EN/ES. Mayoreo incluye los colores en la consulta de WhatsApp. La ficha de inicial + nombre sincroniza sus opciones con el personalizador. La vista SVG usa un gradiente para arcoíris; las fotos originales se conservan como referencia. Los antiguos artículos de inicial + nombre sin paletteVersion siguen usando la paleta anterior; los nuevos llevan versión 2.

Cada `personalization` declara `type`, `colors` y `color_fields` bilingües. El importador conserva esta información. Los juguetes sensoriales mantienen sus siete colores originales. No se modificaron precios.


## Páginas de producto y componentes

El catálogo ahora enlaza a 16 páginas reales en `/products/<id>/`, generadas con `python3 tools/build-product-pages.py`. Ejecutar ese comando al cambiar la plantilla o el catálogo, antes de publicar. Cada página incluye título y datos SEO propios, galería, precio, descripción, cantidad y personalización. El HTML único descargable conserva navegación por hash con fichas a pantalla completa.

Los colores ahora se eligen por componente (base, nombre, luna, cada estrella, cada nube y partes específicas del modelo). Un selector permite aplicar un color inicial a todas las partes y luego cambiar cada una. Los borradores y el idioma se conservan en sessionStorage entre páginas. La bolsa guarda un snapshot de componentes, etiquetas, colores y nombres; la consulta de mayoreo incluye esa configuración. El porta lipgloss tiene diseño con textura o vaso con tapa y asa. Inicial + nombre contiene el personalizador dentro de su página y ofrece colores por adorno; cuatro estrellas en su vista ilustrativa.

Los nombres de los campos representan las piezas visibles en las referencias y requieren validación de producción antes de vender. No se verificó inventario por componente, geometría final ni procesos de aplicación del color. No se colorean las fotos ni los herrajes. Continúan pendientes los pagos y pedidos reales.


## Validación visual y ejemplos

Los campos obligatorios incompletos se marcan individualmente en rojo al intentar continuar, con mensaje inline, aria-invalid y foco en el primero. Al corregir una respuesta se limpia su estado y se conservan los errores restantes. Aplica a colores, nombres, perfiles sociales y personalizadores. Los ejemplos usan e.g., / Ej.: según EN/ES y no cuentan como respuestas. Charms tiene nombre obligatorio y colores por componente visibles. Todos los productos conservan colores visibles.


## Inicial + nombre y correo — versión vigente

La ficha de inicial + nombre solicita letra (una, mayúscula) y nombre (hasta 15 caracteres) en la misma columna que adorno, colores y cantidad. Añade directamente a la bolsa. Se retiró el antiguo personalizador inferior, su SVG y los controles duplicados, también de la portada. Sus accesos apuntan a la página del producto.

La revisión prepara un mailto a yuma3dstudio@gmail.com con todos los datos del diseño y los importes estimados. Abre el correo del visitante para revisar y enviar manualmente. No hay envío automático ni confirmación de recepción. Para esa parte falta conectar un proveedor de correo del negocio y un endpoint del servidor; no se cargaron credenciales ni se enviaron mensajes de prueba.

Los siete colores del cuestionario estaban confirmados para juguetes sensoriales. La disponibilidad por modelo sigue sin confirmar. Blanco y negro fueron una propuesta de interfaz. `color_availability: unconfirmed_per_model` se refleja en la UI y en el texto del correo como preferencias, no como inventario garantizado.
# Revisión del video — 28 de octubre de 2026

17 productos y 18 fotos: el portafotos tiene una URL propia, colores y hasta cuatro imágenes locales. Precio a consultar hasta recibirlo. Animaciones suaves de estrella, nube y luna con soporte de movimiento reducido. Navegación móvil y ajustes para iPhone/iPad. Autor del sitio: Lisandro Zampella / Grind Leads LLC.

`python3 tools/build-product-pages.py` también prepara catálogo en HTML, metadata, JSON-LD, sitemap y robots.txt. Para una publicación en otro dominio, ejecutar `SITE_ORIGIN=https://dominio-confirmado.com python3 tools/build-product-pages.py`; usar únicamente el dominio real conectado. El acceso del boceto alojado sigue privado: el SEO preparado no implica que Google pueda indexarlo todavía. El español se cambia en la misma URL; no se declaran versiones hreflang ficticias.

La bolsa se paga con una sola Checkout Session. Ver [CHECKOUT-STRIPE.md](CHECKOUT-STRIPE.md). La unidad de 2 × 3 del portafotos sigue pendiente.

## Checkout y publicación — 29/10/2026 (revisión)

- `storefront/`: sitio. `worker/index.js` + `worker/checkout.js`: servidor de pagos.
- Publicación en Cloudflare con Static Assets: `npm install` y `npm run deploy` (ver ACTIVAR-STRIPE.md).
- `npm run build` genera además la versión de un solo archivo (`dist/server/index.js`) para el hosting privado de chatgpt.site.
- Pruebas: `npm test` (unitarias y de contrato con la especificación OpenAPI de Stripe) y `npm run test:e2e` (compra completa en navegador contra el Worker local).
