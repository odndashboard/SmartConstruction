import 'server-only';
import { authenticate } from './auth';
import { createAdminClient } from './supabase/admin';
import { readAuthInput } from './auth-http';
import { CRMError } from './server-actions';
import { todayIST } from './finance';
import { operationsMonthSchema, operationsMutationSchema, teamActivityQuerySchema } from './operations-validation';
import type { OperationsData, StockItem, StockMovement, AttendanceRecord, Expense, TeamActivityData } from './operations-types';
import type { OperationsExtension } from './operations-extensions';
import { assertReadActive, runServerRead, type ServerReadOptions } from './server-read';

interface OperationsExport {
  revision: number; stockItems: StockItem[]; stockMovements: StockMovement[];
  attendance: AttendanceRecord[]; expenses: Expense[]; audit?: Record<string, unknown>[];
  extension: OperationsExtension;
}

export async function operationsRpc<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  assertReadActive(signal);
  const request = createAdminClient().rpc(name, args);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  assertReadActive(signal);
  if (error) {
    const code = error.code ?? '';
    if (/^PT(400|401|403|404|409|503)$/.test(code)) throw new CRMError(error.message || 'This operation was not permitted.', Number(code.slice(2)));
    if (code === '42501') throw new CRMError('Your account does not have permission for this operation.', 403);
    if (code === '23505') throw new CRMError('This entry already exists. Refresh and check the current records.', 409);
    if (code === '23503') throw new CRMError('A linked record changed. Refresh and try again.', 409);
    if (['23514', '23502', '22P02', '22007', '22008', '22003'].includes(code)) throw new CRMError('Check the dates, quantities and amounts you entered.');
    if (code === 'PGRST202' || code === '42P01' || code.startsWith('08')) throw new CRMError('This module is temporarily unavailable. Please try again shortly.', 503);
    console.error('Operations database request failed', { code: code || 'UNKNOWN' });
    throw new CRMError('The request could not be saved or loaded. Please try again.', 500);
  }
  if (data == null) throw new CRMError('The module returned no data. Please try again.', 503);
  return data as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function payloadHash(action: string, payload: unknown): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, payload })));
  return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function getOperations(monthInput?: string | null, options: ServerReadOptions = {}): Promise<OperationsData> {
  const parsed = operationsMonthSchema.safeParse(monthInput ?? todayIST().slice(0, 7));
  if (!parsed.success) throw new CRMError('Choose a valid month.');
  return runServerRead('operations', options, async read => {
    const identity = await read.stage('auth', signal => authenticate(signal));
    return read.stage('operations', signal => operationsRpc<OperationsData>('crm_operations_v2_read', {
      p_actor_id: identity.userId, p_month: parsed.data,
    }, signal));
  });
}

export async function mutateOperations(request: Request): Promise<{ data: OperationsData; message: string }> {
  const input = await readAuthInput(request, operationsMutationSchema);
  const identity = await authenticate();
  // SQL resolves the live role, scope, membership and state under its write lock.
  // No actor ID or role supplied by a browser is accepted by the request schema.
  return operationsRpc('crm_operations_v2_mutate', {
    p_actor_id: identity.userId, p_expected_revision: input.expectedRevision,
    p_request_id: input.requestId, p_action: input.action,
    p_payload_hash: await payloadHash(input.action, input.payload), p_payload: input.payload, p_month: input.month,
  });
}

/** SQL scopes each collection, including exports, to this authenticated member. */
export async function getOperationsExport(): Promise<OperationsExport> {
  const identity = await authenticate();
  return operationsRpc<OperationsExport>('crm_operations_v2_export', { p_actor_id: identity.userId });
}

export async function getTeamActivity(searchParams: URLSearchParams, options: ServerReadOptions = {}): Promise<TeamActivityData> {
  const raw = Object.fromEntries(searchParams);
  if (!Object.hasOwn(raw, 'month')) raw.month = todayIST().slice(0, 7);
  const parsed = teamActivityQuerySchema.safeParse(raw);
  if (!parsed.success) throw new CRMError(parsed.error.issues[0]?.message || 'Check the activity filters.');
  const input = parsed.data;
  // The SQL function independently requires the current Owner role. A query
  // filter selects whose work to inspect; it can never select the caller.
  return runServerRead('team_activity', options, async read => {
    const identity = await read.stage('auth', signal => authenticate(signal));
    return read.stage('team_activity', signal => operationsRpc<TeamActivityData>('crm_team_activity_read', {
      p_actor_id: identity.userId, p_month: input.month, p_employee_id: input.employeeId ?? null,
      p_module: input.module, p_page: input.page,
    }, signal));
  });
}
