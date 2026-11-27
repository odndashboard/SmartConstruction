import 'server-only';
import { authenticate } from './auth';
import { readAuthInput } from './auth-http';
import { operationsRpc } from './operations-server';
import { CRMError } from './server-actions';
import { runServerRead, type ServerReadOptions } from './server-read';
import { createDealerLeadSchema, dealerLeadsDataSchema } from './dealer-leads-validation';
import type { DealerLeadsData } from './dealer-leads';

function dealerSnapshot(raw: unknown, actorId: string): DealerLeadsData {
  const result = dealerLeadsDataSchema.safeParse(raw);
  if (!result.success || result.data.user.userId !== actorId) throw new CRMError('Your lead list could not be loaded. Please refresh.', 503);
  return result.data;
}
export async function getDealerLeads(options: ServerReadOptions = {}): Promise<DealerLeadsData> {
  return runServerRead('workspace', options, async read => {
    const identity = await read.stage('auth', signal => authenticate(signal));
    return dealerSnapshot(await read.stage('workspace', signal => operationsRpc('crm_dealer_leads_read', { p_actor_id: identity.userId }, signal)), identity.userId);
  });
}
export async function createDealerLead(request: Request): Promise<DealerLeadsData> {
  const input = await readAuthInput(request, createDealerLeadSchema);
  const identity = await authenticate();
  // The RPC binds the immutable submitting dealer to this authenticated ID and
  // replays the same request receipt. Browser owner/status/customer fields are
  // rejected before any database request is made.
  return dealerSnapshot(await operationsRpc('crm_dealer_lead_create', {
    p_actor_id: identity.userId, p_request_id: input.requestId, p_payload: input.payload,
  }), identity.userId);
}
