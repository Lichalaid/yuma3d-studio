// Cloudflare Worker entry point. Keep ONLY the default export in this file: Workers treat every
// named export of the main module as an entrypoint and refuse to start on anything else.
// The checkout logic lives in ./checkout.js.
import { handleRequest } from './checkout.js';

export default { fetch: handleRequest };
