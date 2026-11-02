import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateCart,createSession,verifySignature,handleApi} from '../dist/server/index.js';
const nonce='12345678-1234-4234-8234-123456789abc';
const sample=()=>({nonce,language:'en',delivery:'ship',items:[{productId:'initial-name',quantity:1,price:1,options:{designId:'none',colors:{baseColor:'blue',detailColor:'white'},text:{initial:'e',name:'Emma'},font:'Allura'}},{productId:'name-accessory-keychain',quantity:2,options:{colors:{baseColor:'pink',detailColor:'white','charm':'blue','charm-details':'white'},text:{name:'Rose'},font:'Cookie'}}]});
test('server calculates prices, quantities and one shipping fee',()=>{const p=sample();const order=validateCart(p);assert.equal(order.subtotal,5100);assert.equal(order.shipping,0);assert.equal(order.total,5100);assert.equal(order.items[0].text.initial,'E');p.items.pop();assert.equal(validateCart(p).total,3999);p.delivery='pickup';assert.equal(validateCart(p).total,3500);});
test('missing data, altered colors, unknown quotes and unpriced accessories are rejected',()=>{let p=sample();p.items[0].options.text.name='';assert.throws(()=>validateCart(p));p=sample();p.items[0].options.colors.baseColor='not-offered';assert.throws(()=>validateCart(p));p=sample();p.items[0].quantity=0;assert.throws(()=>validateCart(p));p=sample();p.items[0].productId='photo-frame';assert.throws(()=>validateCart(p));p=sample();p.items[0].options.designId='birth';assert.throws(()=>validateCart(p));});
test('one Checkout Session contains both products and retries are idempotent',async()=>{const calls=[];const stripe={request:async(...args)=>{calls.push(args);return{id:'cs_test_unit',url:'https://checkout.stripe.com/c/pay/cs_test_unit',livemode:false};}};const p=sample();const a=await createSession(p,'https://example.com','visitor',stripe);const b=await createSession(p,'https://example.com','visitor',stripe);assert.equal(a.total,5100);assert.equal(calls[0][2].line_items.length,2);assert.equal(calls[0][2].line_items[0].price_data.unit_amount,3500);assert.equal(calls[0][2].line_items[1].quantity,2);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0][2].metadata.format,'yuma-gzip-v1');assert.ok(Object.values(calls[0][2].metadata).every(v=>v.length<=500));});
test('foreign origin and live credentials cannot activate this sandbox integration',async()=>{const r=await handleApi(new Request('https://example.com/api/checkout/status'),{STRIPE_SECRET_KEY:'sk_live_example',STRIPE_ACCOUNT_ID:'acct_live'});assert.equal((await r.json()).configured,false);await assert.rejects(()=>handleApi(new Request('https://example.com/api/checkout',{method:'POST',headers:{Origin:'https://wrong.example','Content-Type':'application/json',Cookie:'yuma_checkout='+nonce},body:JSON.stringify(sample())}),{}),e=>e.status===403);});
test('webhook checks signature and five minute replay tolerance',async()=>{const raw='{"id":"evt_test"}',secret='whsec_unit',stamp=Math.floor(Date.now()/1000);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(stamp+'.'+raw))),b=>b.toString(16).padStart(2,'0')).join('');assert.equal(await verifySignature(raw,`t=${stamp},v1=${signature}`,secret),true);assert.equal(await verifySignature(raw,`t=${stamp},v1=${signature}`,secret,Date.now()+400000),false);assert.equal(await verifySignature(raw+'x',`t=${stamp},v1=${signature}`,secret),false);});
test('live activation requires Yuma, a matching mode, webhook, email and explicit enablement',async()=>{
 const config={STRIPE_MODE:'live',CHECKOUT_ENABLED:'true',STRIPE_ACCOUNT_ID:'acct_1UVgaICbK0UdCU0G',STRIPE_SECRET_KEY:'rk_live_unit',STRIPE_WEBHOOK_SECRET:'whsec_unit',ORDER_EMAIL_API_KEY:'unit',ORDER_EMAIL_FROM:'orders@example.com'};
 const status=async env=>(await handleApi(new Request('https://example.com/api/checkout/status'),env)).json();
 assert.equal((await status(config)).configured,true);
 for(const key of ['CHECKOUT_ENABLED','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','ORDER_EMAIL_API_KEY','ORDER_EMAIL_FROM']){const env={...config};delete env[key];assert.equal((await status(env)).configured,false,key);}
 assert.equal((await status({...config,STRIPE_ACCOUNT_ID:'acct_unrelated'})).configured,false);
 assert.equal((await status({...config,STRIPE_SECRET_KEY:'rk_test_unit'})).configured,false);
 await assert.rejects(()=>handleApi(new Request('https://example.com/api/checkout',{method:'POST',headers:{Origin:'https://example.com',Cookie:'yuma_checkout='+nonce}}),{}),e=>e.status===503);
});
test('session creation verifies the expected live or test mode',async()=>{
 const live={request:async()=>({id:'cs_live_unit',url:'https://checkout.stripe.com/c/pay/cs_live_unit',livemode:true})};
 assert.equal((await createSession(sample(),'https://example.com','visitor',live,'live')).id,'cs_live_unit');
 await assert.rejects(()=>createSession(sample(),'https://example.com','visitor',live,'test'),e=>e.status===502);
});
test('paid webhook emails the full personalization and does not notify twice',async()=>{
 const lastHandle='FINAL_PROFILE_'+('z'.repeat(100));
 const input={nonce,language:'en',delivery:'pickup',items:[{productId:'social-nfc-keychain',quantity:1,options:{colors:{baseColor:'blue',detailColor:'white'},profiles:Array.from({length:10},(_,i)=>({network:'Social '+i,handle:i===9?lastHandle:'profile_'+i+'x'.repeat(100)}))}}]};
 let session;
 await createSession(input,'https://example.com','visitor',{request:async(method,path,values)=>{session={id:'cs_test_fullorder',url:'https://checkout.stripe.com/c/pay/cs_test_fullorder',livemode:false,metadata:values.metadata,payment_status:'paid',amount_total:1500,currency:'usd'};return session;}});
 const originalFetch=globalThis.fetch, emails=[];
 globalThis.fetch=async(url,options={})=>{
  if(url==='https://api.resend.com/emails'){emails.push(JSON.parse(options.body));return Response.json({id:'email_unit'});}
  if(url==='https://api.stripe.com/v1/account')return Response.json({id:'acct_1UVZa22S141stGeG'});
  if(url==='https://api.stripe.com/v1/checkout/sessions/'+session.id){if(options.method==='POST'){const values=new URLSearchParams(options.body);for(const key of ['payment_verified','notification_sent'])if(values.has('metadata['+key+']'))session.metadata[key]=values.get('metadata['+key+']');}return Response.json(session);}
  throw new Error('Unexpected transport: '+url);
 };
 try{
  const raw=JSON.stringify({id:'evt_unit',livemode:false,type:'checkout.session.completed',data:{object:{id:session.id}}});
  const stamp=Math.floor(Date.now()/1000),secret='whsec_unit';
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(stamp+'.'+raw))),b=>b.toString(16).padStart(2,'0')).join('');
  const env={STRIPE_MODE:'test',STRIPE_SECRET_KEY:'rk_test_unit',STRIPE_ACCOUNT_ID:'acct_1UVZa22S141stGeG',STRIPE_WEBHOOK_SECRET:secret,ORDER_EMAIL_API_KEY:'unit',ORDER_EMAIL_FROM:'orders@example.com'};
  const request=()=>new Request('https://example.com/api/stripe/webhook',{method:'POST',headers:{'Stripe-Signature':`t=${stamp},v1=${signature}`},body:raw});
  assert.equal((await handleApi(request(),env)).status,200);
  assert.ok(emails[0].text.includes(lastHandle));
  assert.deepEqual(emails[0].to,['yuma3dstudio@gmail.com']);
  assert.equal((await handleApi(request(),env)).status,200);
  assert.equal(emails.length,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('original catalog prices, chosen font, plain cooler and removed design are authoritative',()=>{const p=sample();const order=validateCart(p);assert.equal(order.items[0].nameFont,'Allura');assert.equal(order.items[0].initialFont,'Al Bayan');assert.equal(order.items[0].unitAmount,3500);p.items[1].quantity=3;assert.equal(validateCart(p).shipping,0);p.items[0].options.font='unknown';assert.throws(()=>validateCart(p),/font/);p.items=[{productId:'raised-name-keychain',quantity:1,options:{}}];assert.throws(()=>validateCart(p),/quote/);p.items=[{productId:'personalized-can-cooler',quantity:1,options:{}}];assert.equal(validateCart(p).items[0].unitAmount,3000);});
test('different displayed discounts retain the catalog selling prices',()=>{
 const priced=JSON.parse(readFileSync(new URL('../catalog-products.json',import.meta.url),'utf8')).filter(product=>product.discount_percent>0);
 assert.ok(new Set(priced.map(product=>product.discount_percent)).size>1);
 for(const product of priced){assert.ok(product.compare_at_cents>product.price_cents);assert.equal(product.discount_percent,Math.round(100*(product.compare_at_cents-product.price_cents)/product.compare_at_cents));}
 assert.equal(priced.find(product=>product.id==='initial-name').price_cents,3500);
 assert.equal(priced.find(product=>product.id==='social-display').price_cents,6000);
 assert.equal(JSON.parse(readFileSync(new URL('../catalog-products.json',import.meta.url),'utf8')).find(p=>p.id==='photo-frame').price_cents,3500);
});

test('built storefronts use the current canonical catalog, including the photo frame price',()=>{
 const catalog=JSON.parse(readFileSync(new URL('../catalog-products.json',import.meta.url),'utf8'));
 for(const path of ['../storefront/index.html','../storefront/products/photo-frame/index.html']){
  const page=readFileSync(new URL(path,import.meta.url),'utf8');
  const embedded=JSON.parse(page.match(/<script id="catalog-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(embedded,catalog);
  assert.equal(embedded.find(p=>p.id==='photo-frame').price_cents,3500);
 }
});

test('all three Christmas sets cost $10 and require their own piece colors',()=>{
 const product=JSON.parse(readFileSync(new URL('../catalog-products.json',import.meta.url),'utf8')).find(p=>p.id==='christmas-sets');
 assert.equal(product.personalization.design_options.length,3);
 for(const design of product.personalization.design_options){
  const input={nonce,language:'en',delivery:'pickup',items:[{productId:product.id,quantity:1,options:{designId:design.id,colors:Object.fromEntries(design.color_fields.map(p=>[p.key,'green']))}}]};
  const order=validateCart(input);assert.equal(order.total,1000);assert.equal(order.items[0].designId,design.id);
  delete input.items[0].options.colors[design.color_fields.at(-1).key];assert.throws(()=>validateCart(input));
 }
});

test('charm keychain accepts exactly two distinct solid colors',()=>{
 const input={nonce,language:'en',delivery:'pickup',items:[{productId:'charms-keychain',quantity:1,options:{colors:{baseColor:'purple',detailColor:'white',flower:'red'},text:{name:'Laura'},font:'Cookie'}}]};
 const order=validateCart(input);assert.equal(order.total,1500);assert.deepEqual(order.items[0].colors,{baseColor:'purple',detailColor:'white'});
 input.items[0].options.colors.detailColor='purple';assert.throws(()=>validateCart(input));
 input.items[0].options.colors.detailColor='rainbow';assert.throws(()=>validateCart(input));
});
