import { readJson } from './client-read.ts';
import type { SiteAlertMutation, SiteAlertMutationResult, SiteAlertsData, SiteAlertsQuery } from './site-alerts';

export class AlertRequestError extends Error {
  status: number; uncertain: boolean; accessRevoked: boolean;
  constructor(message: string, status = 0, uncertain = false, accessRevoked = false) {
    super(message); this.name = 'AlertRequestError'; this.status = status; this.uncertain = uncertain; this.accessRevoked = accessRevoked;
  }
}
type ErrorBody = { error?: string; accessRevoked?: boolean };
function dataReceived(value: unknown): value is SiteAlertsData {
  return !!value && typeof value === 'object' && 'revision' in value && Number.isSafeInteger(value.revision)
    && 'alerts' in value && Array.isArray(value.alerts) && 'user' in value && !!value.user;
}
export async function loadAlerts(query: SiteAlertsQuery = {}, options: { signal?: AbortSignal } = {}): Promise<SiteAlertsData> {
  const params = new URLSearchParams();
  if (query.workOrderId) params.set('workOrderId', query.workOrderId);
  if (query.status) params.set('status', query.status);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.search?.trim()) params.set('search', query.search.trim());
  const url = `/api/alerts${params.size ? `?${params}` : ''}`;
  const { response, body } = await readJson<SiteAlertsData & ErrorBody>(url, options);
  if (!response.ok) throw new AlertRequestError(body?.error || (response.status === 401 ? 'Sign in to view alerts.' : response.status === 403 ? 'Your account no longer has access to alerts.' : 'Alerts could not be loaded. Please try again.'), response.status, false, response.status === 401 || response.status === 403 || body?.accessRevoked === true);
  if (!dataReceived(body)) throw new AlertRequestError('The alerts response could not be loaded. Please refresh.', 503);
  return body;
}

/** Never retry automatically or replace the caller's request ID. An uncertain
 * write must be confirmed with exactly the same request before another save. */
export async function saveAlert(request: SiteAlertMutation): Promise<SiteAlertMutationResult> {
  let response: Response;
  try {
    response = await fetch('/api/alerts', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  } catch {
    throw new AlertRequestError('We could not confirm whether the alert was saved. Retry the same change to confirm its result.', 0, true);
  }
  let body: Partial<SiteAlertMutationResult> & ErrorBody = {};
  try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === 'object') body = parsed; }
  catch {
    if (response.ok || response.status >= 500) throw new AlertRequestError('We could not confirm whether the alert was saved. Retry the same change to confirm its result.', response.status, true);
  }
  if (!response.ok) {
    const uncertain = response.status >= 500;
    throw new AlertRequestError(body.error || (uncertain ? 'We could not confirm whether the alert was saved. Retry the same change.' : response.status === 409 ? 'Alerts changed while you were working. Refresh and review before saving again.' : 'This alert change was not permitted.'), response.status, uncertain, response.status === 401 || body.accessRevoked === true);
  }
  if (!dataReceived(body.data) || typeof body.message !== 'string') throw new AlertRequestError('We could not confirm whether the alert was saved. Retry the same change to confirm its result.', response.status, true);
  return { data: body.data, message: body.message };
}
