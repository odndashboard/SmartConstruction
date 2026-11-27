import CRMApp from '../components/CRMApp';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getWorkspace } from '@/lib/server';
import { WORKSPACE_MODE_COOKIE, workspaceMode } from '@/lib/workspace-mode';
import { getInitialWorkspace, type InitialWorkspace } from '@/lib/initial-workspace';
import { CRMError } from '@/lib/server-actions';
import { isWorkspaceConfigured } from '@/lib/supabase/config';
import { SetupPending } from '@/components/AuthShell';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  const mode = workspaceMode((await cookies()).get(WORKSPACE_MODE_COOKIE)?.value);
  let initial: InitialWorkspace | null = null;
  try {
    initial = mode === 'simple'
      ? { workspace: await getWorkspace(), operations: null, operationsError: '' }
      : await getInitialWorkspace();
  }
  catch (error) {
    if (error instanceof CRMError && error.status === 403 && error.message === 'Use the dealer lead portal.') redirect('/dealer');
    if (error instanceof CRMError && [401, 403].includes(error.status)) redirect('/login');
  }
  if (!initial) return <CRMApp initialMode={mode} initialError="Your workspace could not be loaded. Check your connection and try again." />;
  return <CRMApp initialMode={mode} initialWorkspace={initial.workspace} initialOperations={initial.operations} initialOperationsError={initial.operationsError} />;
}
