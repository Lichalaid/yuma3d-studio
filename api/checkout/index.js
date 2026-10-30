// Vercel Function. All the logic lives in worker/checkout.js (shared with Cloudflare Workers).
import { handleRequest } from '../../worker/checkout.js';
import { vercelHandler } from '../../worker/vercel.js';

export default vercelHandler(handleRequest);
