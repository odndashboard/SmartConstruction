import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { todayIST } from '../lib/finance.ts';
import type { WorkspaceData } from '../lib/types.ts';
import { completeQuoteItems } from './fixtures/quotation-items.ts';

const migration = '20261127122538_safe_lead_deletion.sql';
const ids = {
  owner: '75000000-0000-4000-8000-000000000001', manager: '75000000-0000-4000-8000-000000000002',
  sales: '75000000-0000-4000-8000-000000000003', operations: '75000000-0000-4000-8000-000000000004',
  accountant: '75000000-0000-4000-8000-000000000005', dealer: '75000000-0000-4000-8000-000000000006',
  otherDealer: '75000000-0000-4000-8000-000000000007',
};
const hash = 'a'.repeat(64);
let db: PGlite; let baseline: WorkspaceData;
async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T;
}
async function read(): Promise<WorkspaceData> { return query('select public.crm_workspace_read($1::uuid,false) result', [ids.owner]); }
async function revision(): Promise<number> { return query('select revision result from crm.workspace where id=1'); }
async function rejects(run: () => Promise<unknown>, code: string) {
  await db.exec('savepoint expected_failure');
  try { await assert.rejects(run, (error: unknown) => { const value = error as { code: string; message: string }; assert.equal(value.code, code, value.message); return true; }); }
  finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload);
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row));
    deleted[key] = before[key].filter(row => !after[key].some(next => next.id === row.id)).map(row => row.id);
  }
  const events = new Set(before.activity.map(row => row.id));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members: [], audit: after.activity.filter(row => !events.has(row.id)), clearDemoAudit: action === 'clear_demo' } };
}
async function commit(request: ReturnType<typeof plan>) {
  return query<{ data: WorkspaceData; message: string }>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',
    [request.actor, request.revision, request.requestId, request.action, hash, JSON.stringify(request.changes), request.message]);
}
async function act(action: string, payload: unknown) { return commit(plan(await read(), action, payload)); }
async function staffLead(title = crypto.randomUUID(), status = 'NEW') {
  return (await act('lead_save', { title, status })).data.leads.find(row => row.title === title)!;
}
async function dealerCreate(actor = ids.dealer, requestId = crypto.randomUUID(), title = crypto.randomUUID()) {
  const payload = { title, contact: 'Actual submitted contact', expectedKw: 2.5 };
  const result = await query<{ leads: { id: string; title: string }[] }>('select public.crm_dealer_lead_create($1::uuid,$2,$3::jsonb) result', [actor, requestId, JSON.stringify(payload)]);
  return { id: result.leads.find(row => row.title === title)!.id, requestId, payload };
}
async function remove(id: string, actor = ids.owner, requestId = crypto.randomUUID(), expectedRevision?: number, dealer = false) {
  return query<{ data: WorkspaceData; message: string }>(`select public.${dealer ? 'crm_dealer_lead_delete' : 'crm_lead_delete'}($1::uuid,$2::bigint,$3,$4) result`,
    [actor, expectedRevision ?? await revision(), requestId, id]);
}

describe('standalone lead deletion: authoritative database permissions and preservation', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'$$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    const files = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
    for (const file of files.filter(file => file < migration)) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const [name, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result', [ids.owner]);
    for (const [name, memberRole] of Object.entries({ manager: 'MANAGER', sales: 'SALES', operations: 'OPERATIONS', accountant: 'ACCOUNTANT', dealer: 'DEALER', otherDealer: 'DEALER' })) {
      await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [ids.owner, ids[name as keyof typeof ids], name, `${name}@example.invalid`, memberRole]);
    }
    await staffLead('Existing standalone lead'); await dealerCreate(); baseline = await read();
    for (const file of files.filter(file => file >= migration)) await db.exec((await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
  });
  beforeEach(async () => { await db.exec('begin'); });
  afterEach(async () => { await db.exec('rollback'); }); after(async () => { await db.close(); });

  test('migration changes no business records; Owner deletes only the lead and retries without losing customer or history', async () => {
    assert.deepEqual(await read(), baseline); const lead = await staffLead(); const before = await read(); const requestId = crypto.randomUUID();
    const pure = structuredClone(before); applyAction(pure, 'lead_delete', { id: lead.id });
    assert.deepEqual(pure.customers, before.customers); assert.ok(!pure.leads.some(row => row.id === lead.id));
    const first = await remove(lead.id, ids.owner, requestId, before.revision); const replay = await remove(lead.id, ids.owner, requestId, before.revision);
    assert.deepEqual(replay, first); assert.equal(first.data.revision, before.revision + 1); assert.equal(first.message, 'Lead deleted.');
    assert.ok(!first.data.leads.some(row => row.id === lead.id)); assert.deepEqual(first.data.customers, before.customers);
    assert.equal(first.data.activity.length, before.activity.length + 1); assert.ok(before.activity.every(row => first.data.activity.some(next => next.id === row.id)));
    assert.equal(await query('select count(*)::integer result from crm.mutation_receipts where request_id=$1', [requestId]), 1);
    await rejects(() => remove(baseline.leads[0].id, ids.owner, requestId), 'PT409');
    await rejects(() => remove(lead.id), 'PT404');
  });

  test('Owner-only staff endpoint rejects Manager, staff and Dealers; stale UI is checked atomically', async () => {
    const lead = await staffLead(); const old = await revision();
    for (const actor of [ids.manager, ids.sales, ids.operations, ids.accountant, ids.dealer]) await rejects(() => remove(lead.id, actor), 'PT403');
    await rejects(() => remove(lead.id, ids.owner, crypto.randomUUID(), undefined, true), 'PT403');
    await staffLead('Concurrent write'); await rejects(() => remove(lead.id, ids.owner, crypto.randomUUID(), old), 'PT409');
    assert.ok((await read()).leads.some(row => row.id === lead.id));
    const forged = plan(await read(), 'lead_delete', { id: lead.id }); await rejects(() => commit(forged), 'PT400');
  });

  test('Dealer deletes only an own untouched new enquiry; creation receipt replay never resurrects it', async () => {
    const created = await dealerCreate(); const before = await read(); const requestId = crypto.randomUUID();
    const result = await remove(created.id, ids.dealer, requestId, before.revision, true);
    assert.equal(result.data.user.role, 'DEALER'); assert.equal(result.data.user.userId, ids.dealer);
    for (const field of ['customers', 'members', 'quotations', 'workorders', 'activity']) assert.ok(!(field in result.data));
    assert.ok(!result.data.leads.some(row => row.id === created.id));
    assert.deepEqual(await remove(created.id, ids.dealer, requestId, before.revision, true), result);
    await query('select public.crm_dealer_lead_create($1::uuid,$2,$3::jsonb) result', [ids.dealer, created.requestId, JSON.stringify(created.payload)]);
    const after = await read(); assert.ok(!after.leads.some(row => row.id === created.id)); assert.deepEqual(after.customers, before.customers);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(await query('select count(*)::integer result from crm.mutation_receipts where request_id=$1', [created.requestId]), 1);
    assert.ok(after.activity.some(row => row.action === 'dealer_lead_create' && row.entityId === created.id));
    assert.ok(after.activity.some(row => row.action === 'dealer_lead_delete' && row.entityId === created.id));
  });

  test('foreign, staff-assigned-only, progressed and previously edited enquiries stay protected from Dealer deletion', async () => {
    const foreign = await dealerCreate(ids.otherDealer); const own = await dealerCreate();
    await rejects(() => remove(foreign.id, ids.dealer, crypto.randomUUID(), undefined, true), 'PT404');
    const assignedOnly = await staffLead(); await act('lead_save', { id: assignedOnly.id, title: assignedOnly.title, owner: ids.dealer });
    await rejects(() => remove(assignedOnly.id, ids.dealer, crypto.randomUUID(), undefined, true), 'PT404');
    await act('lead_status', { id: own.id, status: 'CONTACTED' }); await act('lead_status', { id: own.id, status: 'NEW' });
    await rejects(() => remove(own.id, ids.dealer, crypto.randomUUID(), undefined, true), 'PT409');
    const assigned = await dealerCreate(); await act('lead_save', { id: assigned.id, title: assigned.payload.title, owner: ids.sales });
    await rejects(() => remove(assigned.id, ids.dealer, crypto.randomUUID(), undefined, true), 'PT409');
    const editedCustomer = await dealerCreate(); const state = await read(); const lead = state.leads.find(row => row.id === editedCustomer.id)!;
    const customer = state.customers.find(row => row.id === lead.customerId)!;
    await act('customer_save', { id: customer.id, name: customer.name, address: 'Reviewed address' });
    await rejects(() => remove(editedCustomer.id, ids.dealer, crypto.randomUUID(), undefined, true), 'PT409');
    // Owner may review and remove a standalone edited enquiry; its customer/history remain.
    await remove(editedCustomer.id); assert.ok((await read()).customers.some(row => row.id === customer.id));
  });

  test('all open, completed and cancelled follow-up history blocks deletion; any draft quotation blocks it too', async () => {
    for (const status of ['OPEN', 'DONE', 'CANCELLED']) {
      const lead = await staffLead(); const task = (await act('followup_save', { leadId: lead.id, title: 'Real conversation', dueAt: new Date().toISOString(), channel: 'Call' })).data.followups.find(row => row.leadId === lead.id)!;
      if (status === 'DONE') await act('followup_complete', { id: task.id, outcome: 'Actual decision' });
      if (status === 'CANCELLED') await act('followup_cancel', { id: task.id });
      await rejects(() => remove(lead.id), 'PT409');
    }
    const lead = await staffLead(); await act('quote_save', { leadId: lead.id, title: 'Real draft', validUntil: todayIST(), gstEnabled: false,
      items: completeQuoteItems([{ id: 'actual-scope', description: 'Actual scope', quantity: '1', unit: 'job', unitPrice: '0', gstRate: '0' }]) });
    await rejects(() => remove(lead.id), 'PT409');
  });

  test('Won and historical direct or snapshot work-order associations block deletion independently', async () => {
    const won = await staffLead('Approved project', 'WON'); await rejects(() => remove(won.id), 'PT409');
    // Synthetic historical data: older work existed before approval reminders.
    // This setup is local to the test transaction and never sent to production.
    await db.exec('alter table crm.followups disable trigger followups_guard');
    await db.query('delete from crm.followups where lead_id=$1', [won.id]);
    await db.exec('alter table crm.followups enable trigger followups_guard');
    await db.query("update crm.leads set payload=jsonb_set(payload,'{status}','\"NEW\"') where id=$1", [won.id]);
    const before = await read(); assert.ok(!before.followups.some(row => row.leadId === won.id));
    await rejects(() => remove(won.id), 'PT409'); assert.deepEqual(await read(), before);
    // A historical snapshot reference must not be missed when explicit leadId points elsewhere.
    const other = await staffLead();
    await db.exec('alter table crm.workorders disable trigger workorders_guard');
    await db.query("update crm.workorders set payload=jsonb_set(payload,'{snapshot}',jsonb_build_object('leadId',$1::text)) where lead_id=$2", [other.id, won.id]);
    await db.exec('alter table crm.workorders enable trigger workorders_guard');
    await rejects(() => remove(other.id), 'PT409');
    assert.ok((await read()).leads.some(row => row.id === other.id));
  });

  test('revocation, portal role changes, invalid requests and browser roles cannot bypass current authorization or replay', async () => {
    const own = await dealerCreate(); const requestId = crypto.randomUUID(); const old = await revision();
    await remove(own.id, ids.dealer, requestId, old, true);
    await db.query('update crm.members set active=false where user_id=$1', [ids.dealer]);
    await rejects(() => remove(own.id, ids.dealer, requestId, old, true), 'PT403');
    await db.query("update crm.members set active=true,role='OWNER' where user_id=$1", [ids.dealer]);
    await rejects(() => remove(own.id, ids.dealer, requestId, old, true), 'PT403');
    const lead = await staffLead();
    for (const request of ['', 'short', 'invalid request']) await rejects(() => remove(lead.id, ids.owner, request), 'PT400');
    const current = await revision();
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set local role ${role}`); await rejects(() => remove(lead.id, ids.owner, crypto.randomUUID(), current), '42501'); await db.exec('set local role postgres');
    }
    await db.exec('set local role service_role');
    assert.ok(!(await remove(lead.id, ids.owner, crypto.randomUUID(), current)).data.leads.some(row => row.id === lead.id));
  });

  test('examples remain on their existing cleanup path and customers cannot be deleted through the new RPC', async () => {
    await act('load_demo', {}); const state = await read(); const example = state.leads.find(row => row.isDemo)!;
    await rejects(() => remove(example.id), 'PT409');
    await rejects(() => remove(state.customers[0].id), 'PT404');
    await act('clear_demo', {}); assert.ok((await read()).leads.every(row => !row.isDemo));
    assert.ok((await read()).customers.some(row => row.id === baseline.customers[0].id));
  });
});
