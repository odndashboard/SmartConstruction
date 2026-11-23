import { redirect } from 'next/navigation';
import AuthShell, { SetupPending } from '@/components/AuthShell';
import { PasswordForm, SignOutButton } from '@/components/AuthForms';
import { isWorkspaceConfigured } from '@/lib/supabase/config';
import { getWorkspace, CRMError } from '@/lib/server';

export const dynamic = 'force-dynamic';
export default async function SetPasswordPage() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  let email = '';
  try { email = (await getWorkspace()).user.email; }
  catch (error) {
    if (error instanceof CRMError && error.status === 401) redirect('/login');
    return <AuthShell eyebrow="WORKSPACE ACCESS" title="Please contact your owner." description="Your account needs active workspace access before you can continue."><SignOutButton /></AuthShell>;
  }
  return <AuthShell eyebrow="MAKE YOUR ACCOUNT YOUR OWN" title="Choose your password." description="Use this email and password whenever you open the CRM on your phone or computer."><PasswordForm email={email} /></AuthShell>;
}
