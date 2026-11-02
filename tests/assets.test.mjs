import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../dist/server/index.js';
const products=JSON.parse(readFileSync(new URL('../catalog-products.json',import.meta.url),'utf8'));
test('every catalog photo is served with its exact original bytes',async()=>{
 for(const path of new Set(products.flatMap(p=>p.images))){
  const response=await worker.fetch(new Request('https://example.com/'+path+'?image_retry=1'),{});
  assert.equal(response.status,200,path);
  assert.match(response.headers.get('content-type'),/^image\//,path);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),readFileSync(new URL('../storefront/'+path,import.meta.url)),path);
 }
});
