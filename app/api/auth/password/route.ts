import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { getAccountMember, CRMError } from '@/lib/server';
import { setupPasswordSchema } from '@/lib/password-policy';
import { clearPasswordSetup, requirePasswordSetup } from '@/lib/password-setup';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request, setupPasswordSchema);
    const member = await getAccountMember();
    const client = await createAuthClient();
    await requirePasswordSetup(client, member.userId);
    const { error } = await client.auth.updateUser({ password: input.password });
    if (error) throw new CRMError(error.code === 'same_password' ? 'Choose a password different from your current password.' : 'The password could not be updated. Use a strong new password or ask your owner for a new account link.', 400);
    await clearPasswordSetup();
    return authResponse({ redirect: member.role === 'DEALER' ? '/dealer' : '/', message: 'Your password has been saved.' });
  } catch (error) { return authError(error); }
}
