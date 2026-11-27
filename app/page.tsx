import CRMApp from '../components/CRMApp';
import { redirect } from 'next/navigation';
import { getInitialWorkspace, type InitialWorkspace } from '@/lib/initial-workspace';
import { CRMError } from '@/lib/server-actions';
import { isWorkspaceConfigured } from '@/lib/supabase/config';
import { SetupPending } from '@/components/AuthShell';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  let initial: InitialWorkspace | null = null;
  try { initial = await getInitialWorkspace(); }
  catch (error) {
    if (error instanceof CRMError && error.status === 403 && error.message === 'Use the dealer lead portal.') redirect('/dealer');
    if (error instanceof CRMError && [401, 403].includes(error.status)) redirect('/login');
  }
  if (!initial) return <CRMApp initialError="Your workspace could not be loaded. Check your connection and try again." />;
  return <CRMApp initialWorkspace={initial.workspace} initialOperations={initial.operations} initialOperationsError={initial.operationsError} />;
}
