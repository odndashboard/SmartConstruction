import { z } from 'zod';
import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { getWorkspace, CRMError } from '@/lib/server';

const schema = z.object({ password: z.string().min(12, 'Use at least 12 characters for your password.').max(128, 'Use no more than 128 characters.'), confirmPassword: z.string() }).strict().refine(v => v.password === v.confirmPassword, 'The passwords do not match.');
export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request, schema);
    await getWorkspace();
    const client = await createAuthClient();
    const { error } = await client.auth.updateUser({ password: input.password });
    if (error) throw new CRMError(error.code === 'same_password' ? 'Choose a password different from your current password.' : 'The password could not be updated. Use a strong new password or ask your owner for a new account link.', 400);
    return authResponse({ redirect: '/', message: 'Your password has been saved.' });
  } catch (error) { return authError(error); }
}
