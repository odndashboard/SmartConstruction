import { readJson } from './client-read.ts';
import type { CreateDealerLeadRequest, DealerLeadsData, DeleteDealerLeadRequest, DeleteDealerLeadResult } from './dealer-leads';
import { dealerLeadsDataSchema } from './dealer-leads-validation.ts';

export class DealerLeadRequestError extends Error {
  status: number; uncertain: boolean; accessRevoked: boolean;
  constructor(message: string, status = 0, uncertain = false, accessRevoked = status === 401 || status === 403) {
    super(message); this.name = 'DealerLeadRequestError'; this.status = status; this.uncertain = uncertain; this.accessRevoked = accessRevoked;
  }
}
export async function loadDealerLeads(options: { signal?: AbortSignal } = {}): Promise<DealerLeadsData> {
  const { response, body } = await readJson<DealerLeadsData & { error?: string }>('/api/dealer-leads', options);
  if (!response.ok) throw new DealerLeadRequestError(body?.error || (response.status === 401 ? 'Sign in to view your leads.' : response.status === 403 ? 'Your dealer access has changed. Please sign in again.' : 'Your leads could not be loaded. Please try again.'), response.status);
  const parsed = dealerLeadsDataSchema.safeParse(body);
  if (!parsed.success) throw new DealerLeadRequestError('Your lead list could not be loaded. Please refresh.', 503);
  return parsed.data;
}
/** An uncertain save must reuse the same request ID and payload; never retry a
 * creation automatically or allow a new request to stand in for the old one. */
export async function createDealerLead(request: CreateDealerLeadRequest): Promise<DealerLeadsData> {
  let response: Response;
  try { response = await fetch('/api/dealer-leads', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); }
  catch { throw new DealerLeadRequestError('We could not confirm whether your lead was saved. Retry the same submission to confirm it.', 0, true); }
  let body: Partial<DealerLeadsData> & { error?: string } = {};
  try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === 'object') body = parsed; }
  catch {
    if (response.ok || response.status >= 500) throw new DealerLeadRequestError('We could not confirm whether your lead was saved. Retry the same submission to confirm it.', response.status, true);
  }
  if (!response.ok) throw new DealerLeadRequestError(body.error || 'Your lead could not be saved. Please review the details.', response.status, response.status >= 500);
  const parsed = dealerLeadsDataSchema.safeParse(body);
  if (!parsed.success) throw new DealerLeadRequestError('We could not confirm whether your lead was saved. Retry the same submission to confirm it.', response.status, true);
  return parsed.data;
}

/** Deletion is never retried automatically. Reuse the confirmed lead, revision
 * and receipt ID if the response was lost, then review the returned snapshot. */
export async function deleteDealerLead(request: DeleteDealerLeadRequest): Promise<DeleteDealerLeadResult> {
  let response: Response;
  const uncertainMessage = 'We could not confirm whether this enquiry was deleted. Retry the same deletion to confirm its result.';
  try { response = await fetch('/api/dealer-leads', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }); }
  catch { throw new DealerLeadRequestError(uncertainMessage, 0, true); }
  let body: { data?: unknown; message?: unknown; error?: string; accessRevoked?: boolean } = {};
  try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === 'object') body = parsed; }
  catch { if (response.ok || response.status >= 500) throw new DealerLeadRequestError(uncertainMessage, response.status, true); }
  if (!response.ok) throw new DealerLeadRequestError(body.error || (response.status >= 500 ? uncertainMessage : response.status === 409 ? 'This enquiry changed. Refresh and review it before deleting.' : 'This enquiry cannot be deleted.'), response.status, response.status >= 500, response.status === 401 || body.accessRevoked === true);
  const parsed = dealerLeadsDataSchema.safeParse(body.data);
  if (!parsed.success || typeof body.message !== 'string') throw new DealerLeadRequestError(uncertainMessage, response.status, true);
  return { data: parsed.data, message: body.message };
}
