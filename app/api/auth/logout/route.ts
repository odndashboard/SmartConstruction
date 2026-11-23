import { z } from 'zod';
import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { CRMError } from '@/lib/server-actions';
import { clearPasswordSetup } from '@/lib/password-setup';

export async function POST(request: Request) {
  try {
    await readAuthInput(request, z.object({}).strict());
    await clearPasswordSetup();
    const client = await createAuthClient();
    const { error } = await client.auth.signOut({ scope: 'local' });
    if (error) throw new CRMError('Sign-out could not be completed. Please try again.', 503);
    return authResponse({ redirect: '/login' });
  } catch (error) { return authError(error); }
}
