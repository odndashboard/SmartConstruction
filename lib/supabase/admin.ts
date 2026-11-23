import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { CRMError } from '../server-actions';
import { publicSupabaseConfig } from './config';

/** Never attach request cookies to this client or import it into a Client Component. */
export function createAdminClient() {
  const { url } = publicSupabaseConfig();
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new CRMError('This workspace is still being connected. Please contact the owner.', 503);
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
}
