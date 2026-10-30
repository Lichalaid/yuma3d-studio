/*
 * Vercel Functions adapter. Vercel's Node runtime builds request.url from the Host header with
 * "http://" (it ignores x-forwarded-proto), so behind https the origin would not match the browser's
 * Origin header and the cookies would lose "Secure". The edge sets x-forwarded-proto/-host: use them.
 */
export async function vercelRequest(request) {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const host = request.headers.get('x-forwarded-host')?.split(',')[0].trim();
  if (proto === 'https' || proto === 'http') url.protocol = proto + ':';
  if (host && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) url.host = host;
  if (url.href === request.url) return request;
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  return new Request(url, { method: request.method, headers: request.headers, body: hasBody ? await request.arrayBuffer() : undefined });
}

/** `export default vercelHandler(handler)` in api/*.js — handler(request, env). */
export function vercelHandler(handler) {
  return { fetch: async request => handler(await vercelRequest(request), process.env) };
}
