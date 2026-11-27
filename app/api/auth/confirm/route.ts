import { z } from 'zod';
import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { getAccountMember, CRMError } from '@/lib/server';
import { ACCOUNT_TOKEN_PATTERN } from '@/lib/auth-policy';
import { clearPasswordSetup, grantPasswordSetup } from '@/lib/password-setup';

export const dynamic = 'force-dynamic';
const schema = z.object({ token_hash: z.string().regex(ACCOUNT_TOKEN_PATTERN, 'This account link is not valid.'), type: z.enum(['invite', 'recovery']) }).strict();

/** Only an explicit same-origin POST consumes a one-time account link. */
export async function POST(request: Request) {
  try {
    const input = await readAuthInput(request, schema);
    await clearPasswordSetup();
    const client = await createAuthClient();
    const { error } = await client.auth.verifyOtp(input);
    if (error) throw new CRMError('This account link has expired or has already been used. Ask your workspace owner for a new one.', 400);
    try {
      const member = await getAccountMember();
      await grantPasswordSetup(client, member.userId);
    }
    catch (workspaceError) {
      await client.auth.signOut({ scope: 'local' });
      if (!(workspaceError instanceof CRMError) || workspaceError.status !== 403) throw workspaceError;
      throw new CRMError('This account does not have active workspace access. Contact your workspace owner.', 403);
    }
    return authResponse({ redirect: '/set-password' });
  } catch (error) { return authError(error); }
}
