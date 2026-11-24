import 'server-only';
import { z } from 'zod';
import { authenticate } from './auth';
import { createAdminClient } from './supabase/admin';
import type { WorkspaceData } from './types';
import { applyAction, assertActionRole, CRMError } from './server-actions';
import { assertReadActive, runServerRead, type ServerReadOptions } from './server-read';
export { CRMError } from './server-actions';

const mutationSchema = z.object({
  action: z.string().min(1).max(80), payload: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
interface DatabaseError { code?: string; message?: string; }
function databaseError(error: DatabaseError): CRMError {
  const code = error.code ?? '';
  if (/^PT(400|401|403|404|409|503)$/.test(code)) {
    return new CRMError(error.message || 'The database rejected this request.', Number(code.slice(2)));
  }
  if (code === '42501') return new CRMError('The database does not permit this operation.', 403);
  if (code === '23505') return new CRMError('This record or document already exists. Refresh the workspace.', 409);
  if (code === '23503') return new CRMError('A linked record has changed. Refresh and try again.', 409);
  if (code === '23514' || code === '23502' || code === '22P02' || code === '22007' || code === '22008') {
    return new CRMError('The database rejected an invalid record. Check the entered values.', 400);
  }
  if (code === 'PGRST202' || code === '42P01' || code.startsWith('08')) {
    return new CRMError('This workspace database is still being connected. Please contact the owner.', 503);
  }
  // SQL details can contain values; log only the diagnostic code, never the message.
  console.error('CRM database request failed', { code: code || 'UNKNOWN' });
  return new CRMError('The workspace could not save or load this request. Please try again.', 500);
}
async function rpc<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  assertReadActive(signal);
  const request = createAdminClient().rpc(name, args);
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  assertReadActive(signal);
  if (error) throw databaseError(error);
  if (data == null) throw new CRMError('The workspace database returned an empty response.', 503);
  return data as T;
}

/** No login bootstrap: an Owner must explicitly invite every employee. */
export async function getWorkspace(fullAudit = false, options: ServerReadOptions = {}): Promise<WorkspaceData> {
  return runServerRead('workspace', options, async read => {
    const identity = await read.stage('auth', signal => authenticate(signal));
    return read.stage('workspace', signal => rpc<WorkspaceData>('crm_workspace_read', {
      p_actor_id: identity.userId, p_full_audit: fullAudit,
    }, signal));
  });
}

function sameOrigin(request: Request): void {
  const source = request.headers.get('origin');
  let valid = false;
  try { valid = Boolean(source) && new URL(source!).origin === new URL(request.url).origin; }
  catch { valid = false; }
  if (!valid || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new CRMError('This change must be submitted from this workspace.', 403);
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new CRMError('Send this request as application/json.', 415);
  }
}
async function boundedBody(request: Request): Promise<string> {
  const limit = 1_000_000;
  if (Number(request.headers.get('content-length') ?? '0') > limit) throw new CRMError('This request is too large.', 413);
  if (!request.body) throw new CRMError('The request body is missing.');
  const reader = request.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0; let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); throw new CRMError('This request is too large.', 413); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof CRMError) throw error;
    throw new CRMError('The request contains invalid text.');
  } finally { reader.releaseLock(); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
async function digest(action: string, payload: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ action, payload })));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const entityKeys = ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const;
function buildChanges(before: WorkspaceData, after: WorkspaceData, action: string) {
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of entityKeys) {
    const existing = new Map(before[key].map(record => [record.id, JSON.stringify(record)]));
    const remaining = new Set(after[key].map(record => record.id));
    upserts[key] = after[key].filter(record => existing.get(record.id) !== JSON.stringify(record));
    deleted[key] = before[key].filter(record => !remaining.has(record.id)).map(record => record.id);
  }
  const oldEvents = new Set(before.activity.map(event => event.id));
  return {
    company: after.company, sequences: after.sequences, upserts, deleted,
    members: after.members.filter(member => {
      const previous = before.members.find(item => item.userId === member.userId);
      return previous && (previous.role !== member.role || previous.active !== member.active);
    }).map(({ userId, role, active }) => ({ userId, role, active })),
    audit: after.activity.filter(event => !oldEvents.has(event.id)), clearDemoAudit: action === 'clear_demo',
  };
}

export async function mutateWorkspace(request: Request): Promise<{ data: WorkspaceData; message: string }> {
  sameOrigin(request);
  const identity = await authenticate();
  let raw: unknown;
  try { raw = JSON.parse(await boundedBody(request)); }
  catch (error) { if (error instanceof CRMError) throw error; throw new CRMError('The request contains invalid JSON.'); }
  const parsed = mutationSchema.safeParse(raw);
  if (!parsed.success) throw new CRMError('The change requires an action, payload, request ID and current workspace revision.');
  const input = parsed.data;
  const hash = await digest(input.action, input.payload);
  // This RPC reads the member, workspace and existing receipt under the same
  // database lock. Replays are resolved before state-dependent business validation.
  const prepared = await rpc<{ data: WorkspaceData; receiptMessage: string | null }>('crm_mutation_prepare', {
    p_actor_id: identity.userId, p_request_id: input.requestId, p_action: input.action, p_payload_hash: hash,
  });
  const before = prepared.data;
  if (prepared.receiptMessage !== null) return { data: before, message: prepared.receiptMessage };
  assertActionRole(before, input.action);
  if (before.revision !== input.expectedRevision) throw new CRMError('The workspace changed on another device. Refresh and try again.', 409);
  const after = structuredClone(before);
  // Identity names from mutable Auth metadata never replace Owner-managed member
  // names or audit attribution. SQL stores the authoritative actor UUID as well.
  const message = applyAction(after, input.action, input.payload, new Date());
  return rpc<{ data: WorkspaceData; message: string }>('crm_workspace_commit', {
    p_actor_id: identity.userId, p_expected_revision: input.expectedRevision,
    p_request_id: input.requestId, p_action: input.action, p_payload_hash: hash,
    p_changes: buildChanges(before, after, input.action), p_message: message,
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof CRMError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  console.error('CRM request failed', { category: error instanceof Error ? error.name : 'UnknownError' });
  return Response.json({ error: 'The workspace could not save or load this request. Please try again.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
}
