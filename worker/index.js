/* Server-only Stripe checkout. Static content is embedded at build. */
const FILES = __STATIC_FILES__;
const PRODUCTS = __CATALOG__;
const enc = new TextEncoder();
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers: {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))), b=>b.toString(16).padStart(2,'0')).join('');
const cookieValue = request => request.headers.get('Cookie')?.match(/(?:^|;\s*)yuma_checkout=([a-f0-9-]{36})/)?.[1];
const newCookie = value => `yuma_checkout=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
function formValues(value, key, out) {
  if(value === undefined || value === null) return;
  if(Array.isArray(value)) value.forEach((v,i)=>formValues(v,`${key}[${i}]`,out));
  else if(typeof value === 'object') Object.entries(value).forEach(([k,v])=>formValues(v,key?`${key}[${k}]`:k,out));
  else out.append(key,String(value));
}
export class StripeClient {
  constructor(key, transport = fetch) {this.key=key;this.transport=transport;}
  async request(method, path, values, idempotency) {
    const params=new URLSearchParams();formValues(values,'',params);
    const headers={Authorization:`Bearer ${this.key}`,'Stripe-Version':'2026-09-30.endive'};
    if(idempotency)headers['Idempotency-Key']=idempotency;
    if(method==='POST')headers['Content-Type']='application/x-www-form-urlencoded';
    const response=await this.transport('https://api.stripe.com/v1'+path+(method==='GET'&&params.size?'?'+params.toString():''),{method,headers,...(method==='POST'?{body:params.toString()}:{})});
    const body=await response.json();
    if(!response.ok)throw fail('Stripe could not process this request. Please try again.',502);
    return body;
  }
}
const YUMA_ACCOUNTS={test:'acct_1UVZa22S141stGeG',live:'acct_1UVgaICbK0UdCU0G'};
const NAME_FONTS=new Set(['Allura','Lobster','Chevy','Cookie','Satisfy']);
function checkoutConfig(env) {
  const mode=env.STRIPE_MODE==='live'?'live':'test';
  const keyConfigured=new RegExp('^(?:sk|rk)_'+mode+'_[A-Za-z0-9]+$').test(env.STRIPE_SECRET_KEY||'');
  const merchantConfigured=env.STRIPE_ACCOUNT_ID===YUMA_ACCOUNTS[mode];
  const webhookConfigured=/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET||'');
  const emailConfigured=Boolean(env.ORDER_EMAIL_API_KEY&&env.ORDER_EMAIL_FROM);
  return {mode,keyConfigured,merchantConfigured,webhookConfigured,emailConfigured,configured:env.CHECKOUT_ENABLED==='true'&&keyConfigured&&merchantConfigured&&webhookConfigured&&emailConfigured};
}
function merchantClient(env) {
  const config=checkoutConfig(env);
  if(!config.keyConfigured||!config.merchantConfigured)throw fail('Payments are not configured yet.',503);
  return new StripeClient(env.STRIPE_SECRET_KEY);
}
async function checkedClient(env) {
  const stripe=merchantClient(env);
  const account=await stripe.request('GET','/account');
  if(account.id!==env.STRIPE_ACCOUNT_ID)throw fail('The merchant account does not match this store.',503);
  if(env.STRIPE_MODE==='live'&&!account.charges_enabled)throw fail('The merchant account cannot accept payments yet.',503);
  return stripe;
}
function cleanText(value, max=80) {
  if(typeof value!=='string')throw fail('Complete the required personalization fields.');
  const text=value.trim();
  if(!text||Array.from(text).length>max||/[\u0000-\u001f]/.test(text))throw fail('Check the personalization text.');
  return text;
}
export function validateCart(input) {
  if(!input||!Array.isArray(input.items)||!input.items.length||input.items.length>30)throw fail('Choose between 1 and 30 items.');
  if(!['ship','pickup'].includes(input.delivery))throw fail('Choose shipping or pickup.');
  if(!/^[a-f0-9-]{36}$/i.test(input.nonce||''))throw fail('Refresh the checkout and try again.');
  const language=input.language==='es'?'es':'en';
  const items=input.items.map(item=>{
    const product=PRODUCTS.find(p=>p.id===item.productId);
    if(!product||product.price_cents===null)throw fail('This product needs a quote before payment.');
    if(product.personalization.type==='photos')throw fail('Send the photos to Yuma before ordering this design.');
    if(!Number.isInteger(item.quantity)||item.quantity<1||item.quantity>10)throw fail('Choose a quantity from 1 to 10.');
    const config=product.personalization, draft=item.options||{};
    const design=config.design_options?.find(d=>d.id===draft.designId);
    if(config.design_options&&!design)throw fail('Choose the design for this product.');
    if(product.id==='initial-name'&&!['none','stars'].includes(design.id))throw fail('Please request a quote for this accessory before payment.');
    const parts=design?.color_fields||config.color_fields;
    const values={};for(const part of parts){if(!config.colors.includes(draft.colors?.[part.key]))throw fail('Choose a color for every part.');values[part.key]=draft.colors[part.key];}
    if(config.color_mode==='bicolor'&&values.baseColor===values.detailColor)throw fail('Choose two different colors.');
    const fields=[...(config.text_fields||[]),...(design?.extra_text_fields||[])];
    const text={};for(const field of fields){const value=cleanText(draft.text?.[field.key],field.max_length||80);if(field.kind==='initial'&&!/^\p{L}$/u.test(value))throw fail('Enter one initial.');if(field.kind==='name'&&!/^\p{L}[\p{L}\p{M}\s’'\-]*$/u.test(value))throw fail('Check the name.');text[field.key]=field.kind==='initial'?value.toLocaleUpperCase():value;}
    const hasName=fields.some(field=>['name','first-name','second-name'].includes(field.key));
    if(hasName&&!NAME_FONTS.has(draft.font))throw fail('Choose a name font.');
    let profiles;
    if(config.type==='social'){
      if(!Array.isArray(draft.profiles)||!draft.profiles.length||draft.profiles.length>10)throw fail('Check the social profiles.');
      profiles=draft.profiles.map(p=>({network:cleanText(p.network,80),handle:cleanText(p.handle,120)}));
    }
    return {productId:product.id,name:product.name[language],unitAmount:product.price_cents,quantity:item.quantity,colors:values,text,...(hasName?{nameFont:draft.font,...(product.id==='initial-name'?{initialFont:'Al Bayan'}:{})}:{}),...(design?{designId:design.id,design:design.label[language]}:{}),...(profiles?{profiles}:{} )};
  });
  const subtotal=items.reduce((sum,item)=>sum+item.unitAmount*item.quantity,0);
  const shipping=input.delivery==='pickup'||subtotal>=5000?0:499;
  return {version:1,language,delivery:input.delivery,items,subtotal,shipping,total:subtotal+shipping};
}
async function encodeOrder(order) {
  const bytes=enc.encode(JSON.stringify(order));
  if(bytes.length>30000)throw fail('This order has too much personalization. Contact Yuma.');
  const compressed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary='';for(const byte of compressed)binary+=String.fromCharCode(byte);
  const value=btoa(binary), metadata={format:'yuma-gzip-v1'};
  const chunks=Math.ceil(value.length/450);
  if(chunks>40)throw fail('This order has too much personalization. Contact Yuma.');
  metadata.chunks=String(chunks);for(let i=0;i<chunks;i++)metadata['design_'+i]=value.slice(i*450,(i+1)*450);
  return metadata;
}
async function decodeOrder(metadata) {
  if(metadata?.format!=='yuma-gzip-v1'||!/^\d{1,2}$/.test(metadata.chunks))throw fail('Order details are unavailable.',502);
  const count=Number(metadata.chunks);if(count<1||count>40)throw fail('Order details are invalid.',502);
  const binary=atob(Array.from({length:count},(_,i)=>metadata['design_'+i]||'').join(''));
  const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const text=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  if(text.length>30000)throw fail('Order details are invalid.',502);
  return JSON.parse(text);
}
function itemDescription(item) {
  return [Object.entries(item.text).map(([k,v])=>`${k}: ${v}`).join(' · '),item.nameFont&&`name font: ${item.nameFont}`,item.initialFont&&`initial font: ${item.initialFont}`,item.design,Object.entries(item.colors).map(([k,v])=>`${k}: ${v}`).join(' · '),item.profiles?.map(p=>`${p.network}: ${p.handle}`).join(' · ')].filter(Boolean).join(' · ').slice(0,500);
}
export async function createSession(input, origin, visitor, stripe, mode='test') {
  const order=validateCart(input);
  const owner=await digest(visitor), metadata=await encodeOrder(order);
  const fingerprint=await digest(JSON.stringify(order)+owner+input.nonce);
  metadata.owner=owner;metadata.order_ref='YM-'+fingerprint.slice(0,20);
  const integration='yuma_cart_'+Array.from(fingerprint.slice(0,8),v=>String.fromCharCode(97+parseInt(v,16))).join('');
  const request={mode:'payment',locale:order.language,success_url:origin+'/checkout-result/?session_id={CHECKOUT_SESSION_ID}',cancel_url:origin+'/?checkout=cancelled#shop',client_reference_id:metadata.order_ref,integration_identifier:integration,metadata,
    line_items:order.items.map(item=>({quantity:item.quantity,price_data:{currency:'usd',unit_amount:item.unitAmount,product_data:{name:item.name,description:itemDescription(item),metadata:{product_id:item.productId}}}})),
    shipping_options:[{shipping_rate_data:{type:'fixed_amount',fixed_amount:{amount:order.shipping,currency:'usd'},display_name:order.delivery==='pickup'?'Pickup · Katy, TX':order.shipping?'UPS shipping':'Free shipping'}}]};
  if(order.delivery==='ship')request.shipping_address_collection={allowed_countries:['US','PR']};
  const session=await stripe.request('POST','/checkout/sessions',request,'yuma-'+fingerprint);
  if(session.livemode!==(mode==='live')||!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(session.id||'')||!/^https:\/\/checkout\.stripe\.com\//.test(session.url||''))throw fail('The checkout could not be verified.',502);
  return {url:session.url,id:session.id,total:order.total};
}
function signatureBytes(hex) {
  if(!/^[a-f0-9]{64}$/i.test(hex))return new Uint8Array();
  return Uint8Array.from(hex.match(/../g),v=>parseInt(v,16));
}
export async function verifySignature(raw, header, secret, now=Date.now()) {
  if(!secret||!header)return false;
  const values=header.split(',').map(p=>p.split('=')), timestamp=values.find(p=>p[0]==='t')?.[1];
  if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300)return false;
  const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  for(const pair of values.filter(p=>p[0]==='v1'))if(await crypto.subtle.verify('HMAC',key,signatureBytes(pair[1]),enc.encode(timestamp+'.'+raw)))return true;
  return false;
}
async function webhook(request, env) {
  const raw=await request.text();if(raw.length>1024*1024)throw fail('Request too large.',413);
  if(!await verifySignature(raw,request.headers.get('Stripe-Signature'),env.STRIPE_WEBHOOK_SECRET))throw fail('Invalid webhook signature.',400);
  const event=JSON.parse(raw);
  const mode=checkoutConfig(env).mode;
  if(event.livemode!==(mode==='live'))throw fail('Unexpected payment mode.',400);
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type))return json({received:true});
  if(!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(event.data?.object?.id||''))throw fail('Invalid checkout reference.');
  const stripe=await checkedClient(env), session=await stripe.request('GET','/checkout/sessions/'+encodeURIComponent(event.data.object.id));
  if(session.livemode!==(mode==='live'))throw fail('Unexpected payment mode.',400);
  if(session.payment_status!=='paid')return json({received:true,paid:false});
  const order=await decodeOrder(session.metadata);
  if(session.amount_total!==order.total||session.currency!=='usd')throw fail('Order total mismatch.',409);
  if(session.metadata.notification_sent==='true')return json({received:true});
  // Stripe retains the complete order snapshot; mark verified delivery independently of the return page.
  await stripe.request('POST','/checkout/sessions/'+encodeURIComponent(session.id),{metadata:{payment_verified:'true'}});
  if(!env.ORDER_EMAIL_API_KEY||!env.ORDER_EMAIL_FROM)throw fail('Order saved in Stripe; notification service is pending.',503);
  const lines=order.items.map(item=>`${item.quantity} × ${item.name} · $${(item.unitAmount*item.quantity/100).toFixed(2)} USD\n${itemDescription(item)}`);
  const notification=[mode==='test'?'SANDBOX TEST ORDER':'PAID ORDER',session.metadata.order_ref,...lines,`Delivery: ${order.delivery}`,`Shipping: $${(order.shipping/100).toFixed(2)} USD`,`Total: $${(order.total/100).toFixed(2)} USD`,JSON.stringify({order,customer:session.customer_details,shipping:session.collected_information?.shipping_details||session.shipping_details},null,2)].join('\n\n');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.ORDER_EMAIL_API_KEY,'Content-Type':'application/json','Idempotency-Key':'yuma-order-'+session.id},body:JSON.stringify({from:env.ORDER_EMAIL_FROM,to:['yuma3dstudio@gmail.com'],subject:'Yuma · '+(mode==='test'?'Test order ':'Paid order ')+session.metadata.order_ref,text:notification})});
  if(!response.ok)throw fail('Order notification will be retried.',503);
  await stripe.request('POST','/checkout/sessions/'+encodeURIComponent(session.id),{metadata:{notification_sent:'true'}});
  return json({received:true});
}
export async function handleApi(request,env) {
  const url=new URL(request.url), visitor=cookieValue(request);
  if(url.pathname==='/api/checkout/status'&&request.method==='GET'){
    const {configured,mode,webhookConfigured,emailConfigured}=checkoutConfig(env);
    return json({configured,mode,webhookConfigured,emailConfigured},200,visitor?{}:{'Set-Cookie':newCookie(crypto.randomUUID())});
  }
  if(url.pathname==='/api/stripe/webhook'&&request.method==='POST')return webhook(request,env);
  if(url.pathname==='/api/checkout'&&request.method==='POST'){
    if(request.headers.get('Origin')!==url.origin||!visitor)throw fail('Reload the page before checking out.',403);
    if(!checkoutConfig(env).configured)throw fail('Online payments are not available yet. Please contact Yuma.',503);
    if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw fail('Send a JSON request.',415);
    const raw=await request.text();if(raw.length>40000)throw fail('Order too large.',413);
    let input;try{input=JSON.parse(raw);}catch{throw fail('Invalid request.');}
    validateCart(input); // Reject invalid requests before calling Stripe.
    const stripe=await checkedClient(env);
    return json(await createSession(input,url.origin,visitor,stripe,checkoutConfig(env).mode));
  }
  if(url.pathname==='/api/checkout/result'&&request.method==='GET'){
    if(!visitor)throw fail('Open this order in the browser used for checkout.',403);
    const mode=checkoutConfig(env).mode;
    const id=url.searchParams.get('session_id');if(!new RegExp('^cs_'+mode+'_[A-Za-z0-9]+$').test(id||''))throw fail('Invalid checkout reference.');
    const stripe=await checkedClient(env),session=await stripe.request('GET','/checkout/sessions/'+encodeURIComponent(id));
    if(session.livemode!==(mode==='live')||session.metadata?.owner!==await digest(visitor))throw fail('Order not found.',404);
    const order=await decodeOrder(session.metadata);
    if(session.amount_total!==order.total||session.currency!=='usd')throw fail('Order total mismatch.',409);
    return json({paid:session.payment_status==='paid',mode,status:session.status,total:session.amount_total,currency:session.currency,reference:session.metadata.order_ref,order});
  }
  return json({error:'Not found'},404);
}
function assetResponse(path,request) {
  const file=FILES[path];if(!file)return null;
  const headers={'Content-Type':file.type,'Cache-Control':path.startsWith('/assets/')?'public, max-age=86400':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
  if(request.method==='HEAD')return new Response(null,{headers});
  const binary=atob(file.data),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Response(bytes,{headers});
}
export default {async fetch(request,env){
  try{
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/'))return await handleApi(request,env);
    if(!['GET','HEAD'].includes(request.method))return json({error:'Method not allowed'},405);
    const path=url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname;
    const exact=assetResponse(path,request);if(exact)return exact;
    if(FILES[url.pathname+'/index.html'])return Response.redirect(url.origin+url.pathname+'/',308);
    return new Response(assetResponse('/404.html',request)?.body||'Not found',{status:404,headers:{'Content-Type':'text/html; charset=utf-8'}});
  }catch(error){return json({error:error.status?error.message:'The request could not be completed.'},error.status||500);}
}};
