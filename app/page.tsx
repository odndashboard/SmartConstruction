import CRMApp from '../components/CRMApp';
import { redirect } from 'next/navigation';
import { authenticate } from '@/lib/auth';
import { CRMError } from '@/lib/server-actions';
import { isWorkspaceConfigured } from '@/lib/supabase/config';
import { SetupPending } from '@/components/AuthShell';

export const dynamic = 'force-dynamic';

export default async function Home() {
  if (!isWorkspaceConfigured()) return <SetupPending />;
  try { await authenticate(); }
  catch (error) {
    if (error instanceof CRMError && [401, 403].includes(error.status)) redirect('/login');
    throw error;
  }
  return <CRMApp />;
}
