import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import type { WorkspaceData } from '../lib/types.ts';
import type { OperationsData } from '../lib/operations-types.ts';
import type { DealerLeadsData } from '../lib/dealer-leads.ts';
import { dealerLeadsDataSchema } from '../lib/dealer-leads-validation.ts';

// Real ordered migrations and PostgreSQL functions; no hosted accounts or data.
// The single PGlite connection tests stale requests, not concurrent connections.
const ids = {
  owner: '30000000-0000-4000-8000-000000000001', manager: '30000000-0000-4000-8000-000000000002',
  sales: '30000000-0000-4000-8000-000000000003', operations: '30000000-0000-4000-8000-000000000004',
  accountant: '30000000-0000-4000-8000-000000000005', dealer: '30000000-0000-4000-8000-000000000006',
  otherDealer: '30000000-0000-4000-8000-000000000007', retired: '30000000-0000-4000-8000-000000000008',
  retiredInactive: '30000000-0000-4000-8000-000000000009', outsider: '30000000-0000-4000-8000-000000000010',
  pending: '30000000-0000-4000-8000-000000000011', banned: '30000000-0000-4000-8000-000000000012',
  anonymous: '30000000-0000-4000-8000-000000000013', removed: '30000000-0000-4000-8000-000000000014',
};
const migrations = [
  '202611230001_crm.sql', '20261123173951_operations.sql', '20261123182424_operations_extensions.sql',
  '20261124072200_accountant_and_lead_status.sql', '20261127062903_lead_expected_kw.sql',
  '20261127065452_manual_lead_won.sql', '20261127072310_won_lead_workorders.sql',
  '20261127082025_quotation_approval_status.sql', '20261127101206_payments_optional_gst_reopen_work.sql',
  '20261127102202_required_quotation_items.sql', '20261127102917_work_order_job_materials.sql',
  '20261127104621_assigned_missing_stock_alerts.sql',
];
const hash = 'a'.repeat(64);
let db: PGlite;
let month: string;
async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T;
}
async function role(value: 'postgres' | 'service_role' | 'anon' | 'authenticated') {
  await db.exec(`SET LOCAL ROLE ${value}`);
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: value })]);
}
async function rejects(run: () => Promise<unknown>, code = 'PT403') {
  await db.exec('SAVEPOINT expected_failure');
  try {
    await assert.rejects(run, (error: unknown) => {
      const value = error as { code?: string; message?: string };
      assert.equal(value.code, code, `${value.code}: ${value.message}`); return true;
    });
  } finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); }
}
async function addMember(key: keyof typeof ids, memberRole: string, actor = ids.owner) {
  return query('SELECT public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) AS result', [actor, ids[key], key, `${key}@example.invalid`, memberRole]);
}
async function workspace(actor = ids.owner): Promise<WorkspaceData> {
  return query('SELECT public.crm_workspace_read($1::uuid,true) AS result', [actor]);
}
async function dealerRead(actor = ids.dealer): Promise<DealerLeadsData> {
  return query('SELECT public.crm_dealer_leads_read($1::uuid) AS result', [actor]);
}
async function dealerCreate(payload: unknown, actor = ids.dealer, requestId = crypto.randomUUID()): Promise<DealerLeadsData> {
  return query('SELECT public.crm_dealer_lead_create($1::uuid,$2,$3::jsonb) AS result', [actor, requestId, JSON.stringify(payload)]);
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload);
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row)); deleted[key] = [];
  }
  const oldEvents = new Set(before.activity.map(row => row.id));
  const members = after.members.filter(row => {
    const old = before.members.find(member => member.userId === row.userId);
    return old && (old.role !== row.role || old.active !== row.active);
  }).map(({ userId, role, active }) => ({ userId, role, active }));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members, audit: after.activity.filter(row => !oldEvents.has(row.id)), clearDemoAudit: false } };
}
async function commit(input: ReturnType<typeof plan>) {
  return query<{ data: WorkspaceData }>('SELECT public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result',
    [input.actor, input.revision, input.requestId, input.action, hash, JSON.stringify(input.changes), input.message]);
}
async function core(action: string, payload: unknown, actor = ids.owner) { return commit(plan(await workspace(actor), action, payload)); }
async function operations(action: string, payload: unknown) {
  const before = await query<OperationsData>('SELECT public.crm_operations_v2_read($1::uuid,$2) AS result', [ids.owner, month]);
  return query<{ data: OperationsData }>('SELECT public.crm_operations_v2_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result',
    [ids.owner, before.revision, crypto.randomUUID(), action, hash, JSON.stringify(payload), month]);
}
async function counts() {
  await role('postgres');
  const result = await query(`SELECT jsonb_build_object('revision',(SELECT revision FROM crm.workspace),'customers',(SELECT count(*) FROM crm.customers),
    'leads',(SELECT count(*) FROM crm.leads),'audit',(SELECT count(*) FROM crm.audit_events),'receipts',(SELECT count(*) FROM crm.mutation_receipts),
    'operationsRevision',(SELECT revision FROM crm.operations_state),'movements',(SELECT count(*) FROM crm.stock_movements)) AS result`);
  await role('service_role'); return result;
}

describe('Dealer portal: real database isolation and team upgrades', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,banned_until timestamptz,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}',is_anonymous boolean NOT NULL DEFAULT false);
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'; $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.role() TO anon,authenticated,service_role;
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const file of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    // The upgrade sees real existing Viewer memberships, including a disabled one.
    await db.exec('BEGIN');
    for (const key of ['owner', 'retired', 'retiredInactive'] as const) {
      await db.query('INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),$3)', [ids[key], `${key}@example.invalid`, JSON.stringify({ name: key })]);
    }
    await role('service_role'); await query('SELECT public.crm_bootstrap_owner($1::uuid) AS result', [ids.owner]);
    await addMember('retired', 'VIEWER'); await addMember('retiredInactive', 'VIEWER');
    await role('postgres'); await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.retiredInactive]);
    await db.exec('COMMIT');
    for (const file of ['20261127104930_dealer_lead_portal.sql', '20261127105440_work_order_paper_documents.sql',
      '20261127111750_compact_workspace_refresh.sql', '20261127113600_approved_lead_followups.sql',
      '20261127122538_safe_lead_deletion.sql', '20261127122544_dealer_assigned_projects.sql']) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
  });
  beforeEach(async () => {
    await db.exec('BEGIN');
    for (const [key, id] of Object.entries(ids)) await db.query('INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),$3) ON CONFLICT DO NOTHING', [id, `${key}@example.invalid`, JSON.stringify({ name: key })]);
    month = await query<string>("SELECT to_char(clock_timestamp() at time zone 'Asia/Kolkata','YYYY-MM') AS result");
    await role('service_role');
    for (const [key, memberRole] of Object.entries({ manager: 'MANAGER', sales: 'SALES', operations: 'OPERATIONS', accountant: 'ACCOUNTANT', dealer: 'DEALER', otherDealer: 'DEALER', pending: 'DEALER', banned: 'DEALER', anonymous: 'DEALER', removed: 'DEALER' })) await addMember(key as keyof typeof ids, memberRole);
    await role('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.removed]);
    await db.query('UPDATE auth.users SET email_confirmed_at=null WHERE id=$1', [ids.pending]);
    await db.query("UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=$1", [ids.banned]);
    await db.query('UPDATE auth.users SET is_anonymous=true WHERE id=$1', [ids.anonymous]);
    await role('service_role');
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  after(async () => { await db.close(); });

  test('existing Viewers become Dealers without granting staff access or reactivating disabled accounts', async () => {
    const members = (await workspace()).members;
    assert.deepEqual(members.filter(row => [ids.retired, ids.retiredInactive].includes(row.userId)).map(row => [row.role, row.active]).sort(), [['DEALER', false], ['DEALER', true]]);
    assert.deepEqual((await dealerRead(ids.retired)).leads, []);
    await rejects(() => workspace(ids.retired)); await rejects(() => dealerRead(ids.retiredInactive));
    assert.equal(members.some(row => String(row.role) === 'VIEWER'), false);
  });

  test('dealer submissions persist decimals and only expose the submitting dealer and allowed progress fields', async () => {
    const own = await dealerCreate({ title: 'Roof enquiry', contact: 'Actual customer', phone: '9876543210', siteAddress: 'Real site', expectedKw: 5.25 });
    await dealerCreate({ title: 'Private second dealer enquiry' }, ids.otherDealer);
    await core('lead_save', { title: 'Internal enquiry', notes: 'Private internal notes', value: '140000' });
    assert.deepEqual(Object.keys(own).sort(), ['assignedSites', 'leads', 'revision', 'user']);
    assert.deepEqual(Object.keys(own.user).sort(), ['name', 'role', 'userId']);
    assert.deepEqual(Object.keys(own.leads[0]).sort(), ['canDelete', 'contact', 'createdAt', 'deleteBlockedReason', 'expectedKw', 'id', 'phone', 'siteAddress', 'status', 'title', 'updatedAt']);
    assert.equal(own.leads[0].canDelete, true); assert.equal(own.leads[0].deleteBlockedReason, null);
    assert.deepEqual(dealerLeadsDataSchema.parse(own), own);
    assert.equal(own.leads[0].expectedKw, 5.25); assert.equal(own.leads[0].status, 'NEW');
    const all = await workspace(); assert.equal(all.leads.length, 3); assert.equal(all.customers.length, 3);
    assert.deepEqual((await dealerRead()).leads.map(row => row.id), [own.leads[0].id]);
    const other = await dealerRead(ids.otherDealer);
    assert.equal(other.leads.length, 1); assert.notEqual(other.leads[0].id, own.leads[0].id);
    assert.equal(JSON.stringify(await dealerRead()).includes('Private'), false);
  });

  test('internal customer association uses real supplied contact or title without inventing contact information', async () => {
    const first = (await dealerCreate({ title: '  Roof A  ', contact: '  Named contact  ', phone: '  12345  ' })).leads[0];
    const second = (await dealerCreate({ title: 'Roof B', expectedKw: 0 })).leads.find(row => row.id !== first.id)!;
    const data = await workspace();
    const customer = (id: string) => data.customers.find(row => row.id === data.leads.find(lead => lead.id === id)!.customerId)!;
    assert.deepEqual([customer(first.id).name, customer(first.id).contact, customer(first.id).phone, customer(first.id).email], ['Named contact', 'Named contact', '12345', '']);
    assert.deepEqual([customer(second.id).name, customer(second.id).contact, customer(second.id).phone, customer(second.id).email], ['Roof B', '', '', '']);
    assert.equal(first.expectedKw, null); assert.equal(second.expectedKw, 0);
  });

  test('admin-assigned leads appear only as scoped project progress and immediately follow reassignment', async () => {
    for (const [title, owner] of [['Assigned roof A', ids.dealer], ['Assigned roof B', ids.otherDealer], ['Assigned roof C', ids.retired]]) {
      await core('lead_save', { title, owner, expectedKw: 5.25, contact: 'PRIVATE_CONTACT', phone: 'PRIVATE_PHONE', notes: 'PRIVATE_NOTES', value: '10000' });
    }
    for (const [actor, title] of [[ids.dealer, 'Assigned roof A'], [ids.otherDealer, 'Assigned roof B'], [ids.retired, 'Assigned roof C']]) {
      const snapshot = await dealerRead(actor);
      assert.deepEqual(snapshot.leads, []); assert.equal(snapshot.assignedSites.length, 1);
      const project = snapshot.assignedSites[0];
      assert.equal(project.title, title); assert.equal(project.leadStatus, 'NEW'); assert.equal(project.expectedKw, 5.25);
      assert.deepEqual(project.assignedVia, ['LEAD']); assert.equal(project.workOrderId, null);
      assert.equal('canDelete' in project, false);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|customerId|contact|phone|notes|quotation|payment|members/);
      assert.deepEqual(dealerLeadsDataSchema.parse(snapshot), snapshot);
    }
    const lead = (await workspace()).leads.find(row => row.title === 'Assigned roof A')!;
    await core('lead_save', { id: lead.id, title: lead.title, owner: ids.otherDealer });
    assert.deepEqual((await dealerRead()).assignedSites, []);
    assert.equal((await dealerRead(ids.otherDealer)).assignedSites.length, 2);
    await core('lead_save', { id: lead.id, title: lead.title, owner: '' });
    assert.equal((await dealerRead(ids.otherDealer)).assignedSites.length, 1);
  });

  test('another dealer can receive an assigned project without receiving the submitting dealer contact or delete permission', async () => {
    const created = await dealerCreate({ title: 'Shared assigned project', contact: 'PRIVATE_SUBMITTER_CONTACT', phone: 'PRIVATE_PHONE', expectedKw: 7.5 });
    const lead = created.leads[0];
    await core('lead_save', { id: lead.id, title: lead.title, contact: lead.contact, phone: lead.phone, owner: ids.otherDealer });
    const submitted = await dealerRead(); const assigned = await dealerRead(ids.otherDealer);
    assert.equal(submitted.leads[0].contact, 'PRIVATE_SUBMITTER_CONTACT'); assert.equal(submitted.leads[0].canDelete, false);
    assert.ok(submitted.leads[0].deleteBlockedReason); assert.deepEqual(submitted.assignedSites, []);
    assert.deepEqual(assigned.leads, []); assert.equal(assigned.assignedSites[0].leadId, lead.id);
    assert.doesNotMatch(JSON.stringify(assigned), /PRIVATE_|contact|phone|dealerId|canDelete/);
    await rejects(() => query('SELECT public.crm_dealer_lead_delete($1::uuid,$2::bigint,$3,$4) AS result',
      [ids.otherDealer, assigned.revision, crypto.randomUUID(), lead.id]), 'PT404');
    await core('lead_save', { id: lead.id, title: lead.title, owner: '' });
    assert.deepEqual((await dealerRead(ids.otherDealer)).assignedSites, []);
    assert.equal((await dealerRead()).leads[0].canDelete, false); // History still prevents deletion after unassignment.
  });

  test('work-owner and linked attendance-site routes expose progress once without commercial records or sibling jobs', async () => {
    await core('lead_save', { title: 'Assigned delivery project', status: 'WON', owner: ids.sales, expectedKw: 8 });
    const order = (await workspace()).workorders[0];
    await core('workorder_save', { id: order.id, owner: ids.dealer, status: 'ACTIVE' });
    await core('milestone_add', { workorderId: order.id, title: 'PRIVATE milestone detail' });
    const milestone = (await workspace()).workorders[0].milestones[0];
    await core('milestone_complete', { workorderId: order.id, milestoneId: milestone.id });
    let snapshot = await dealerRead();
    assert.equal(snapshot.assignedSites[0].workOrderStatus, 'ACTIVE');
    assert.deepEqual(snapshot.assignedSites[0].assignedVia, ['WORK_ORDER']);
    assert.equal(snapshot.assignedSites[0].completedMilestones, 1);
    assert.equal(snapshot.assignedSites[0].totalMilestones, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|snapshot|customerName|quoteId|price|totals|payment/);
    const sites = (await operations('site_save', { name: 'Assigned delivery site', address: 'Actual site location', workOrderId: order.id })).data.extension.sites;
    const site = sites.find(row => row.name === 'Assigned delivery site')!;
    await operations('site_assign', { userId: ids.dealer, siteId: site.id });
    snapshot = await dealerRead();
    assert.equal(snapshot.assignedSites.length, 1); assert.deepEqual(snapshot.assignedSites[0].assignedVia, ['WORK_ORDER', 'SITE']);
    assert.equal(snapshot.assignedSites[0].siteId, site.id); assert.equal(snapshot.assignedSites[0].siteAddress, 'Actual site location');
    await core('lead_save', { id: order.leadId, title: order.title, owner: ids.dealer });
    assert.deepEqual((await dealerRead()).assignedSites[0].assignedVia, ['LEAD', 'WORK_ORDER', 'SITE']);
    await core('lead_save', { id: order.leadId, title: order.title, owner: ids.sales });
    await core('workorder_save', { id: order.id, owner: ids.sales, status: 'ACTIVE' });
    assert.deepEqual((await dealerRead()).assignedSites[0].assignedVia, ['SITE']);
    await core('lead_save', { title: 'Unassigned neighboring project', status: 'WON', owner: ids.sales });
    assert.equal((await dealerRead()).assignedSites.length, 1);
    await operations('site_assign', { userId: ids.dealer, siteId: null });
    assert.deepEqual((await dealerRead()).assignedSites, []);
  });

  test('standalone site assignment is current, read-only and removed when site or member is inactive', async () => {
    const first = (await operations('site_save', { name: 'First site', address: 'First address' })).data.extension.sites.find(row => row.name === 'First site')!;
    const second = (await operations('site_save', { name: 'Second site' })).data.extension.sites.find(row => row.name === 'Second site')!;
    const revision = (await dealerRead()).revision;
    await operations('site_assign', { userId: ids.dealer, siteId: first.id });
    const data = await dealerRead();
    assert.equal(data.revision, revision); // Operations assignments must never be hidden by same-revision caching.
    assert.equal(data.assignedSites[0].siteId, first.id); assert.equal(data.assignedSites[0].leadStatus, null);
    assert.equal(data.assignedSites[0].workOrderStatus, null); assert.deepEqual(data.assignedSites[0].assignedVia, ['SITE']);
    await operations('site_assign', { userId: ids.dealer, siteId: second.id });
    assert.deepEqual((await dealerRead()).assignedSites.map(row => row.siteId), [second.id]);
    await role('postgres'); await db.query('UPDATE crm.construction_sites SET active=false WHERE id=$1', [second.id]); await role('service_role');
    assert.deepEqual((await dealerRead()).assignedSites, []);
    await role('postgres'); await db.query('UPDATE crm.construction_sites SET active=true WHERE id=$1', [second.id]); await role('service_role');
    await core('member_active', { userId: ids.dealer, active: false });
    await rejects(() => dealerRead());
    await core('member_active', { userId: ids.dealer, active: true });
    assert.equal((await dealerRead()).assignedSites[0].siteId, second.id);
    await core('member_role', { userId: ids.dealer, role: 'SALES' });
    await rejects(() => dealerRead());
  });

  test('delete eligibility shares the mutation guard and deletion returns current assigned projects', async () => {
    const untouched = (await dealerCreate({ title: 'Untouched own enquiry' })).leads[0];
    const protectedLead = (await dealerCreate({ title: 'Assigned own enquiry' })).leads.find(row => row.id !== untouched.id)!;
    await core('lead_save', { id: protectedLead.id, title: protectedLead.title, owner: ids.dealer });
    const before = await dealerRead();
    assert.equal(before.leads.find(row => row.id === untouched.id)!.canDelete, true);
    assert.equal(before.leads.find(row => row.id === protectedLead.id)!.canDelete, false);
    await role('postgres');
    for (const lead of before.leads) {
      const reason = await query<string | null>('SELECT crm.dealer_lead_delete_blocked_reason(l,$1::uuid) AS result FROM crm.leads l WHERE id=$2', [ids.dealer, lead.id]);
      assert.equal(lead.canDelete, reason === null); assert.equal(lead.deleteBlockedReason, reason);
    }
    await role('service_role');
    await rejects(() => query('SELECT public.crm_dealer_lead_delete($1::uuid,$2::bigint,$3,$4) AS result',
      [ids.dealer, before.revision, crypto.randomUUID(), protectedLead.id]), 'PT409');
    const result = await query<{ data: DealerLeadsData }>('SELECT public.crm_dealer_lead_delete($1::uuid,$2::bigint,$3,$4) AS result',
      [ids.dealer, before.revision, crypto.randomUUID(), untouched.id]);
    assert.equal(result.data.revision, before.revision + 1);
    assert.deepEqual(result.data.assignedSites, before.assignedSites);
    assert.deepEqual(result.data.leads.map(row => row.id), [protectedLead.id]);
    assert.deepEqual(dealerLeadsDataSchema.parse(result.data), result.data);
    const unchanged = await counts(); await dealerRead(); assert.deepEqual(await counts(), unchanged);
  });

  test('staff edits and status progress preserve immutable dealer origin independently of mutable staff ownership', async () => {
    const lead = (await dealerCreate({ title: 'Submitted enquiry', expectedKw: 7.5 })).leads[0];
    const other = (await dealerCreate({ title: 'Other enquiry' }, ids.otherDealer)).leads[0];
    await core('lead_save', { id: lead.id, title: 'Confirmed enquiry', owner: ids.sales, notes: 'Private pricing notes', value: '90000' });
    await core('lead_status', { id: lead.id, status: 'WON' });
    const own = await dealerRead();
    assert.deepEqual(own.leads.map(row => [row.id, row.title, row.status, row.expectedKw]), [[lead.id, 'Confirmed enquiry', 'WON', 7.5]]);
    assert.deepEqual((await dealerRead(ids.otherDealer)).leads.map(row => [row.id, row.status]), [[other.id, 'NEW']]);
    const full = await workspace(); assert.equal(full.workorders.length, 1); assert.equal(full.leads.find(row => row.id === lead.id)!.owner, ids.sales);
    assert.equal(JSON.stringify(own).includes('Private pricing'), false); assert.equal('workorders' in own, false);
    await role('postgres');
    assert.equal(await query('SELECT dealer_id::text AS result FROM crm.leads WHERE id=$1', [lead.id]), ids.dealer);
    await rejects(() => db.query('UPDATE crm.leads SET dealer_id=$1 WHERE id=$2', [ids.otherDealer, lead.id]));
    await rejects(() => db.query('UPDATE crm.leads SET dealer_id=null WHERE id=$1', [lead.id]));
  });

  test('database rejects forged properties, invalid numeric kW and oversize fields atomically', async () => {
    const before = await counts();
    const invalid = [
      {}, { title: '' }, { title: ' '.repeat(10) }, { title: 'x'.repeat(201) }, { title: 'Enquiry', contact: 'x'.repeat(201) },
      { title: 'Enquiry', phone: 'x'.repeat(41) }, { title: 'Enquiry', siteAddress: 'x'.repeat(2001) },
      ...[-1, '5.5', true, {}, []].map(expectedKw => ({ title: 'Enquiry', expectedKw })),
      ...['status', 'notes', 'value', 'email', 'customerId', 'owner', 'dealerId', 'isDemo', 'id'].map(key => ({ title: 'Enquiry', [key]: 'forged' })),
    ];
    for (const payload of invalid) await rejects(() => dealerCreate(payload), 'PT400');
    await rejects(() => query('SELECT public.crm_dealer_lead_create($1::uuid,$2,$3::jsonb) AS result', [ids.dealer, crypto.randomUUID(), '{"title":"Too large","expectedKw":1e309}']), 'PT400');
    await rejects(() => dealerCreate({ title: 'Enquiry' }, ids.dealer, 'short'), 'PT400');
    assert.deepEqual(await counts(), before);
    assert.equal((await dealerCreate({ title: 'Optional kW', expectedKw: null })).leads[0].expectedKw, null);
  });

  test('same-request retry creates one lead/customer and returns current progress, with actor and payload conflicts rejected', async () => {
    const requestId = crypto.randomUUID(); const payload = { title: 'One submission', expectedKw: 2.125 };
    const original = await dealerCreate(payload, ids.dealer, requestId); const afterCreate = await counts();
    assert.deepEqual(await dealerCreate(payload, ids.dealer, requestId), original);
    assert.deepEqual(await counts(), afterCreate);
    await core('lead_status', { id: original.leads[0].id, status: 'CONTACTED' });
    const beforeRetry = await counts();
    assert.equal((await dealerCreate(payload, ids.dealer, requestId)).leads[0].status, 'CONTACTED');
    assert.deepEqual(await counts(), beforeRetry);
    await rejects(() => dealerCreate({ ...payload, expectedKw: 3 }, ids.dealer, requestId), 'PT409');
    await rejects(() => dealerCreate(payload, ids.otherDealer, requestId), 'PT409');
    assert.deepEqual(await counts(), beforeRetry);
  });

  test('Dealers cannot read staff workspaces, exports, stock, job materials, alerts, attendance or attachment details', async () => {
    await dealerCreate({ title: 'Own visible enquiry' });
    const reads: [string, unknown[]][] = [
      ['SELECT public.crm_workspace_read($1::uuid,true) AS result', [ids.dealer]],
      ['SELECT public.crm_operations_read($1::uuid,$2) AS result', [ids.dealer, month]],
      ['SELECT public.crm_operations_v2_read($1::uuid,$2) AS result', [ids.dealer, month]],
      ['SELECT public.crm_operations_export($1::uuid) AS result', [ids.dealer]],
      ['SELECT public.crm_operations_v2_export($1::uuid) AS result', [ids.dealer]],
      ['SELECT public.crm_job_materials_read($1::uuid,$2,$3) AS result', [ids.dealer, month, 'any-work-order']],
      ['SELECT public.crm_material_alerts_read($1::uuid,null,\'ALL\',1,\'\') AS result', [ids.dealer]],
      ['SELECT public.crm_team_activity_read($1::uuid,$2,null,\'all\',1) AS result', [ids.dealer, month]],
      ['SELECT public.crm_expense_receipt_access($1::uuid,$2::uuid) AS result', [ids.dealer, crypto.randomUUID()]],
    ];
    for (const [sql, values] of reads) await rejects(() => query(sql, values));
    assert.equal((await dealerRead()).leads.length, 1);
  });

  test('Dealers cannot mutate staff CRM, document filing, stock, alerts, payments, attendance or attachments', async () => {
    const prepared = plan(await workspace(), 'lead_save', { title: 'Forged staff enquiry' });
    prepared.actor = ids.dealer;
    const before = await counts();
    for (const action of ['lead_save', 'lead_status', 'customer_save', 'workorder_paper_filing', 'member_role', 'load_demo']) {
      await rejects(() => query('SELECT public.crm_mutation_prepare($1::uuid,$2,$3,$4) AS result', [ids.dealer, crypto.randomUUID(), action, hash]));
      await rejects(() => commit({ ...prepared, action }));
    }
    for (const fn of ['crm_operations_mutate', 'crm_operations_v2_mutate']) {
      for (const action of ['stock_move', 'stock_item_save', 'job_material_issue', 'job_filing_complete', 'payment_record', 'attendance_check_in', 'expense_save']) {
        await rejects(() => query(`SELECT public.${fn}($1::uuid,0,$2,$3,$4,$5::jsonb,$6) AS result`, [ids.dealer, crypto.randomUUID(), action, hash, '{}', month]));
      }
    }
    for (const action of ['material_alert_create', 'material_alert_resolve']) {
      await rejects(() => query('SELECT public.crm_material_alerts_mutate($1::uuid,0,$2,$3,$4,\'{}\'::jsonb,null,\'OPEN\',1,\'\') AS result', [ids.dealer, crypto.randomUUID(), action, hash]));
    }
    const receiptId = crypto.randomUUID();
    await rejects(() => query('SELECT public.crm_expense_receipt_reserve($1::uuid,$2::uuid,$3,\'bill.png\',\'image/png\',1024,$4) AS result', [ids.dealer, receiptId, crypto.randomUUID(), hash]));
    await rejects(() => query('SELECT public.crm_expense_receipt_complete($1::uuid,$2::uuid,\'image/png\',1024,$3) AS result', [ids.dealer, receiptId, hash]));
    await rejects(() => query('SELECT public.crm_expense_receipt_remove($1::uuid,$2::uuid) AS result', [ids.dealer, receiptId]));
    assert.deepEqual(await counts(), before);
  });

  test('inactive, unconfirmed, banned, anonymous and nonmembers cannot read, create or replay dealer requests', async () => {
    for (const actor of [ids.removed, ids.pending, ids.banned, ids.anonymous, ids.outsider, ids.retiredInactive]) {
      await rejects(() => dealerRead(actor)); await rejects(() => dealerCreate({ title: 'Denied enquiry' }, actor));
      await rejects(() => query('SELECT public.crm_account_member($1::uuid) AS result', [actor]));
    }
    const requestId = crypto.randomUUID(); const payload = { title: 'Previously allowed enquiry' };
    await dealerCreate(payload, ids.dealer, requestId);
    await core('member_active', { userId: ids.dealer, active: false });
    await rejects(() => dealerCreate(payload, ids.dealer, requestId)); await rejects(() => dealerRead());
  });

  test('current roles are rechecked for stale staff writes, dealer writes and receipt replay', async () => {
    const stale = plan(await workspace(ids.sales), 'lead_save', { title: 'Stale staff creation' });
    await core('member_role', { userId: ids.sales, role: 'DEALER' });
    await rejects(() => commit(stale)); await rejects(() => workspace(ids.sales));
    assert.deepEqual((await dealerRead(ids.sales)).leads, []);
    const requestId = crypto.randomUUID(); const payload = { title: 'Originally dealer enquiry' };
    const own = await dealerCreate(payload, ids.dealer, requestId);
    await core('member_role', { userId: ids.dealer, role: 'SALES' });
    await rejects(() => dealerRead()); await rejects(() => dealerCreate(payload, ids.dealer, requestId));
    await rejects(() => dealerCreate({ title: 'Stale dealer form' }));
    assert.ok((await workspace(ids.dealer)).leads.some(row => row.id === own.leads[0].id));
    await core('member_role', { userId: ids.dealer, role: 'DEALER' });
    assert.equal((await dealerRead()).leads[0].id, own.leads[0].id);
  });

  test('Owner can invite and set up Dealers while retired Viewer roles and dealer administrative actions are rejected', async () => {
    await addMember('outsider', 'DEALER');
    assert.deepEqual(await dealerRead(ids.outsider), { revision: (await workspace()).revision, assignedSites: [], user: { userId: ids.outsider, name: 'outsider', role: 'DEALER' }, leads: [] });
    const account = await query<{ userId: string; role: string }>('SELECT public.crm_account_member($1::uuid) AS result', [ids.outsider]);
    assert.equal(account.userId, ids.outsider); assert.equal(account.role, 'DEALER');
    const link = await query<{ userId: string }>('SELECT public.crm_authorize_member_link($1::uuid,$2::uuid) AS result', [ids.owner, ids.outsider]);
    assert.equal(link.userId, ids.outsider);
    await rejects(() => addMember('outsider', 'VIEWER'), 'PT400');
    await rejects(() => addMember('outsider', 'DEALER', ids.dealer));
    await rejects(() => query('SELECT public.crm_authorize_member_link($1::uuid,$2::uuid) AS result', [ids.dealer, ids.owner]));
    await rejects(() => query('SELECT public.crm_bootstrap_owner($1::uuid) AS result', [ids.dealer]), 'PT409');
    for (const actor of [ids.owner, ids.manager, ids.sales, ids.operations, ids.accountant]) {
      await rejects(() => dealerRead(actor)); await rejects(() => dealerCreate({ title: 'Wrong portal' }, actor));
      assert.equal((await workspace(actor)).user.userId, actor);
    }
  });

  test('all portal RPCs retain service-only execution and private tables cannot be queried directly', async () => {
    const functions = await db.query<{ name: string; secure: boolean; config: string[]; anon: boolean; authenticated: boolean; service: boolean }>(`SELECT p.proname name,p.prosecdef secure,p.proconfig config,
      has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,
      has_function_privilege('service_role',p.oid,'execute') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('crm_account_member','crm_dealer_leads_read','crm_dealer_lead_create')`);
    assert.equal(functions.rows.length, 3);
    for (const fn of functions.rows) {
      assert.deepEqual([fn.secure, fn.anon, fn.authenticated, fn.service], [true, false, false, true], fn.name);
      assert.ok(fn.config.includes('search_path=""'));
    }
    for (const selectedRole of ['anon', 'authenticated'] as const) {
      await role(selectedRole);
      await rejects(() => dealerRead(), '42501'); await rejects(() => dealerCreate({ title: 'Direct browser forgery' }), '42501');
      await rejects(() => query('SELECT public.crm_account_member($1::uuid) AS result', [ids.owner]), '42501');
      await rejects(() => db.query('SELECT * FROM crm.leads'), '42501');
    }
    await role('service_role');
    await rejects(() => db.query('SELECT * FROM crm.leads'), '42501');
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated' })]);
    await rejects(() => dealerRead());
  });
});
