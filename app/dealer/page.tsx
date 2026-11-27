import { redirect } from 'next/navigation';
import DealerPortal from '@/components/DealerPortal';
import { getDealerLeads } from '@/lib/dealer-leads-server';
import type { DealerLeadsData } from '@/lib/dealer-leads';
import { CRMError } from '@/lib/server-actions';

export const dynamic = 'force-dynamic';

export default async function DealerPage() {
  let initialData: DealerLeadsData | null = null;
  try {
    initialData = await getDealerLeads();
  } catch (error) {
    if (error instanceof CRMError && error.status === 401) redirect('/login');
    if (error instanceof CRMError && error.status === 403) redirect('/');
  }
  return <DealerPortal initialData={initialData} initialError={initialData ? undefined : "Your leads could not be loaded. Please try again."} />;
}
