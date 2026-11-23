import AuthShell, { SetupPending } from '@/components/AuthShell';
import { LoginForm } from '@/components/AuthForms';
import { isWorkspaceConfigured } from '@/lib/supabase/config';

export const dynamic = 'force-dynamic';
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ password?: string | string[] }> }) {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  const passwordChanged = (await searchParams).password === 'updated';
  return <AuthShell eyebrow="WELCOME TO YOUR WORKSPACE" title="Good work starts here." description="Sign in to manage your projects, your team’s follow-ups and the work ahead."><LoginForm passwordChanged={passwordChanged} /></AuthShell>;
}
