import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { getChatGPTUser, type ChatGPTUser } from '../app/chatgpt-auth';
import { DEFAULT_COMPANY, type WorkspaceData, type Member, type Role, type AuditEvent } from './types';
import { applyAction, assertActionRole, CRMError } from './server-actions';
export { CRMError } from './server-actions';

const mutationSchema = z.object({
  action: z.string().min(1).max(80), payload: z.record(z.unknown()),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
interface WorkspaceRow { revision: number; company_json: string; sequences_json: string; }
interface MemberRow { user_id: string; name: string; email: string; role: Role; active: number; }
interface PayloadRow { payload_json: string; }
interface ReceiptRow { user_id: string; action: string; payload_hash: string; revision: number; message: string; }
function database(): D1Database {
  if (!env.DB) throw new CRMError('The workspace database is unavailable. Please try again later.', 503);
  return env.DB;
}
function statement(db: D1Database, query: string, ...values: (string | number | null)[]): D1PreparedStatement {
  return db.prepare(query).bind(...values);
}
async function authenticate(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (!user) throw new CRMError('Sign in with ChatGPT to open this private workspace.', 401);
  return user;
}

async function bootstrap(db: D1Database, identity: ChatGPTUser) {
  const now = new Date().toISOString();
  const event: AuditEvent = { id: crypto.randomUUID(), actor: identity.displayName, action: 'member.joined',
    entityType: 'member', entityId: identity.userId, description: 'Authenticated team member joined the workspace', createdAt: now };
  // D1 batch is atomic. The first admitted identity is owner; every later identity
  // starts as viewer. Launch audience must remain owner-private in Site settings.
  await db.batch([
    statement(db, 'INSERT OR IGNORE INTO workspaces (id, revision, company_json, sequences_json) VALUES (1, 0, ?, ?)', JSON.stringify(DEFAULT_COMPANY), '{}'),
    statement(db, `INSERT OR IGNORE INTO members (user_id, name, email, role, active)
      VALUES (?, ?, ?, CASE WHEN (SELECT COUNT(*) FROM members) = 0 THEN 'OWNER' ELSE 'VIEWER' END, 1)`,
      identity.userId, identity.displayName, identity.email),
    statement(db, 'UPDATE workspaces SET revision = revision + 1 WHERE id = 1 AND changes() = 1'),
    statement(db, `INSERT INTO audit_events (id, actor_id, is_demo, created_at, payload_json)
      SELECT ?, ?, 0, ?, ? WHERE changes() = 1`, event.id, identity.userId, now, JSON.stringify(event)),
  ]);
}
function payloads<T>(rows: unknown[]): T[] { return (rows as PayloadRow[]).map(row => JSON.parse(row.payload_json) as T); }
async function readWorkspace(db: D1Database, identity: ChatGPTUser, fullAudit = false): Promise<WorkspaceData> {
  // A single atomic read batch avoids combining records from different revisions.
  const results = await db.batch([
    db.prepare('SELECT revision, company_json, sequences_json FROM workspaces WHERE id = 1'),
    db.prepare('SELECT user_id, name, email, role, active FROM members ORDER BY name, user_id'),
    db.prepare('SELECT payload_json FROM customers ORDER BY created_at DESC, id'),
    db.prepare('SELECT payload_json FROM leads ORDER BY created_at DESC, id'),
    db.prepare('SELECT payload_json FROM followups ORDER BY due_at, id'),
    db.prepare('SELECT payload_json FROM quotations ORDER BY rowid DESC'),
    db.prepare('SELECT payload_json FROM workorders ORDER BY rowid DESC'),
    db.prepare(`SELECT payload_json FROM audit_events ORDER BY created_at DESC, id DESC${fullAudit ? '' : ' LIMIT 250'}`),
  ]);
  const row = results[0].results[0] as unknown as WorkspaceRow | undefined;
  if (!row) throw new CRMError('The workspace is not initialized.', 503);
  const members: Member[] = (results[1].results as unknown as MemberRow[]).map(member => ({
    userId: member.user_id, name: member.name, email: member.email, role: member.role, active: Boolean(member.active),
  }));
  const member = members.find(item => item.userId === identity.userId);
  if (!member || !member.active) throw new CRMError('This account does not have active workspace access.', 403);
  return {
    revision: row.revision, company: JSON.parse(row.company_json), sequences: JSON.parse(row.sequences_json),
    user: { ...member, name: identity.displayName, email: identity.email }, members,
    customers: payloads(results[2].results), leads: payloads(results[3].results), followups: payloads(results[4].results),
    quotations: payloads(results[5].results), workorders: payloads(results[6].results), activity: payloads(results[7].results),
  };
}
export async function getWorkspace(fullAudit = false): Promise<WorkspaceData> {
  const identity = await authenticate(); const db = database();
  await bootstrap(db, identity);
  return readWorkspace(db, identity, fullAudit);
}

function sameOrigin(request: Request): void {
  const source = request.headers.get('origin');
  let valid = false;
  try { valid = Boolean(source) && new URL(source!).origin === new URL(request.url).origin; }
  catch { valid = false; }
  if (!valid) throw new CRMError('This change must be submitted from this workspace.', 403);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') throw new CRMError('Cross-site changes are not allowed.', 403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new CRMError('Send this request as application/json.', 415);
  }
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
async function receipt(db: D1Database, requestId: string): Promise<ReceiptRow | null> {
  return statement(db, 'SELECT user_id, action, payload_hash, revision, message FROM mutation_receipts WHERE request_id = ?', requestId).first<ReceiptRow>();
}
function checkReceipt(row: ReceiptRow, userId: string, action: string, hash: string): void {
  if (row.user_id !== userId || row.action !== action || row.payload_hash !== hash) {
    throw new CRMError('This request ID has already been used for a different change. Refresh and try again.', 409);
  }
}
function changed<T extends { id: string }>(before: T[], after: T[]): T[] {
  const old = new Map(before.map(record => [record.id, JSON.stringify(record)]));
  return after.filter(record => old.get(record.id) !== JSON.stringify(record));
}
function removed<T extends { id: string }>(before: T[], after: T[]): T[] {
  const keep = new Set(after.map(record => record.id)); return before.filter(record => !keep.has(record.id));
}

export async function mutateWorkspace(request: Request): Promise<{ data: WorkspaceData; message: string }> {
  sameOrigin(request);
  const identity = await authenticate(); const db = database();
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 1_000_000) throw new CRMError('This request is too large.', 413);
  const body = await request.text();
  if (body.length > 1_000_000) throw new CRMError('This request is too large.', 413);
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new CRMError('The request contains invalid JSON.'); }
  const parsed = mutationSchema.safeParse(raw);
  if (!parsed.success) throw new CRMError('The change requires an action, payload, request ID and current workspace revision.');
  const input = parsed.data;
  await bootstrap(db, identity);
  const before = await readWorkspace(db, identity);
  assertActionRole(before, input.action);
  const hash = await digest(input.action, input.payload);
  const existing = await receipt(db, input.requestId);
  if (existing) { checkReceipt(existing, identity.userId, input.action, hash); return { data: await readWorkspace(db, identity), message: existing.message }; }
  if (before.revision !== input.expectedRevision) throw new CRMError('The workspace changed on another device. Refresh and try again.', 409);
  const after = structuredClone(before);
  const now = new Date(); const message = applyAction(after, input.action, input.payload, now);
  after.revision = before.revision + 1;
  const queries: D1PreparedStatement[] = [
    statement(db, `INSERT INTO mutation_guards (id, ok)
      VALUES (?, CASE WHEN (SELECT revision FROM workspaces WHERE id = 1) = ? THEN 1 ELSE 0 END)`, input.requestId, input.expectedRevision),
  ];
  // Parent-first writes preserve relational integrity, all within the guarded batch.
  for (const record of changed(before.customers, after.customers)) queries.push(statement(db,
    `INSERT INTO customers (id, is_demo, created_at, payload_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET is_demo=excluded.is_demo, payload_json=excluded.payload_json`,
    record.id, Number(record.isDemo), record.createdAt, JSON.stringify(record)));
  for (const record of changed(before.leads, after.leads)) queries.push(statement(db,
    `INSERT INTO leads (id, customer_id, status, is_demo, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET customer_id=excluded.customer_id, status=excluded.status, is_demo=excluded.is_demo, payload_json=excluded.payload_json`,
    record.id, record.customerId, record.status, Number(record.isDemo), record.createdAt, JSON.stringify(record)));
  for (const record of changed(before.followups, after.followups)) queries.push(statement(db,
    `INSERT INTO followups (id, lead_id, status, due_at, is_demo, payload_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET lead_id=excluded.lead_id, status=excluded.status, due_at=excluded.due_at, is_demo=excluded.is_demo, payload_json=excluded.payload_json`,
    record.id, record.leadId, record.status, record.dueAt, Number(record.isDemo), JSON.stringify(record)));
  for (const record of changed(before.quotations, after.quotations).sort((a, b) => a.revision - b.revision)) queries.push(statement(db,
    `INSERT INTO quotations (id, lead_id, number, status, revision_of, is_demo, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, number=excluded.number, payload_json=excluded.payload_json`,
    record.id, record.leadId, record.number, record.status, record.revisionOf ?? null, Number(record.isDemo), JSON.stringify(record)));
  for (const record of changed(before.workorders, after.workorders)) queries.push(statement(db,
    `INSERT INTO workorders (id, quote_id, number, status, is_demo, payload_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload_json=excluded.payload_json`,
    record.id, record.quoteId, record.number, record.status, Number(record.isDemo), JSON.stringify(record)));
  for (const member of after.members) {
    const old = before.members.find(m => m.userId === member.userId);
    if (old && old.role !== member.role) queries.push(statement(db, 'UPDATE members SET role = ? WHERE user_id = ?', member.role, member.userId));
  }
  // Only the explicit example-clearing action can delete records. Business rows do
  // not have destructive delete actions. Reverse-parent order respects foreign keys.
  if (input.action === 'clear_demo') {
    for (const record of removed(before.workorders, after.workorders)) queries.push(statement(db, 'DELETE FROM workorders WHERE id = ? AND is_demo = 1', record.id));
    for (const record of removed(before.quotations, after.quotations).sort((a, b) => b.revision - a.revision)) queries.push(statement(db, 'DELETE FROM quotations WHERE id = ? AND is_demo = 1', record.id));
    for (const record of removed(before.followups, after.followups)) queries.push(statement(db, 'DELETE FROM followups WHERE id = ? AND is_demo = 1', record.id));
    for (const record of removed(before.leads, after.leads)) queries.push(statement(db, 'DELETE FROM leads WHERE id = ? AND is_demo = 1', record.id));
    for (const record of removed(before.customers, after.customers)) queries.push(statement(db, 'DELETE FROM customers WHERE id = ? AND is_demo = 1', record.id));
    queries.push(db.prepare('DELETE FROM audit_events WHERE is_demo = 1'));
  }
  const priorEvents = new Set(before.activity.map(event => event.id));
  for (const event of after.activity.filter(e => !priorEvents.has(e.id))) queries.push(statement(db,
    'INSERT INTO audit_events (id, actor_id, is_demo, created_at, payload_json) VALUES (?, ?, ?, ?, ?)',
    event.id, event.id.startsWith('demo_') ? null : identity.userId, Number(event.id.startsWith('demo_')), event.createdAt, JSON.stringify(event)));
  queries.push(statement(db, 'UPDATE workspaces SET revision = ?, company_json = ?, sequences_json = ? WHERE id = 1',
    after.revision, JSON.stringify(after.company), JSON.stringify(after.sequences)));
  queries.push(statement(db, `INSERT INTO mutation_receipts (request_id, user_id, action, payload_hash, revision, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.requestId, identity.userId, input.action, hash, after.revision, message, now.toISOString()));
  queries.push(statement(db, 'DELETE FROM mutation_guards WHERE id = ?', input.requestId));
  try { await db.batch(queries); }
  catch (error) {
    // Concurrent retries with the same ID may have committed while we waited.
    const completed = await receipt(db, input.requestId);
    if (completed) { checkReceipt(completed, identity.userId, input.action, hash); return { data: await readWorkspace(db, identity), message: completed.message }; }
    if (/workspace_revision_matches|CHECK constraint failed/i.test(String(error))) {
      throw new CRMError('The workspace changed on another device. Refresh and try again.', 409);
    }
    throw error;
  }
  return { data: await readWorkspace(db, identity), message };
}

export function errorResponse(error: unknown): Response {
  if (error instanceof CRMError) return Response.json({ error: error.message }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  // Never log submitted CRM data, authentication headers, names or email addresses.
  console.error('CRM request failed', { category: error instanceof Error ? error.name : 'UnknownError' });
  return Response.json({ error: 'The workspace could not save or load this request. Please try again.' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
}
