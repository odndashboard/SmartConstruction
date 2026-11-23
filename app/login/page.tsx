import AuthShell, { SetupPending } from '@/components/AuthShell';
import { LoginForm } from '@/components/AuthForms';
import { isWorkspaceConfigured } from '@/lib/supabase/config';

export const dynamic = 'force-dynamic';
export default function LoginPage() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  return <AuthShell eyebrow="WELCOME TO YOUR WORKSPACE" title="Good work starts here." description="Sign in to manage your projects, your team’s follow-ups and the work ahead."><LoginForm /></AuthShell>;
}
