import { handleRequest } from './checkout.js';
import { handleAdmin } from './admin.js';

// Cloudflare Workers entry. The main module may only export handlers (see CHECKOUT-STRIPE.md).
export default {
  fetch: (request, env) => (new URL(request.url).pathname.startsWith('/api/admin/') ? handleAdmin(request, env) : handleRequest(request, env)),
};
