/*
 * Rules every catalog must follow. Used by the admin panel before saving (worker/admin.js)
 * and by the site build (scripts/build-site.mjs), so a broken catalog never reaches the store.
 * No dependencies: runs in Node, Vercel Functions and Cloudflare Workers.
 */

// Filament colors offered by the store. Keep in sync with `colors` in storefront/app.js and
// COLOR_NAMES in worker/checkout.js (tests/catalog.test.mjs checks it).
export const PALETTE = Object.freeze([
  { id: 'blue', en: 'Sky blue', es: 'Azul cielo', hex: '#83b8c9' },
  { id: 'dark-blue', en: 'Dark blue', es: 'Azul oscuro', hex: '#2f4f7f' },
  { id: 'pink', en: 'Pastel pink', es: 'Rosa pastel', hex: '#e7b3c1' },
  { id: 'dark-pink', en: 'Dark pink', es: 'Rosa oscuro', hex: '#b5527a' },
  { id: 'red', en: 'Red', es: 'Rojo', hex: '#bd4d49' },
  { id: 'rainbow', en: 'Rainbow', es: 'Arcoíris', hex: '#b39bc7', background: 'linear-gradient(135deg,#da807d,#e5ca79,#98b594,#8eb2d0,#b39bc7)' },
  { id: 'yellow', en: 'Yellow', es: 'Amarillo', hex: '#ebcf7c' },
  { id: 'green', en: 'Green', es: 'Verde', hex: '#94b28b' },
  { id: 'purple', en: 'Purple', es: 'Morado', hex: '#b39bc7' },
  { id: 'beige', en: 'Beige', es: 'Beige', hex: '#e3d2b4' },
  { id: 'brown', en: 'Brown', es: 'Marrón', hex: '#7b5137' },
  { id: 'gold', en: 'Gold', es: 'Dorado', hex: '#c8a24a', background: 'linear-gradient(135deg,#f3dc8c,#c8a24a 55%,#9c7a2c)' },
  { id: 'white', en: 'White', es: 'Blanco', hex: '#fffdf8' },
  { id: 'black', en: 'Black', es: 'Negro', hex: '#30332f' },
]);
const PALETTE_IDS = PALETTE.map(color => color.id);

export const LIMITS = Object.freeze({
  products: 200, categories: 30, images: 8, paragraphs: 6, paragraph: 1500, name: 80, categoryName: 40,
  colorFields: 12, textFields: 4, textMax: 40, minPrice: 50, maxPrice: 500000,
});
// Files the buyer sends on WhatsApp after paying (the store does not receive uploads).
export const SEND_AFTER_PAYMENT = ['photos', 'logo'];
export const PERSONALIZATION_TYPES = ['colors', 'initial-name', 'social', 'photos', 'plain'];
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9-]{0,39}$/;
export const IMAGE_PATH = /^assets\/(?:[a-z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(?:webp|jpe?g|png)$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function plain(value, max, { multiline = false } = {}) {
  return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= max
    && !CONTROL.test(value) && (multiline || !/[\r\n]/.test(value));
}

function bilingual(value, max) {
  return value && typeof value === 'object' && plain(value.en, max) && plain(value.es, max);
}

/** Turns a product name into a URL id: "Llavero corazón" → "llavero-corazon". */
export function slugify(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '') || 'producto';
}

/**
 * Returns a list of problems in Spanish (empty when the catalog is valid).
 * `imageExists(path)` is optional: when given, every photo must exist.
 */
export function catalogErrors(products, categories, { imageExists } = {}) {
  const errors = [];
  if (!Array.isArray(categories) || !categories.length || categories.length > LIMITS.categories) {
    errors.push(`Tiene que haber entre 1 y ${LIMITS.categories} categorías.`);
    categories = Array.isArray(categories) ? categories : [];
  }
  const categoryIds = new Set();
  for (const category of categories) {
    const label = category?.name?.es || category?.id || '(sin nombre)';
    if (!SLUG.test(category?.id || '') || category.id.length > 40) errors.push(`Categoría «${label}»: identificador inválido.`);
    else if (categoryIds.has(category.id)) errors.push(`Categoría «${label}» repetida.`);
    categoryIds.add(category?.id);
    if (!bilingual(category?.name, LIMITS.categoryName)) errors.push(`Categoría «${label}»: falta el nombre en español o en inglés (máximo ${LIMITS.categoryName} letras).`);
  }
  if (!Array.isArray(products) || products.length > LIMITS.products) {
    errors.push(`El catálogo admite hasta ${LIMITS.products} productos.`);
    return errors;
  }
  const ids = new Set();
  for (const product of products) {
    const label = product?.name?.es || product?.id || '(sin nombre)';
    const problem = text => errors.push(`«${label}»: ${text}`);
    if (!product || typeof product !== 'object') { errors.push('Hay un producto vacío.'); continue; }
    if (!SLUG.test(product.id || '') || product.id.length > 60) problem('identificador de URL inválido.');
    else if (ids.has(product.id)) problem('identificador repetido.');
    ids.add(product.id);
    if (!categoryIds.has(product.category)) problem('elige una categoría existente.');
    if (!bilingual(product.name, LIMITS.name)) problem(`el nombre es obligatorio (máximo ${LIMITS.name} letras, sin saltos de línea).`);
    for (const lang of ['es', 'en']) {
      const paragraphs = product.description?.[lang];
      if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.length > LIMITS.paragraphs
        || !paragraphs.every(p => plain(p, LIMITS.paragraph))) {
        problem(`la descripción${lang === 'en' ? ' en inglés' : ''} es obligatoria (hasta ${LIMITS.paragraphs} párrafos de ${LIMITS.paragraph} letras).`);
      }
    }
    if (product.price_cents !== null && (!Number.isInteger(product.price_cents) || product.price_cents < LIMITS.minPrice || product.price_cents > LIMITS.maxPrice)) {
      problem('el precio tiene que estar entre USD 0,50 y USD 5000, o marcarse «a consultar».');
    }
    if (product.currency !== 'USD') problem('la moneda tiene que ser USD.');
    // Sale price: compare_at_cents is the crossed-out price; discount_percent is derived from it.
    const compare = product.compare_at_cents ?? null, discount = product.discount_percent ?? null;
    if (compare !== null || discount !== null) {
      if (product.price_cents === null || !Number.isInteger(compare) || compare <= product.price_cents || compare > LIMITS.maxPrice) {
        problem('el precio anterior (tachado) tiene que ser mayor que el precio de venta.');
      } else if (discount !== discountPercent(compare, product.price_cents)) problem('el porcentaje de descuento no coincide con los precios.');
    }
    if ('hidden' in product && typeof product.hidden !== 'boolean') problem('valor de «oculto» inválido.');
    if (!Array.isArray(product.images) || !product.images.length || product.images.length > LIMITS.images) {
      problem(`necesita entre 1 y ${LIMITS.images} fotos.`);
    } else {
      for (const image of product.images) {
        if (typeof image !== 'string' || !IMAGE_PATH.test(image) || image.includes('..')) problem('hay una foto con una ruta inválida.');
        else if (imageExists && !imageExists(image)) problem(`no se encuentra la foto ${image}.`);
      }
      if (new Set(product.images).size !== product.images.length) problem('hay una foto repetida.');
    }
    const config = product.personalization;
    if (!config || typeof config !== 'object' || !PERSONALIZATION_TYPES.includes(config.type)) { problem('personalización inválida.'); continue; }
    if (config.type === 'plain') {
      if ((config.color_fields || []).length || (config.text_fields || []).length) problem('un producto sin personalización no lleva partes ni textos.');
      continue;
    }
    if ('color_mode' in config && config.color_mode !== 'bicolor') problem('modo de color inválido.');
    if ('accessory_groups' in config) {
      const groups = config.accessory_groups;
      if (!Array.isArray(groups) || !groups.length || groups.length > 4) problem('grupos de accesorios inválidos.');
      else {
        const groupKeys = new Set();
        for (const group of groups) {
          if (!FIELD_KEY.test(group?.key || '') || groupKeys.has(group.key)) problem('hay un grupo de accesorios repetido o inválido.');
          groupKeys.add(group?.key);
          if (!bilingual(group?.label, 60)) problem('cada grupo de accesorios necesita nombre en español e inglés.');
          if (!Number.isInteger(group?.max) || group.max < 1 || group.max > 5) problem('el máximo de accesorios va de 1 a 5.');
          const ids = new Set();
          if (!Array.isArray(group?.options) || !group.options.length || group.options.length > 20) { problem('cada grupo necesita entre 1 y 20 accesorios.'); continue; }
          for (const option of group.options) {
            if (!SLUG.test(option?.id || '') || ids.has(option.id)) problem('hay un accesorio repetido o inválido.');
            ids.add(option?.id);
            if (!bilingual(option?.label, 80)) problem('cada accesorio necesita nombre en español e inglés.');
          }
        }
      }
    }
    if ('send_after_payment' in config && !SEND_AFTER_PAYMENT.includes(config.send_after_payment)) problem('archivo a enviar después del pago inválido.');
    if (config.color_mode === 'bicolor' && config.colors?.includes('rainbow')) problem('el modo de dos colores no admite arcoíris.');
    if (!Array.isArray(config.colors) || !config.colors.every(c => PALETTE_IDS.includes(c)) || new Set(config.colors).size !== config.colors.length) {
      problem('hay un color que no está en la paleta.');
    }
    const fieldSets = [config.color_fields || [], ...(config.design_options || []).map(option => option.color_fields || [])];
    for (const fields of fieldSets) {
      if (!Array.isArray(fields) || fields.length > LIMITS.colorFields) { problem(`admite hasta ${LIMITS.colorFields} partes con color.`); continue; }
      const keys = new Set();
      for (const field of fields) {
        if (!FIELD_KEY.test(field?.key || '') || keys.has(field.key)) problem('hay una parte con color repetida o inválida.');
        keys.add(field?.key);
        if (!bilingual(field?.label, 60)) problem('cada parte con color necesita nombre en español e inglés.');
      }
      if (fields.length && !config.colors?.length) problem('marca al menos un color disponible para las partes.');
    }
    const textFields = config.text_fields || [];
    if (!Array.isArray(textFields) || textFields.length > LIMITS.textFields) problem(`admite hasta ${LIMITS.textFields} textos personalizados.`);
    else {
      const keys = new Set();
      for (const field of textFields) {
        if (!FIELD_KEY.test(field?.key || '') || keys.has(field.key)) problem('hay un texto personalizado repetido o inválido.');
        keys.add(field?.key);
        if (!bilingual(field?.label, 60)) problem('cada texto personalizado necesita nombre en español e inglés.');
        if ('max_length' in field && (!Number.isInteger(field.max_length) || field.max_length < 1 || field.max_length > LIMITS.textMax)) problem(`el largo máximo de un texto va de 1 a ${LIMITS.textMax}.`);
        if ('kind' in field && !['name', 'initial'].includes(field.kind)) problem('tipo de texto inválido.');
      }
    }
  }
  return errors;
}

/** Percentage shown on sale badges, e.g. 4200 → 3500 = 17. */
export function discountPercent(compareAtCents, priceCents) {
  return Math.round((100 * (compareAtCents - priceCents)) / compareAtCents);
}

/** Products shown in the store (hidden ones stay in the file but are not built or sold). */
export function visibleProducts(products) {
  return products.filter(product => !product.hidden);
}
