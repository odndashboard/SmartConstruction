import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { todayIST } from '../lib/finance.ts';
import type { FollowUp, WorkspaceData } from '../lib/types.ts';
import { completeQuoteItems } from './fixtures/quotation-items.ts';

const migration = '20261127113600_approved_lead_followups.sql';
const ids = {
  owner: '74000000-0000-4000-8000-000000000001', manager: '74000000-0000-4000-8000-000000000002',
  operations: '74000000-0000-4000-8000-000000000003', sales: '74000000-0000-4000-8000-000000000004',
  accountant: '74000000-0000-4000-8000-000000000005', dealer: '74000000-0000-4000-8000-000000000006',
};
const hash = 'a'.repeat(64); const future = todayIST(new Date(Date.now() + 30 * 86400000));
let db: PGlite; let baseline: WorkspaceData; let historicalLeadId: string;
async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T;
}
async function read(actor = ids.owner): Promise<WorkspaceData> {
  return query('select public.crm_workspace_read($1::uuid,false) result', [actor]);
}
async function rejects(run: () => Promise<unknown>, codes: string | string[]) {
  await db.exec('savepoint expected_failure');
  try {
    await assert.rejects(run, (error: unknown) => {
      const actual = error as { code: string; message: string };
      assert.ok((Array.isArray(codes) ? codes : [codes]).includes(actual.code), `${actual.code}: ${actual.message}`); return true;
    });
  } finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload);
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const old = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => old.get(row.id) !== JSON.stringify(row));
    deleted[key] = before[key].filter(row => !after[key].some(item => item.id === row.id)).map(row => row.id);
  }
  const events = new Set(before.activity.map(row => row.id));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members: [],
      audit: after.activity.filter(row => !events.has(row.id)), clearDemoAudit: action === 'clear_demo' } };
}
async function commit(request: ReturnType<typeof plan>) {
  return query<{ data: WorkspaceData; message: string }>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',
    [request.actor, request.revision, request.requestId, request.action, hash, JSON.stringify(request.changes), request.message]);
}
async function act(action: string, payload: unknown, actor = ids.owner) {
  return commit(plan(await read(actor), action, payload));
}
async function addLead(title = 'Actual project', status = 'NEW', owner = '') {
  const result = await act('lead_save', { title, status, owner, expectedKw: 10.5 });
  return result.data.leads.find(row => row.title === title)!;
}
async function issue(leadId: string, title = 'Actual scope') {
  const data = await read(); const customer = data.customers.find(row => row.id === data.leads.find(lead => lead.id === leadId)?.customerId)!;
  await act('customer_save', { id: customer.id, name: customer.name, contact: customer.contact, phone: customer.phone, email: customer.email, address: 'Actual billing address' });
  const result = await act('quote_save', { leadId, title, validUntil: future, gstEnabled: false, siteAddress: 'Actual site', items: completeQuoteItems([
    { id: crypto.randomUUID(), description: title, quantity: '1', unit: 'job', unitPrice: '100', gstRate: '0' },
  ]) });
  const quote = result.data.quotations.find(row => row.title === title)!;
  return (await act('quote_issue', { id: quote.id })).data.quotations.find(row => row.id === quote.id)!;
}
async function followup(leadId: string, quoteId?: string | null) {
  const before = await read();
  const result = await act('followup_save', { leadId, ...(quoteId === undefined ? {} : { quoteId }), title: 'Genuine scheduled reminder',
    dueAt: `${future}T09:00:00+05:30`, channel: 'Call', owner: ids.sales, notes: 'Keep this original task.' });
  return result.data.followups.find(row => !before.followups.some(old => old.id === row.id))!;
}
function followupInput(row: FollowUp) {
  return { id: row.id, leadId: row.leadId, title: row.title, dueAt: row.dueAt, channel: row.channel, owner: row.owner, notes: row.notes };
}

describe('approved leads create persistent, retry-safe follow-ups', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'$$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql') && file < migration).sort()) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
    for (const [name, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result', [ids.owner]);
    for (const [name, memberRole] of Object.entries({ manager: 'MANAGER', operations: 'OPERATIONS', sales: 'SALES', accountant: 'ACCOUNTANT', dealer: 'DEALER' })) {
      await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [ids.owner, ids[name as keyof typeof ids], name, `${name}@example.invalid`, memberRole]);
    }
    await act('company_save', { name: 'Actual contractor', legalName: 'Actual contractor', address: 'Actual address' });
    historicalLeadId = (await addLead('Historical approved project', 'WON')).id;
    baseline = await read(); assert.equal(baseline.followups.length, 0);
    await db.exec((await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
  });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); });
  after(async () => { await db.close(); });

  test('upgrade preserves historical records; resaving old Won does not manufacture work, while explicit scheduling remains available', async () => {
    assert.deepEqual(await read(), baseline);
    await act('lead_status', { id: historicalLeadId, status: 'WON' });
    await act('lead_save', { id: historicalLeadId, title: 'Historical edited project' });
    assert.deepEqual((await read()).followups, []);
    const reminder = await followup(historicalLeadId);
    assert.equal(reminder.leadId, historicalLeadId); assert.equal(reminder.status, 'OPEN'); assert.equal(reminder.quoteId, undefined);
  });

  test('old application plans create exactly one open task on Won, preserve owner and retry without extra records', async () => {
    const request = plan(await read(), 'lead_save', { title: 'New approved project', status: 'WON', owner: ids.sales });
    assert.deepEqual(request.changes.upserts.followups, []);
    const before = Date.now(); const first = await commit(request); const replay = await commit(request);
    assert.deepEqual(replay, first); assert.equal(first.data.followups.length, 1);
    const task = first.data.followups[0]; const lead = first.data.leads.find(row => row.title === 'New approved project')!;
    assert.equal(task.leadId, lead.id); assert.equal(task.quoteId, null); assert.equal(task.status, 'OPEN');
    assert.equal(task.owner, ids.sales); assert.equal(task.channel, 'Other'); assert.equal(task.outcome, '');
    assert.ok(Date.parse(task.createdAt) >= before && Date.parse(task.createdAt) <= Date.now());
    assert.equal(Date.parse(task.dueAt) - Date.parse(task.createdAt), 24 * 60 * 60 * 1000);
    assert.equal(task.updatedAt, task.createdAt);
    assert.equal(first.data.quotations.length, 0); assert.equal(first.data.workorders.filter(row => row.leadId === lead.id).length, 1);
    await act('lead_status', { id: lead.id, status: 'WON' });
    await act('lead_save', { id: lead.id, title: 'Saved again', status: 'WON' });
    assert.deepEqual((await read()).followups, [task]);
    await act('followup_complete', { id: task.id, outcome: 'Next steps agreed' });
    await act('lead_status', { id: lead.id, status: 'WON' });
    const after = await read(); assert.equal(after.followups.length, 1); assert.equal(after.followups[0].status, 'DONE');
  });

  test('a real status transition reuses an existing open task without changing its schedule or contents', async () => {
    const lead = await addLead(); const existing = await followup(lead.id);
    await act('lead_status', { id: lead.id, status: 'WON' }, ids.manager);
    assert.deepEqual((await read()).followups, [existing]);
    await act('followup_cancel', { id: existing.id });
    await act('lead_status', { id: lead.id, status: 'WON' });
    assert.equal((await read()).followups.length, 1);
  });

  test('acceptance links the actual quotation; another accepted scope receives its own task without changing the first', async () => {
    const lead = await addLead(); const firstQuote = await issue(lead.id, 'First accepted scope');
    const req = plan(await read(), 'quote_accept', { id: firstQuote.id, acceptanceNote: 'Written customer agreement' });
    assert.deepEqual(req.changes.upserts.followups, []);
    const first = await commit(req); assert.deepEqual(await commit(req), first);
    const firstTask = first.data.followups[0]; assert.equal(firstTask.quoteId, firstQuote.id); assert.equal(firstTask.leadId, lead.id);
    await act('followup_complete', { id: firstTask.id, outcome: 'Handover finished' });
    const saved = await read(); const repeated = structuredClone(req);
    repeated.requestId = crypto.randomUUID(); repeated.revision = saved.revision; repeated.changes.audit = [];
    await commit(repeated);
    assert.equal((await read()).followups.length, 1); assert.equal((await read()).followups[0].status, 'DONE');
    // A separate open task for the first quotation must not hide the next scope.
    const openFirst = await followup(lead.id, firstQuote.id);
    const secondQuote = await issue(lead.id, 'Second accepted scope');
    const secondReq = plan(await read(), 'quote_accept', { id: secondQuote.id, acceptanceNote: 'Separate genuine agreement' });
    // Older clients can omit an already-Won lead whose status did not change.
    secondReq.changes.upserts.leads = [];
    const second = await commit(secondReq); assert.equal(second.data.followups.length, 3);
    assert.deepEqual(second.data.followups.find(row => row.id === openFirst.id), openFirst);
    assert.equal(second.data.followups.filter(row => row.quoteId === secondQuote.id).length, 1);
    assert.equal(second.data.leads.filter(row => row.id === lead.id).length, 1);
    assert.equal(second.data.workorders.filter(row => row.leadId === lead.id).length, 2);
  });

  test('acceptance preserves ordinary unlinked tasks and reuses an exact quoted task', async () => {
    for (const link of [false, true]) {
      const lead = await addLead(`Lead ${link}`); const quote = await issue(lead.id, `Scope ${link}`);
      const existing = await followup(lead.id, link ? quote.id : undefined);
      await act('quote_accept', { id: quote.id, acceptanceNote: 'Genuine approval' });
      const tasks = (await read()).followups.filter(row => row.leadId === lead.id);
      assert.deepEqual(tasks.find(row => row.id === existing.id), existing);
      assert.equal(tasks.length, link ? 1 : 2);
      assert.equal(tasks.filter(row => row.quoteId === quote.id).length, 1);
    }
  });

  test('acceptance attaches to its own automatic Won reminder while preserving human-edited scheduling and notes', async () => {
    const lead = await addLead('Approved before quotation', 'WON');
    const automatic = (await read()).followups.find(row => row.leadId === lead.id)!;
    const edited = (await act('followup_save', { ...followupInput(automatic), title: 'Human task title', dueAt: `${future}T16:00:00+05:30`,
      owner: ids.operations, notes: 'Keep these actual handover notes' })).data.followups.find(row => row.id === automatic.id)!;
    const quote = await issue(lead.id); const result = await act('quote_accept', { id: quote.id, acceptanceNote: 'Customer confirmed' });
    const attached = result.data.followups.find(row => row.id === automatic.id)!;
    assert.equal(result.data.followups.filter(row => row.leadId === lead.id).length, 1);
    assert.deepEqual(attached, { ...edited, quoteId: quote.id, updatedAt: attached.updatedAt });
    assert.equal(await query('select approval_origin result from crm.followups where id=$1', [attached.id]), 'WON');
  });

  test('quotation links persist across normal and older edits, completion and explicit unlinking', async () => {
    const lead = await addLead(); const quote = await issue(lead.id); const task = await followup(lead.id, quote.id);
    const edited = (await act('followup_save', { ...followupInput(task), title: 'Edited task' })).data.followups[0];
    assert.equal(edited.quoteId, quote.id);
    const oldClient = plan(await read(), 'followup_save', { ...followupInput(edited), title: 'Older client edit' });
    delete (oldClient.changes.upserts.followups[0] as FollowUp).quoteId;
    const preserved = (await commit(oldClient)).data.followups[0]; assert.equal(preserved.quoteId, quote.id);
    const completion = plan(await read(), 'followup_complete', { id: task.id, outcome: 'Quotation handed over' });
    delete (completion.changes.upserts.followups[0] as FollowUp).quoteId;
    assert.equal((await commit(completion)).data.followups[0].quoteId, quote.id);
    const next = await followup(lead.id, quote.id);
    const unlinked = (await act('followup_save', { ...followupInput(next), quoteId: null })).data.followups.find(row => row.id === next.id)!;
    assert.equal(unlinked.quoteId, null);
  });

  test('app and SQL reject wrong-lead, missing and malformed quotation links without weakening action scopes', async () => {
    const lead = await addLead(); const quote = await issue(lead.id); const other = await addLead('Other project');
    const task = await followup(other.id); const input = followupInput(task);
    const state = await read();
    assert.throws(() => plan(state, 'followup_save', { ...input, quoteId: quote.id }), /quotation for this follow-up lead/i);
    const valid = plan(state, 'followup_save', { ...input, title: 'Edited' });
    for (const quoteId of [quote.id, crypto.randomUUID()]) {
      const forged = structuredClone(valid); (forged.changes.upserts.followups[0] as FollowUp).quoteId = quoteId;
      await rejects(() => commit(forged), '23503');
    }
    for (const quoteId of [true, 12, '', [], {}]) {
      const forged = structuredClone(valid); forged.changes.upserts.followups[0] = { ...task, quoteId };
      await rejects(() => commit(forged), '23514');
    }
    const complete = plan(state, 'followup_complete', { id: task.id, outcome: 'Done' });
    (complete.changes.upserts.followups[0] as FollowUp).quoteId = quote.id;
    await rejects(() => commit(complete), 'PT403');
    const win = plan(state, 'lead_status', { id: other.id, status: 'WON' });
    win.changes.upserts.followups = [{ ...task, title: 'Forged unrelated edit' }];
    await rejects(() => commit(win), 'PT403'); assert.deepEqual(await read(), state);
  });

  test('approval roles and rollback remain authoritative; inactive or dealer owners fall back to the approving member', async () => {
    const lead = await addLead(); const request = plan(await read(), 'lead_status', { id: lead.id, status: 'WON' });
    for (const actor of [ids.sales, ids.operations, ids.accountant, ids.dealer]) await rejects(() => commit({ ...request, actor }), 'PT403');
    const invalid = structuredClone(request); invalid.changes.audit[0].action = 'unrelated';
    const previous = await read(); await rejects(() => commit(invalid), 'PT400'); assert.deepEqual(await read(), previous);
    const approved = await commit({ ...request, actor: ids.manager }); assert.equal(approved.data.followups[0].owner, ids.manager);
    for (const owner of [ids.sales, ids.dealer]) {
      const next = await addLead(`Owner ${owner}`, 'NEW', owner);
      if (owner === ids.sales) await db.query('update crm.members set active=false where user_id=$1', [owner]);
      const result = await act('lead_status', { id: next.id, status: 'WON' }, ids.manager);
      assert.equal(result.data.followups.find(row => row.leadId === next.id)?.owner, ids.manager);
    }
  });

  test('linked demo reminders remain removable with their example quotation and do not affect real records', async () => {
    await act('load_demo', {}); const demo = await read(); const quote = demo.quotations.find(row => row.isDemo)!;
    await followup(quote.leadId, quote.id);
    await act('clear_demo', {});
    const after = await read(); assert.ok(after.followups.every(row => !row.isDemo));
    assert.ok(after.leads.some(row => row.id === historicalLeadId)); assert.equal(after.quotations.length, 0);
  });
});
