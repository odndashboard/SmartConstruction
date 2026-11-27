import { redirect } from 'next/navigation';
import Link from 'next/link';
import AuthShell, { SetupPending } from '@/components/AuthShell';
import { PasswordForm, SignOutButton } from '@/components/AuthForms';
import { isWorkspaceConfigured } from '@/lib/supabase/config';
import { getAccountMember, CRMError } from '@/lib/server';
import { createAuthClient } from '@/lib/supabase/server';
import { requirePasswordSetup } from '@/lib/password-setup';

export const dynamic = 'force-dynamic';
export default async function SetPasswordPage() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  let email = '';
  try {
    const member = await getAccountMember();
    email = member.email;
    await requirePasswordSetup(await createAuthClient(), member.userId);
  }
  catch (error) {
    if (error instanceof CRMError && error.status === 401) redirect('/login');
    return <AuthShell eyebrow="WORKSPACE ACCESS" title="Open your private account link." description="Use a fresh setup or recovery link from your owner. To change your current password while signed in, open Settings → Account security."><Link className="button button-primary auth-submit" href="/" prefetch={false}>Open your workspace</Link><SignOutButton /></AuthShell>;
  }
  return <AuthShell eyebrow="MAKE YOUR ACCOUNT YOUR OWN" title="Choose your password." description="Use this email and password whenever you open the CRM on your phone or computer."><PasswordForm email={email} /></AuthShell>;
}
