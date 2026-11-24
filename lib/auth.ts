import 'server-only';
import { createAuthClient } from './supabase/server';
import { CRMError } from './server-actions';
import { assertReadActive } from './server-read';

export interface AuthIdentity { userId: string; displayName: string; email: string; }

/** getUser verifies with Supabase Auth; cookie contents alone never authorize. */
export async function authenticate(signal?: AbortSignal): Promise<AuthIdentity> {
  assertReadActive(signal);
  const client = await createAuthClient({ signal });
  const { data: { user }, error } = await client.auth.getUser();
  assertReadActive(signal);
  if (error && ((error.status ?? 0) >= 500 || error.name === 'AuthRetryableFetchError')) {
    throw new CRMError('The sign-in service is temporarily unavailable. Please try again shortly.', 503);
  }
  if (error || !user) throw new CRMError('Please sign in to your workspace.', 401);
  if (!user.email || !user.email_confirmed_at || user.is_anonymous) {
    throw new CRMError('Use the private account setup link supplied by your workspace owner.', 403);
  }
  const name = typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.trim().slice(0, 200) : '';
  return { userId: user.id, displayName: name || user.email.split('@')[0], email: user.email };
}
