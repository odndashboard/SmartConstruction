import 'server-only';
import { CRMError } from '../server-actions';
import { configuredAppOrigin, isPublicSupabaseKey } from '../auth-policy';

export function isWorkspaceConfigured(): boolean {
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL &&
    publicKey && isPublicSupabaseKey(publicKey) &&
    (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) && process.env.APP_URL);
}

export function publicSupabaseConfig(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new CRMError('This workspace is still being connected. Please contact the owner.', 503);
  if (!isPublicSupabaseKey(key)) throw new CRMError('The workspace connection needs to be reviewed by its owner.', 503);
  return { url, key };
}

/** A configured origin prevents Host-header poisoning in account setup links. */
export function appOrigin(): string {
  const value = process.env.APP_URL;
  if (!value) throw new CRMError('This workspace is still being connected. Please contact the owner.', 503);
  try {
    return configuredAppOrigin(value, process.env.NODE_ENV === 'production');
  } catch {
    throw new CRMError('The workspace address needs to be configured by its owner.', 503);
  }
}
