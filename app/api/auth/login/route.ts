import { z } from 'zod';
import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { getWorkspace, CRMError } from '@/lib/server';

export const dynamic = 'force-dynamic';
const schema = z.object({ email: z.string().trim().email('Enter a valid email address.').max(254), password: z.string().min(1, 'Enter your password.').max(256) }).strict();

export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request, schema);
    const client = await createAuthClient();
    const { error } = await client.auth.signInWithPassword(input);
    if (error) throw new CRMError(error.status === 429 ? 'Too many sign-in attempts. Wait a moment and try again.' : 'The email or password is incorrect, or this account is not ready yet.', error.status === 429 ? 429 : 401);
    try { await getWorkspace(); }
    catch (workspaceError) {
      await client.auth.signOut({ scope: 'local' });
      if (!(workspaceError instanceof CRMError) || workspaceError.status !== 403) throw workspaceError;
      throw new CRMError('This account does not have active access to this workspace. Contact your workspace owner.', 403);
    }
    return authResponse({ redirect: '/' });
  } catch (error) { return authError(error); }
}
