// Yuma 3D Studio — admin panel (talks to /api/admin/*, see worker/admin.js).
'use strict';
const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PHOTO_SIZE = 1024, STRIPE_SIZE = 600, BACKGROUND = '#fcf9f2';

let state = null;          // { products, categories, palette, limits, version, live }
let editing = null;        // product being edited
let orderDirty = false;
let pendingVersion = null, pollTimer = null, pollStarted = 0;

/* ---------------------------------------------------------------- API */

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch('/api/admin/' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== 'session') { showLogin('Tu sesión terminó. Vuelve a entrar.'); throw new Error('Tu sesión terminó.'); }
  if (!response.ok) throw new Error(data.error || 'No se pudo completar. Revisa tu conexión e intenta de nuevo.');
  return data;
}

/* ---------------------------------------------------------------- views */

function show(view) {
  for (const id of ['login-view', 'setup-view', 'app-view']) $('#' + id).hidden = id !== view;
  $('#bar-actions').hidden = view !== 'app-view';
}

function showLogin(message = '') {
  show('login-view');
  $('#login-error').textContent = message;
  $('#password').value = '';
  setTimeout(() => $('#password').focus(), 50);
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

async function start() {
  try {
    const session = await api('session');
    if (!session.configured) {
      show('setup-view');
      $('#setup-missing').innerHTML = session.missing.map(m => `<li><code>${esc(m)}</code></li>`).join('');
      return;
    }
    if (!session.authenticated) return showLogin();
    await loadCatalog();
  } catch (error) {
    showLogin(error.message);
  }
}

async function loadCatalog() {
  state = await api('catalog');
  show('app-view');
  openTab('products');
  renderProducts();
  renderCategories();
  if (state.live && state.version !== state.live) trackPublish(state.version, true);
}

/* ---------------------------------------------------------------- publishing status */

function setPublish(kind, text) {
  const el = $('#publish');
  el.hidden = !text; el.className = 'publish' + (kind ? ' ' + kind : ''); el.textContent = text || '';
}

function trackPublish(version, alreadyRunning = false) {
  pendingVersion = version;
  clearTimeout(pollTimer);
  if (!state.live && !alreadyRunning) {
    setPublish('ok', 'Guardado. La tienda se actualiza sola en 1 o 2 minutos.');
    return;
  }
  pollStarted = Date.now();
  setPublish('', alreadyRunning ? 'Hay cambios publicándose. Suele tardar 1 o 2 minutos.' : 'Guardado. Publicando en la tienda… suele tardar 1 o 2 minutos. Puedes seguir editando.');
  pollTimer = setTimeout(poll, 4000);
}

async function poll() {
  try {
    const session = await api('session');
    if (session.live === pendingVersion) {
      state.live = session.live;
      setPublish('ok', 'Publicado ✓ Los cambios ya se ven en la tienda.');
      pollTimer = setTimeout(() => setPublish('', ''), 10000);
      return;
    }
  } catch {}
  if (Date.now() - pollStarted > 8 * 60 * 1000) {
    setPublish('error', 'Lo guardado está a salvo, pero la tienda todavía no se actualizó. Si en unos minutos no aparece, avísale a Grind (Vercel → Deployments).');
    return;
  }
  pollTimer = setTimeout(poll, 5000);
}

function applySaved(result, text) {
  state.products = result.products;
  state.categories = result.categories;
  state.version = result.version;
  if (result.live !== undefined) state.live = result.live;
  renderProducts();
  renderCategories();
  toast(text);
  trackPublish(result.version);
}

/* ---------------------------------------------------------------- tabs */

function openTab(name) {
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('#products-tab').hidden = name !== 'products';
  $('#categories-tab').hidden = name !== 'categories';
  $('#editor').hidden = true;
  $('.tabs').hidden = false;
}

/* ---------------------------------------------------------------- product list */

const categoryName = id => state.categories.find(c => c.id === id)?.name.es || '—';
const money = cents => cents === null ? 'A consultar' : 'USD ' + (cents / 100).toFixed(2).replace(/\.00$/, '');

function renderProducts() {
  const query = $('#product-search').value.trim().toLowerCase();
  const visible = state.products.filter(p => !query || (p.name.es + ' ' + p.name.en).toLowerCase().includes(query));
  $('#product-count').textContent = `(${state.products.length})`;
  $('#product-list').innerHTML = visible.map(p => {
    const index = state.products.indexOf(p);
    return `<li class="product-row ${p.hidden ? 'is-hidden' : ''}" data-id="${esc(p.id)}">
      <img src="/${esc(p.images[0])}" alt="" loading="lazy" width="64" height="64">
      <div><div class="name">${esc(p.name.es)}${p.hidden ? '<span class="badge hidden-badge">Oculto</span>' : ''}</div>
        <div class="meta">${esc(categoryName(p.category))} · ${money(p.price_cents)}${p.discount_percent ? ` <span class="was">(antes ${money(p.compare_at_cents)} · ${p.discount_percent}% off)</span>` : ''}</div></div>
      <div class="row-actions">
        ${query ? '' : `<button type="button" class="move" data-move="-1" aria-label="Subir" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" class="move" data-move="1" aria-label="Bajar" ${index === state.products.length - 1 ? 'disabled' : ''}>↓</button>`}
        <button type="button" data-toggle>${p.hidden ? 'Mostrar' : 'Ocultar'}</button>
        <button type="button" data-edit>Editar</button>
      </div></li>`;
  }).join('') + (orderDirty ? `<li class="card"><p>Cambiaste el orden del catálogo.</p><div class="form-actions"><button type="button" class="primary" id="save-order">Guardar orden</button><button type="button" class="ghost" id="undo-order">Deshacer</button></div></li>` : '')
    + (!visible.length ? '<li class="muted">No hay productos con ese nombre.</li>' : '');
}

$('#product-list').addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'save-order') return saveOrder(button);
  if (button.id === 'undo-order') { orderDirty = false; return loadCatalog(); }
  const id = button.closest('[data-id]')?.dataset.id;
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  if (button.dataset.edit !== undefined) return openEditor(product);
  if (button.dataset.move) {
    const from = state.products.indexOf(product), to = from + Number(button.dataset.move);
    if (to < 0 || to >= state.products.length) return;
    state.products.splice(from, 1); state.products.splice(to, 0, product);
    orderDirty = true; renderProducts();
    $(`[data-id="${CSS.escape(id)}"] [data-move="${button.dataset.move}"]`)?.focus();
    return;
  }
  if (button.dataset.toggle !== undefined) {
    button.disabled = true;
    try {
      const result = await api('catalog', { method: 'POST', body: { op: 'visibility', id, hidden: !product.hidden } });
      applySaved(result, product.hidden ? 'Producto visible.' : 'Producto oculto.');
    } catch (error) { toast(error.message); button.disabled = false; }
  }
});

async function saveOrder(button) {
  button.disabled = true;
  try {
    const result = await api('catalog', { method: 'POST', body: { op: 'reorder', ids: state.products.map(p => p.id) } });
    orderDirty = false;
    applySaved(result, 'Orden guardado.');
  } catch (error) { toast(error.message); button.disabled = false; }
}

$('#product-search').addEventListener('input', renderProducts);
$$('.tabs button').forEach(b => b.addEventListener('click', () => { if (editing && !confirmLeave()) return; editing = null; openTab(b.dataset.tab); }));
$('#new-product').addEventListener('click', () => openEditor(null));

/* ---------------------------------------------------------------- editor */

const partsEditable = product => !product || (product.personalization?.type === 'colors' && !product.personalization.design_options?.length);
let dirty = false;
const confirmLeave = () => !dirty || window.confirm('Tienes cambios sin guardar. ¿Salir igual?');

function openEditor(product) {
  editing = {
    id: product?.id || null,
    original: product,
    photos: (product?.images || []).map(path => ({ kind: 'existing', path, src: '/' + path })),
    parts: partsEditable(product) ? (product ? product.personalization.color_fields : [{ label: { es: 'Color', en: 'Color' } }]).map(f => ({ key: f.key, es: f.label.es, en: f.label.en === f.label.es ? '' : f.label.en })) : [],
    texts: partsEditable(product) ? (product?.personalization.text_fields || []).map(f => ({ key: f.key, es: f.label.es, en: f.label.en === f.label.es ? '' : f.label.en, max: f.max_length || '', name: f.kind === 'name' })) : [],
  };
  $('.tabs').hidden = true;
  $('#products-tab').hidden = true; $('#categories-tab').hidden = true; $('#editor').hidden = false;
  $('#editor-title').textContent = product ? 'Editar producto' : 'Nuevo producto';
  $('#name-es').value = product?.name.es || '';
  $('#name-en').value = product && product.name.en !== product.name.es ? product.name.en : '';
  $('#desc-es').value = product?.description.es.join('\n\n') || '';
  const descEn = product?.description.en.join('\n\n') || '';
  $('#desc-en').value = descEn === $('#desc-es').value ? '' : descEn;
  $('#english').open = Boolean($('#name-en').value || $('#desc-en').value);
  $('#price').value = product && product.price_cents !== null ? (product.price_cents / 100).toFixed(2).replace(/\.00$/, '') : '';
  $('#quote').checked = product ? product.price_cents === null : false;
  $('#compare-price').value = product?.compare_at_cents ? (product.compare_at_cents / 100).toFixed(2).replace(/\.00$/, '') : '';
  $('#price').disabled = $('#compare-price').disabled = $('#quote').checked;
  showDiscount();
  $('#category').innerHTML = state.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name.es)}</option>`).join('');
  $('#category').value = product?.category || state.categories[0]?.id || '';
  const colors = product ? product.personalization.colors : state.palette.map(c => c.id);
  $('#swatches').innerHTML = state.palette.map(c => `<label class="swatch"><input type="checkbox" value="${esc(c.id)}" ${colors.includes(c.id) ? 'checked' : ''}><i style="background:${esc(c.background || c.hex)}"></i>${esc(c.es)}</label>`).join('');
  const plain = product?.personalization?.type === 'plain';
  $('#colors-fieldset').hidden = plain;
  $('#plain-note').hidden = !plain;
  $('#parts-block').hidden = !partsEditable(product);
  $('#special-note').hidden = partsEditable(product);
  $('#visible').checked = !product?.hidden;
  $('#delete').hidden = !product;
  $('#form-error').textContent = '';
  renderPhotos(); renderParts(); renderTexts();
  dirty = false;
  window.scrollTo(0, 0);
  $('#name-es').focus({ preventScroll: true });
}

function closeEditor() {
  editing = null; dirty = false;
  openTab('products');
  window.scrollTo(0, 0);
}

$('#product-form').addEventListener('input', () => { dirty = true; });
$('#editor-back').addEventListener('click', () => { if (confirmLeave()) closeEditor(); });
$('#cancel').addEventListener('click', () => { if (confirmLeave()) closeEditor(); });
$('#quote').addEventListener('change', () => { $('#price').disabled = $('#compare-price').disabled = $('#quote').checked; showDiscount(); });
function showDiscount() {
  const price = parsePrice($('#price').value), before = parsePrice($('#compare-price').value);
  const text = $('#compare-price').value.trim();
  $('#discount-preview').textContent = $('#quote').checked || !text ? ''
    : Number.isFinite(price) && Number.isFinite(before) && before > price ? `La tienda muestra «${Math.round((100 * (before - price)) / before)}% off» y el precio anterior tachado.`
    : 'Tiene que ser mayor que el precio de venta.';
}
$('#price').addEventListener('input', showDiscount);
$('#compare-price').addEventListener('input', showDiscount);
$('#all-colors').addEventListener('click', () => { $$('#swatches input').forEach(i => { i.checked = true; }); dirty = true; });
$('#no-colors').addEventListener('click', () => { $$('#swatches input').forEach(i => { i.checked = false; }); dirty = true; });

/* photos */

function renderPhotos() {
  const photos = editing.photos;
  $('#photos').innerHTML = photos.map((photo, i) => `<div class="photo ${photo.processing ? 'processing' : ''}">
      ${i === 0 ? '<span class="main-tag">Principal</span>' : ''}
      <img src="${esc(photo.src)}" alt="Foto ${i + 1}">
      <div class="photo-tools">
        <button type="button" data-photo-move="-1" data-i="${i}" aria-label="Mover a la izquierda" ${i === 0 ? 'disabled' : ''}>←</button>
        <button type="button" data-photo-remove data-i="${i}" aria-label="Quitar foto">✕</button>
        <button type="button" data-photo-move="1" data-i="${i}" aria-label="Mover a la derecha" ${i === photos.length - 1 ? 'disabled' : ''}>→</button>
      </div></div>`).join('') || '<p class="muted">Todavía no hay fotos.</p>';
  $('label[for=photo-input]').hidden = photos.length >= state.limits.images;
}

$('#photos').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  const i = Number(button.dataset.i);
  if (button.dataset.photoRemove !== undefined) editing.photos.splice(i, 1);
  else if (button.dataset.photoMove) {
    const to = i + Number(button.dataset.photoMove);
    const [photo] = editing.photos.splice(i, 1); editing.photos.splice(to, 0, photo);
  }
  dirty = true; renderPhotos();
});

$('#photo-input').addEventListener('change', async event => {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  const room = state.limits.images - editing.photos.length;
  if (files.length > room) toast(`Se agregan ${room} de ${files.length}: el máximo es ${state.limits.images} fotos.`);
  for (const file of files.slice(0, room)) {
    const photo = { kind: 'new', src: URL.createObjectURL(file), processing: true };
    editing.photos.push(photo); renderPhotos();
    try {
      Object.assign(photo, await preparePhoto(file), { processing: false });
    } catch {
      editing.photos.splice(editing.photos.indexOf(photo), 1);
      toast(`No se pudo leer «${file.name}». Prueba con una foto JPG o PNG.`);
    }
    dirty = true; renderPhotos();
  }
});

async function loadImage(source) {
  if (source instanceof Blob && 'createImageBitmap' in window) {
    try { return await createImageBitmap(source); } catch {}
  }
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  return img;
}

function squareCanvas(image, size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BACKGROUND; ctx.fillRect(0, 0, size, size);
  const w = image.width || image.naturalWidth, h = image.height || image.naturalHeight;
  const scale = Math.min(size / w, size / h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (size - w * scale) / 2, (size - h * scale) / 2, w * scale, h * scale);
  return canvas;
}

const toBlob = (canvas, type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
const blobToBase64 = blob => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

// Square 1024 px WebP (JPEG where the browser cannot write WebP), cream background like the catalog.
async function preparePhoto(file) {
  const image = await loadImage(file);
  const canvas = squareCanvas(image, PHOTO_SIZE);
  let blob = await toBlob(canvas, 'image/webp', 0.86);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.88);
  if (!blob) throw new Error('encode');
  return { blob, src: URL.createObjectURL(blob), base64: await blobToBase64(blob), image };
}

async function stripeThumbnail(photo) {
  const image = photo.image || await loadImage(photo.src);
  const blob = await toBlob(squareCanvas(image, STRIPE_SIZE), 'image/jpeg', 0.85);
  return blobToBase64(blob);
}

/* parts and texts */

function renderParts() {
  $('#part-rows').innerHTML = editing.parts.map((part, i) => `<div class="field-row" data-i="${i}">
    <div><label for="part-es-${i}">Parte</label><input id="part-es-${i}" data-part="es" value="${esc(part.es)}" placeholder="Ej.: Base" maxlength="60"></div>
    <div><label for="part-en-${i}">En inglés (opcional)</label><input id="part-en-${i}" data-part="en" value="${esc(part.en)}" placeholder="Ej.: Base" maxlength="60"></div>
    <button type="button" class="remove" data-remove-part="${i}" aria-label="Quitar parte">✕</button></div>`).join('');
}
function renderTexts() {
  $('#text-rows').innerHTML = editing.texts.map((text, i) => `<div class="field-row text" data-i="${i}">
    <div><label for="text-es-${i}">Texto</label><input id="text-es-${i}" data-text="es" value="${esc(text.es)}" placeholder="Ej.: Nombre" maxlength="60"></div>
    <div><label for="text-en-${i}">En inglés (opcional)</label><input id="text-en-${i}" data-text="en" value="${esc(text.en)}" placeholder="Ej.: Name" maxlength="60"></div>
    <div><label for="text-max-${i}">Máx. letras</label><input id="text-max-${i}" data-text="max" value="${esc(text.max)}" inputmode="numeric" placeholder="20"></div>
    <button type="button" class="remove" data-remove-text="${i}" aria-label="Quitar texto">✕</button>
    <label class="check kind"><input type="checkbox" data-text="name" ${text.name ? 'checked' : ''}> Solo letras (para nombres)</label></div>`).join('');
}
$('#part-rows').addEventListener('input', e => { const row = e.target.closest('[data-i]'); if (row && e.target.dataset.part) editing.parts[row.dataset.i][e.target.dataset.part] = e.target.value; });
$('#text-rows').addEventListener('input', e => {
  const row = e.target.closest('[data-i]'); const key = e.target.dataset.text;
  if (row && key) editing.texts[row.dataset.i][key] = key === 'name' ? e.target.checked : e.target.value;
});
$('#part-rows').addEventListener('click', e => { const i = e.target.closest('[data-remove-part]')?.dataset.removePart; if (i !== undefined) { editing.parts.splice(i, 1); dirty = true; renderParts(); } });
$('#text-rows').addEventListener('click', e => { const i = e.target.closest('[data-remove-text]')?.dataset.removeText; if (i !== undefined) { editing.texts.splice(i, 1); dirty = true; renderTexts(); } });
$('#add-part').addEventListener('click', () => { editing.parts.push({ es: '', en: '' }); renderParts(); $(`#part-es-${editing.parts.length - 1}`).focus(); });
$('#add-text').addEventListener('click', () => { editing.texts.push({ es: '', en: '', max: 20, name: true }); renderTexts(); $(`#text-es-${editing.texts.length - 1}`).focus(); });

/* save and delete */

function parsePrice(text) {
  const clean = text.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return NaN;
  return Math.round(Number(clean) * 100);
}

function formProblems() {
  const problems = [];
  if (!$('#name-es').value.trim()) problems.push('Escribe el nombre.');
  if (!$('#desc-es').value.trim()) problems.push('Escribe la descripción.');
  if (!editing.photos.length) problems.push('Agrega al menos una foto.');
  if (editing.photos.some(p => p.processing)) problems.push('Espera a que terminen de cargar las fotos.');
  if (!$('#quote').checked) {
    const cents = parsePrice($('#price').value);
    if (!Number.isFinite(cents) || cents < 50) problems.push('Escribe un precio válido (por ejemplo 15 o 12.50), o marca «Precio a consultar».');
    const before = $('#compare-price').value.trim() ? parsePrice($('#compare-price').value) : null;
    if (before !== null && !(before > cents)) problems.push('El precio anterior (tachado) tiene que ser mayor que el precio de venta, o déjalo vacío.');
  }
  const colors = $$('#swatches input:checked');
  if (partsEditable(editing.original) && editing.parts.some(p => p.es.trim()) && !colors.length) problems.push('Marca al menos un color o quita las partes a colorear.');
  return problems;
}

$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const problems = formProblems();
  $('#form-error').textContent = problems.join('\n');
  if (problems.length) return;
  const save = $('#save');
  save.disabled = true; save.textContent = 'Guardando…';
  try {
    const uploads = [];
    const images = editing.photos.map(photo => (photo.kind === 'existing' ? photo.path : { upload: uploads.push({ data: photo.base64 }) - 1 }));
    const first = editing.photos[0];
    const firstChanged = !editing.original || first.kind === 'new' || first.path !== editing.original.images[0];
    const body = {
      op: 'upsert',
      product: {
        id: editing.id,
        name: { es: $('#name-es').value, en: $('#name-en').value },
        description: { es: $('#desc-es').value, en: $('#desc-en').value },
        price_cents: $('#quote').checked ? null : parsePrice($('#price').value),
        compare_at_cents: $('#quote').checked || !$('#compare-price').value.trim() ? null : parsePrice($('#compare-price').value),
        category: $('#category').value,
        hidden: !$('#visible').checked,
        images,
        colors: $$('#swatches input:checked').map(i => i.value),
        color_fields: editing.parts.map(p => ({ key: p.key, label: { es: p.es, en: p.en } })),
        text_fields: editing.texts.map(t => ({ key: t.key, label: { es: t.es, en: t.en }, max_length: Number(t.max) || 20, kind: t.name ? 'name' : 'text' })),
      },
      uploads,
      position: editing.id ? undefined : 'start',
    };
    if (firstChanged) body.stripe_thumbnail = { data: await stripeThumbnail(first) };
    const result = await api('catalog', { method: 'POST', body });
    const isNew = !editing.id;
    dirty = false;
    closeEditor();
    applySaved(result, isNew ? 'Producto creado.' : 'Cambios guardados.');
  } catch (error) {
    $('#form-error').textContent = error.message;
  } finally {
    save.disabled = false; save.textContent = 'Guardar y publicar';
  }
});

function ask(text, okLabel = 'Borrar') {
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  const dialog = $('#confirm');
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

$('#delete').addEventListener('click', async () => {
  const product = editing.original;
  if (!await ask(`¿Borrar «${product.name.es}»? Desaparece de la tienda y no se puede deshacer desde el panel. Si solo quieres sacarlo un tiempo, usa «Ocultar».`)) return;
  try {
    const result = await api('catalog', { method: 'POST', body: { op: 'delete', id: product.id } });
    dirty = false; closeEditor();
    applySaved(result, 'Producto borrado.');
  } catch (error) { $('#form-error').textContent = error.message; }
});

/* ---------------------------------------------------------------- categories */

let categoryDraft = [];
function renderCategories() {
  categoryDraft = state.categories.map(c => ({ id: c.id, es: c.name.es, en: c.name.en === c.name.es ? '' : c.name.en }));
  drawCategories();
}
function drawCategories() {
  $('#category-rows').innerHTML = categoryDraft.map((c, i) => {
    const used = c.id ? state.products.filter(p => p.category === c.id).length : 0;
    return `<div class="cat-row" data-i="${i}">
      <div><label for="cat-es-${i}">Nombre</label><input id="cat-es-${i}" data-cat="es" value="${esc(c.es)}" maxlength="40" required></div>
      <div><label for="cat-en-${i}">En inglés (opcional)</label><input id="cat-en-${i}" data-cat="en" value="${esc(c.en)}" maxlength="40"></div>
      <button type="button" class="remove" data-remove-cat="${i}" ${used ? 'disabled title="Tiene productos"' : ''}>Quitar</button>
      <small>${used ? `${used} producto${used === 1 ? '' : 's'}` : 'Sin productos'}</small></div>`;
  }).join('');
}
$('#category-rows').addEventListener('input', e => { const row = e.target.closest('[data-i]'); if (row && e.target.dataset.cat) categoryDraft[row.dataset.i][e.target.dataset.cat] = e.target.value; });
$('#category-rows').addEventListener('click', e => { const i = e.target.closest('[data-remove-cat]')?.dataset.removeCat; if (i !== undefined) { categoryDraft.splice(i, 1); drawCategories(); } });
$('#add-category').addEventListener('click', () => { categoryDraft.push({ es: '', en: '' }); drawCategories(); $(`#cat-es-${categoryDraft.length - 1}`).focus(); });
$('#categories-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#categories-error').textContent = '';
  try {
    const result = await api('catalog', { method: 'POST', body: { op: 'categories', categories: categoryDraft.map(c => ({ id: c.id, name: { es: c.es, en: c.en } })) } });
    applySaved(result, 'Categorías guardadas.');
  } catch (error) { $('#categories-error').textContent = error.message; }
});

/* ---------------------------------------------------------------- login / logout */

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || $('#login-form .primary');
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('session', { method: 'POST', body: { password: $('#password').value } });
    await loadCatalog();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally { button.disabled = false; }
});

$('#logout').addEventListener('click', async () => {
  if (editing && !confirmLeave()) return;
  await api('session', { method: 'DELETE' }).catch(() => {});
  editing = null; state = null;
  showLogin('Cerraste la sesión.');
});

window.addEventListener('beforeunload', event => { if (dirty || orderDirty) { event.preventDefault(); event.returnValue = ''; } });
start();
