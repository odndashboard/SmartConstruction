import { createAuthClient } from '@/lib/supabase/server';
import { readAuthInput, authResponse, authError } from '@/lib/auth-http';
import { getAccountMember, CRMError } from '@/lib/server';
import { changeOwnPassword, changePasswordSchema, PasswordChangeError } from '@/lib/password-policy';
import { clearPasswordSetup } from '@/lib/password-setup';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let client: Awaited<ReturnType<typeof createAuthClient>> | undefined;
  try {
    const input = await readAuthInput(request, changePasswordSchema);
    client = await createAuthClient();
    const auth = client.auth;
    await changeOwnPassword(input, {
      currentMember: getAccountMember,
      reauthenticate: async (email, password) => {
        const { data, error } = await auth.signInWithPassword({ email, password });
        if (error || !data.user?.email || !data.user.email_confirmed_at || data.user.is_anonymous) {
          throw new CRMError(error?.status === 429 ? 'Too many attempts. Wait a moment and try again.' : 'Your current password is incorrect. Please try again.', error?.status === 429 ? 429 : 401);
        }
        return { userId: data.user.id, email: data.user.email };
      },
      update: async password => {
        const { data, error } = await auth.updateUser({ password });
        if (error || !data.user?.email) {
          throw new CRMError(error?.code === 'same_password' ? 'Choose a password different from your current password.' : 'Your password could not be changed. Use a strong new password and try again.', 400);
        }
        return { userId: data.user.id, email: data.user.email };
      },
    });
    await clearPasswordSetup();
    const { error } = await client.auth.signOut({ scope: 'local' });
    return authResponse({
      saved: true,
      signedOut: !error,
      message: error ? 'Your password was changed. Sign out, then sign in using your new password.' : 'Your password was changed. Sign in again with your new password.',
      redirect: error ? undefined : '/login?password=updated',
    });
  } catch (error) {
    if (error instanceof PasswordChangeError && client) {
      // A mismatched identity must never leave the browser signed into it.
      try { await clearPasswordSetup(); await client.auth.signOut({ scope: 'local' }); } catch { /* Keep the original safe error. */ }
    }
    return authError(error instanceof PasswordChangeError ? new CRMError(error.message, error.status) : error);
  }
}
