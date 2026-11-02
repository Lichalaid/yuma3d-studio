'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const title = $('#result-title'), message = $('#result-message'), list = $('#result-items');
  let es = false;
  try { es = sessionStorage.getItem('yuma-language') === 'es'; } catch {}
  const say = (en, sp) => (es ? sp : en);
  const money = cents => '$' + (Number(cents || 0) / 100).toFixed(2);
  const element = (tag, text, style) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (style) node.style.cssText = style; return node; };

  function frame() {
    document.documentElement.lang = es ? 'es' : 'en';
    $('#back-to-shop').textContent = say('Back to the collection ↗', 'Volver a la colección ↗');
  }

  function render(data) {
    es = data.language ? data.language === 'es' : es;
    frame();
    const test = data.mode === 'test';
    $('#checkout-mode').textContent = test ? say('YUMA · TEST CHECKOUT', 'YUMA · PAGO DE PRUEBA') : 'YUMA · CHECKOUT';
    title.textContent = data.paid
      ? (test ? say('Test payment confirmed.', 'Pago de prueba confirmado.') : say('Payment confirmed. Thank you!', '¡Pago confirmado! Gracias.'))
      : data.status === 'complete' ? say('Confirming your payment…', 'Confirmando tu pago…') : say('Your payment is not complete.', 'Tu pago todavía no se completó.');
    const notes = [];
    if (test) notes.push(say('This is a Stripe sandbox test. No real money was charged.', 'Esta es una prueba de Stripe. No se cobró dinero real.'));
    if (data.paid && data.email) notes.push(say(`We sent a confirmation to ${data.email}.`, `Te enviamos una confirmación a ${data.email}.`));
    else if (data.paid) notes.push(say('Thank you for your order.', 'Gracias por tu pedido.'));
    if (!data.paid && data.status === 'complete') notes.push(say('Some payment methods take a little longer. This page updates by itself.', 'Algunos medios de pago tardan un poco más. Esta página se actualiza sola.'));
    if (!data.paid && data.status !== 'complete') notes.push(say('No payment was taken. Your bag is still saved.', 'No se realizó ningún cobro. Tu bolsa sigue guardada.'));
    notes.push(say('Reference: ', 'Referencia: ') + data.reference);
    message.textContent = notes.join(' ');
    list.replaceChildren();
    for (const item of data.items || []) {
      const box = element('div', undefined, 'border-bottom:1px solid #d3d6c9;padding:14px 0');
      box.append(element('p', `${item.quantity} × ${(es ? item.name.es : item.name.en) || item.name.en} — ${money(item.lineTotal)}`, 'font-weight:600'));
      for (const line of (es ? item.details.es : item.details.en) || []) box.append(element('p', line, 'font-size:12px;color:#69705f;margin-top:3px;overflow-wrap:anywhere'));
      list.append(box);
    }
    const rows = [];
    if (data.items) {
      rows.push([say('Items', 'Productos'), money(data.subtotal)]);
      rows.push([data.delivery === 'pickup' ? say('Pickup in Katy, TX', 'Retiro en Katy, TX') : say('UPS shipping', 'Envío UPS'), data.shipping ? money(data.shipping) : say('Free', 'Gratis')]);
      if (data.discount) rows.push([say('Discount', 'Descuento'), '−' + money(data.discount)]);
      if (data.tax) rows.push([say('Tax', 'Impuestos'), money(data.tax)]);
    }
    rows.push([say('Total', 'Total'), money(data.total) + ' USD']);
    const totals = element('div', undefined, 'margin-top:18px');
    for (const [label, value] of rows) {
      const row = element('p', undefined, 'display:flex;justify-content:space-between;margin:6px 0');
      row.append(element('span', label), element('span', value));
      totals.append(row);
    }
    list.append(totals);
    if (data.paid && data.items) {
      list.append(element('p', data.delivery === 'pickup'
        ? say('Yuma will contact you to arrange your pickup in Katy, TX.', 'Yuma te escribirá para coordinar el retiro en Katy, TX.')
        : say('Each piece is made to order in up to 2 business days. UPS delivers in 3–5 business days and you will receive the tracking number.', 'Cada pieza se fabrica a pedido en hasta 2 días hábiles. UPS entrega en 3 a 5 días hábiles y recibirás el número de seguimiento.'), 'margin-top:18px;font-size:13px'));
    }
    const kinds = [...new Set((data.items || []).map(item => item.sendAfterPayment).filter(Boolean))];
    if (data.paid && kinds.length && data.whatsapp) {
      const what = kinds.map(kind => kind === 'photos' ? say('your photos (1 to 4, size 2 × 3)', 'tus fotos (de 1 a 4, tamaño 2 × 3)') : say('your logo', 'tu logo')).join(say(' and ', ' y '));
      const step = element('div', undefined, 'margin-top:20px;padding:16px;border:1px solid #c9b6d8;border-radius:12px;background:#f4eef8');
      step.append(element('p', say('One more step', 'Falta un paso'), 'font-weight:600'));
      step.append(element('p', say(`Send ${what} on WhatsApp to ${data.whatsapp} with your order number ${data.reference}. We start making your piece once we receive them.`, `Envía ${what} por WhatsApp al ${data.whatsapp} con tu número de pedido ${data.reference}. Empezamos a fabricar cuando los recibimos.`), 'margin-top:6px'));
      const link = element('a', say('Open WhatsApp ↗', 'Abrir WhatsApp ↗'), 'display:inline-block;margin-top:12px;padding:10px 16px;border-radius:999px;background:#343b31;color:#fff;text-decoration:none;font-weight:600');
      link.href = 'https://wa.me/' + data.whatsapp.replace(/\D/g, '') + '?text=' + encodeURIComponent(say(`Hi! Here are the files for my order ${data.reference}.`, `¡Hola! Te envío los archivos de mi pedido ${data.reference}.`));
      link.target = '_blank'; link.rel = 'noopener';
      step.append(link);
      list.append(step);
    }
    if (data.paid) {
      try { sessionStorage.removeItem('yuma-demo-bag'); sessionStorage.removeItem('yuma-checkout-attempt'); } catch {}
    }
  }

  async function load(attempt = 0) {
    const id = new URLSearchParams(location.search).get('session_id');
    if (!/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(id || '')) throw new Error(say('No valid checkout reference was provided.', 'No hay una referencia de pago válida.'));
    const response = await fetch('/api/checkout/result?session_id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((es && data.error_es) || data.error || say('We could not verify this payment.', 'No pudimos verificar este pago.'));
    render(data);
    // Delayed methods: poll for a short while until Stripe confirms the payment.
    if (!data.paid && data.status === 'complete' && attempt < 15) setTimeout(() => load(attempt + 1).catch(fail), 3000);
  }

  function fail(error) {
    title.textContent = say('We could not verify this payment.', 'No pudimos verificar este pago.');
    message.textContent = error.message + ' ' + say('If you were charged, email yuma3dstudio@gmail.com with your receipt.', 'Si se realizó un cobro, escribe a yuma3dstudio@gmail.com con tu recibo.');
  }

  frame();
  title.textContent = say('Checking your payment…', 'Comprobando tu pago…');
  load().catch(fail);
})();
