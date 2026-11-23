import 'server-only';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CRMError } from './server-actions';
import { createPasswordSetupGrant, PASSWORD_SETUP_TTL_SECONDS, verifyPasswordSetupGrant } from './password-setup-policy';

const secure = process.env.NODE_ENV === 'production';
const cookieName = secure ? '__Host-sc-password-setup' : 'sc-password-setup';
const options = { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' };
function signingKey(): string {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new CRMError('Password setup is temporarily unavailable. Contact your owner.', 503);
  return key;
}
async function verifiedSessionId(client: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await client.auth.getClaims();
  if (error || data?.claims.sub !== userId || typeof data.claims.session_id !== 'string') {
    throw new CRMError('Your account link session could not be verified. Open a fresh account link.', 403);
  }
  return data.claims.session_id;
}
/** Call only after verifyOtp succeeded and active CRM membership was checked. */
export async function grantPasswordSetup(client: SupabaseClient, userId: string): Promise<void> {
  const sessionId = await verifiedSessionId(client, userId);
  const token = createPasswordSetupGrant(userId, sessionId, signingKey());
  (await cookies()).set(cookieName, token, { ...options, maxAge: PASSWORD_SETUP_TTL_SECONDS });
}
export async function requirePasswordSetup(client: SupabaseClient, userId: string): Promise<void> {
  const sessionId = await verifiedSessionId(client, userId);
  if (!verifyPasswordSetupGrant((await cookies()).get(cookieName)?.value, userId, sessionId, signingKey())) {
    throw new CRMError('Open a fresh private account link to set your password, or use Settings → Account security to change it.', 403);
  }
}
export async function clearPasswordSetup(): Promise<void> {
  (await cookies()).set(cookieName, '', { ...options, maxAge: 0, expires: new Date(0) });
}
