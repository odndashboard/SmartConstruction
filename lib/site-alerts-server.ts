import 'server-only';
import { authenticate } from './auth';
import { readAuthInput } from './auth-http';
import { operationsRpc } from './operations-server';
import { CRMError } from './server-actions';
import { runServerRead, type ServerReadOptions } from './server-read';
import { siteAlertMutationSchema, siteAlertsDataSchema, siteAlertsQuerySchema } from './site-alerts-validation';
import type { SiteAlertMutationResult, SiteAlertsData } from './site-alerts';

export class AlertAccessError extends CRMError {
  accessRevoked = true;
  constructor(error: CRMError) { super(error.message, error.status); }
}
async function alertIdentity(signal?: AbortSignal) {
  try { return await authenticate(signal); }
  catch (error) {
    if (error instanceof CRMError && (error.status === 401 || error.status === 403)) throw new AlertAccessError(error);
    throw error;
  }
}
function validatedData(raw: unknown): SiteAlertsData {
  const result = siteAlertsDataSchema.safeParse(raw);
  if (!result.success) throw new CRMError('The alerts response could not be loaded. Please refresh.', 503);
  return result.data;
}
function queryArgs(query: { workOrderId?: string; status: string; page: number; search: string }) {
  return { p_work_order_id: query.workOrderId ?? null, p_status: query.status, p_page: query.page, p_search: query.search };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function mutationHash(action: string, payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, payload })));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function getSiteAlerts(searchParams: URLSearchParams, options: ServerReadOptions = {}): Promise<SiteAlertsData> {
  if (new Set(searchParams.keys()).size !== [...searchParams.keys()].length) throw new CRMError('Use one value for each alert filter.');
  const parsed = siteAlertsQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) throw new CRMError(parsed.error.issues[0]?.message || 'Check the alert filters.');
  return runServerRead('operations', options, async read => {
    const identity = await read.stage('auth', signal => alertIdentity(signal));
    try {
      const raw = await read.stage('operations', signal => operationsRpc('crm_material_alerts_read', {
        p_actor_id: identity.userId, ...queryArgs(parsed.data),
      }, signal));
      return validatedData(raw);
    } catch (error) {
      if (error instanceof CRMError && (error.status === 401 || error.status === 403)) throw new AlertAccessError(error);
      throw error;
    }
  });
}

export async function mutateSiteAlerts(request: Request): Promise<SiteAlertMutationResult> {
  const input = await readAuthInput(request, siteAlertMutationSchema);
  const identity = await alertIdentity();
  // Live membership, assignee eligibility, work-order state and resolve rights
  // are checked by SQL inside the same transaction as the idempotent receipt.
  const result = await operationsRpc<{ data: unknown; message?: string }>('crm_material_alerts_mutate', {
    p_actor_id: identity.userId, p_expected_revision: input.expectedRevision, p_request_id: input.requestId,
    p_action: input.action, p_payload_hash: await mutationHash(input.action, input.payload), p_payload: input.payload,
    ...queryArgs(input.query),
  });
  return { data: validatedData(result.data), message: result.message || 'Alert saved.' };
}
