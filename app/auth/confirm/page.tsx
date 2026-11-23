import AuthShell, { SetupPending } from '@/components/AuthShell';
import { ConfirmAccountForm } from '@/components/AuthForms';
import { isWorkspaceConfigured } from '@/lib/supabase/config';

export const dynamic = 'force-dynamic';
export default function ConfirmPage() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  return <AuthShell eyebrow="YOUR PRIVATE ACCOUNT LINK" title="Let’s get you signed in." description="One secure step before you choose your password and open the workspace."><ConfirmAccountForm /></AuthShell>;
}
