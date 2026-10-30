# Panel de administración ("puerta de atrás") — Yuma 3D Studio

La dueña entra a **`https://SU-DOMINIO/admin/`** con una contraseña. Desde ahí puede:

- Crear, editar, ocultar y borrar productos.
- Cargar por producto: fotos (hasta 8, desde la compu o el celular), nombre, descripción, precio en USD o "a consultar", categoría y colores disponibles.
- Definir las partes que el comprador colorea (por ejemplo "Base" y "Letras") y los textos que escribe (por ejemplo "Nombre", con máximo de letras).
- Crear, renombrar y quitar categorías.
- Ordenar el catálogo.

El inglés es opcional en todos los campos. Si queda vacío, la tienda muestra el texto en español.

La guía de uso para la clienta está en [GUIA-PARA-YUMA.md](GUIA-PARA-YUMA.md).

## Cómo funciona (sin base de datos)

1. Cada cambio guardado en el panel es **un commit** en el repositorio de GitHub del sitio. Toca `catalog-products.json`, `catalog-categories.json` y las fotos en `storefront/assets/catalog/uploads/`.
2. Vercel ve el commit y publica solo. El build (`node scripts/build-site.mjs`) regenera el catálogo, las páginas `/products/<id>/`, el SEO y el sitemap.
3. El panel consulta qué versión está online y avisa **"Publicado ✓"** cuando el cambio ya se ve, normalmente en 1 o 2 minutos.

Por qué así:

- **Un solo catálogo.** La tienda, el SEO y el cobro de Stripe leen el mismo archivo. El servidor de pagos toma el precio de ese catálogo, nunca del navegador.
- **Historial completo.** Cada cambio queda en GitHub con su mensaje ("Panel: crea «Llavero corazón»"). Cualquier error se deshace revirtiendo el commit.
- **Nada que mantener.** No hay base de datos, servidor ni cuenta extra.

**Reglas de seguridad del catálogo**

- El servidor valida todo antes de guardar: precios, fotos (solo JPG, PNG o WebP reales), categorías y colores de la paleta.
- El build vuelve a validar el catálogo. Si algo estuviera mal, Vercel no publica y la tienda sigue con la versión anterior.
- Los productos **ocultos** quedan en el archivo, pero no tienen página ni se pueden pagar.
- Los productos con opciones especiales (inicial + nombre con adornos, exhibidor y llavero NFC, portafotos) se editan desde el panel en nombre, descripción, fotos, precio, categoría y colores. Sus opciones especiales siguen definidas en código.

## Activación (una vez, la hace Grind)

### 1. El código en GitHub, conectado a Vercel

1. Subí esta carpeta a un repositorio **privado** de GitHub (rama `main`).
2. En Vercel: **Add New → Project → Import** ese repositorio. Vercel lee `vercel.json`: sin framework, build `node scripts/build-site.mjs` y carpeta pública `storefront`. No hace falta tocar nada más.
3. El plan Hobby de Vercel es solo para uso no comercial. Para una tienda que cobra, el proyecto tiene que estar en un equipo con plan **Pro**.
4. En **Settings → Environment Variables**, dejá activada la opción **"Automatically expose System Environment Variables"** (viene activada). El panel la usa para saber qué versión está online.

### 2. Token de GitHub (para que el panel pueda guardar)

En GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.

| Campo | Valor |
| --- | --- |
| Token name | `Yuma panel` |
| Expiration | La más larga que permita la cuenta. Anotá la fecha para renovarlo. |
| Repository access | **Only select repositories** → solo el repo de la tienda |
| Permissions → Repository → Contents | **Read and write** (Metadata queda en Read, es automático) |
| Todo lo demás | Sin acceso |

Si el repositorio es de una organización, puede que un admin tenga que aprobar el token.

### 3. Contraseña de la clienta

En esta carpeta: `npm run admin:password`. Pide la contraseña dos veces sin mostrarla, con un mínimo de 10 caracteres. Mejor una frase larga. Imprime las dos variables del paso siguiente. La contraseña no se guarda en ningún lado, solo su hash.

### 4. Variables en Vercel

En **Settings → Environment Variables**, para **Production** y marcadas como **Sensitive**:

| Variable | Valor |
| --- | --- |
| `ADMIN_PASSWORD_HASH` | La línea que imprimió `npm run admin:password` |
| `ADMIN_SESSION_SECRET` | La otra línea |
| `GITHUB_TOKEN` | `github_pat_…` del paso 2 |
| `GITHUB_REPO` | `usuario-o-organizacion/nombre-del-repo` |
| `GITHUB_BRANCH` | Opcional. Por defecto `main` (la rama de producción de Vercel). |

Después: **Deployments → Redeploy** para que tomen efecto.

### 5. Probar

1. Abrí `https://SU-DOMINIO/admin/`. Si falta algo, la página dice qué variable falta.
2. Entrá con la contraseña.
3. Creá un producto de prueba **oculto** (destildando "Visible en la tienda"). En GitHub aparece el commit y en Vercel el deploy. El panel pasa a "Publicado ✓".
4. Mostralo, verificá que aparezca en la tienda y que se pueda agregar a la bolsa. Después borralo.

## Seguridad

- **Contraseña.** Se guarda como hash PBKDF2-SHA256 de 600.000 iteraciones con sal aleatoria.
- **Sesión.** Cookie firmada con HMAC, `HttpOnly`, `Secure`, `SameSite=Strict`, limitada a `/api/admin` y válida por 12 horas.
- **Cambio de contraseña.** Cambiar `ADMIN_PASSWORD_HASH` cierra todas las sesiones abiertas.
- **Intentos fallidos.** Tras 5 intentos fallidos desde una misma conexión, el login se bloquea 15 minutos. Vercel puede correr varias instancias, así que el freno es por instancia; el hash lento hace inviable probar contraseñas igual. Para más, se puede sumar una regla de rate limit en Vercel Firewall sobre `POST /api/admin/session`.
- **Origen.** Solo se aceptan cambios enviados desde el mismo dominio.
- **Secretos.** El token de GitHub nunca llega al navegador y nunca se registra en los logs.
- **Buscadores.** `/admin/` no se indexa: tiene `noindex`, `X-Robots-Tag` y `Disallow` en robots.txt.

## Probar en tu compu

```sh
npm install
npm run dev        # http://localhost:3000 y http://localhost:3000/admin/
```

Sin variables, `npm run dev` imprime una **contraseña temporal** y el panel guarda en esta misma carpeta, regenerando el sitio al instante. Sirve para mostrarle el panel a la clienta antes de publicar. Si `.env.local` tiene `GITHUB_TOKEN` y `GITHUB_REPO`, guarda en GitHub como en producción.

## Si algo falla

| Síntoma | Qué revisar |
| --- | --- |
| "El panel todavía no está activado" | La página lista las variables que faltan (paso 4) y si se hizo Redeploy. |
| "GitHub rechazó el token" | El token venció o se borró: generá otro (paso 2) y reemplazá `GITHUB_TOKEN`. |
| "El token de GitHub no tiene acceso al repositorio" | `GITHUB_REPO` mal escrito, o el token no incluye ese repo o no tiene Contents: Read and write. |
| Queda en "Publicando…" | Vercel → Deployments: el último deploy debe estar en "Ready". Si falló por un catálogo inválido, el log del build dice qué producto y por qué. |
| Se cambió el código en otra rama | El panel guarda en `GITHUB_BRANCH`. Hacé merge antes de que la clienta siga editando, o vas a tener conflictos de git. |
| Deshacer un cambio | En GitHub, revertir el commit "Panel: …". Vercel republica la versión anterior. |

## Límites

- 200 productos, 30 categorías y 8 fotos por producto.
- Las fotos se convierten en el navegador a 1024 × 1024 px (WebP), con fondo crema y sin recortar el producto. Pesan entre 100 y 300 KB.
- La miniatura para Stripe se genera sola (600 px, JPG).
- La paleta de colores es fija (azul, rosado, rojo, arcoíris, amarillo, verde, morado, blanco y negro). Agregar un color nuevo es un cambio de código en `worker/catalog-rules.js`, `storefront/app.js` y `worker/checkout.js`; un test verifica que los tres coincidan.
- Los productos nuevos aparecen primeros en el catálogo. Con las flechas ↑ ↓ se cambia el orden.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `storefront/admin/` | Las pantallas del panel (HTML, CSS y JS sin dependencias). |
| `worker/admin.js` | API del panel: login, sesión, validación y commit a GitHub. |
| `worker/catalog-rules.js` | Reglas del catálogo, compartidas por el panel y el build. |
| `worker/vercel.js` | Adaptador de Vercel: recupera el origen `https` que Vercel pierde en las funciones Node. |
| `api/` | Las funciones de Vercel. Solo conectan cada ruta con `worker/`. |
| `scripts/build-site.mjs` | Genera la tienda a partir del catálogo en cada deploy. |
| `scripts/dev-server.mjs` | Servidor local con el mismo ruteo que Vercel. |
| `scripts/admin-password.mjs` | Genera la contraseña (`npm run admin:password`). |
