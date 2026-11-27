import 'server-only';
import { authenticate } from './auth';
import { readAuthInput } from './auth-http';
import { operationsRpc } from './operations-server';
import { CRMError } from './server-actions';
import { runServerRead, type ServerReadOptions } from './server-read';
import { createDealerLeadSchema, dealerLeadsDataSchema, deleteDealerLeadSchema } from './dealer-leads-validation';
import type { DealerLeadsData, DeleteDealerLeadResult } from './dealer-leads';

export class DealerAccessError extends CRMError {
  readonly accessRevoked = true;
}

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

export async function deleteDealerLead(request: Request): Promise<DeleteDealerLeadResult> {
  const input = await readAuthInput(request, deleteDealerLeadSchema);
  let identity;
  try { identity = await authenticate(); }
  catch (error) {
    if (error instanceof CRMError && [401, 403].includes(error.status)) throw new DealerAccessError(error.message, error.status);
    throw error;
  }
  let raw: { data?: unknown; message?: unknown };
  try {
    // The dealer-only RPC rechecks current role, immutable submitting dealer,
    // untouched NEW eligibility and dependencies together under the same lock.
    raw = await operationsRpc('crm_dealer_lead_delete', {
      p_actor_id: identity.userId, p_expected_revision: input.expectedRevision,
      p_request_id: input.requestId, p_lead_id: input.leadId,
    });
  } catch (error) {
    if (error instanceof CRMError && error.status === 401) throw new DealerAccessError(error.message, 401);
    if (error instanceof CRMError && error.status === 403) {
      // An active dealer can receive a forbidden-action response for a protected
      // enquiry. Only discard private UI state if their scoped access is gone.
      try { dealerSnapshot(await operationsRpc('crm_dealer_leads_read', { p_actor_id: identity.userId }), identity.userId); }
      catch (readError) {
        if (readError instanceof CRMError && [401, 403].includes(readError.status)) throw new DealerAccessError(readError.message, readError.status);
      }
    }
    throw error;
  }
  if (!raw || typeof raw.message !== 'string') throw new CRMError('The deletion result could not be confirmed. Retry the same request.', 503);
  return { data: dealerSnapshot(raw.data, identity.userId), message: raw.message };
}
