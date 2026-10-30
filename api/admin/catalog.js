// Vercel Function for the admin panel. All the logic lives in worker/admin.js.
import { handleAdmin } from '../../worker/admin.js';
import { vercelHandler } from '../../worker/vercel.js';

export default vercelHandler(handleAdmin);
