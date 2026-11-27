import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import type { Lead, WorkspaceData } from '../lib/types.ts';

const migration = '20261127125030_lead_status_assignment.sql';
const ids = Object.fromEntries(['owner', 'manager', 'sales', 'operations', 'accountant', 'dealer', 'pending', 'banned', 'anonymous', 'inactive'].map((key, i) => [key, `77000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`]));
let db: PGlite; let baseline: WorkspaceData; let leadId: string;
async function query<T>(sql: string, values: unknown[] = []): Promise<T> { return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T; }
async function read(actor = ids.owner): Promise<WorkspaceData> { return query('select public.crm_workspace_read($1::uuid,false) result', [actor]); }
async function rejects(run: () => Promise<unknown>, code: string) {
  await db.exec('savepoint expected_failure');
  try { await assert.rejects(run, (error: unknown) => { const value = error as { code: string; message: string }; assert.equal(value.code, code, value.message); return true; }); }
  finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload); const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row)); deleted[key] = [];
  }
  const events = new Set(before.activity.map(row => row.id));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members: [], audit: after.activity.filter(row => !events.has(row.id)), clearDemoAudit: false } };
}
async function commit(r: ReturnType<typeof plan>) {
  return query<{ data: WorkspaceData }>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result', [r.actor, r.revision, r.requestId, r.action, 'a'.repeat(64), JSON.stringify(r.changes), r.message]);
}
async function act(action: string, payload: unknown, actor = ids.owner) { return commit(plan(await read(actor), action, payload)); }

describe('status and assignee changes in the real workspace transaction', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'$$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql') && file < migration).sort()) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const [name, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result', [ids.owner]);
    for (const name of Object.keys(ids).filter(name => name !== 'owner')) await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [ids.owner, ids[name], name, `${name}@example.invalid`, name === 'pending' ? 'DEALER' : ['manager','sales','operations','accountant','dealer'].includes(name) ? name.toUpperCase() : 'OPERATIONS']);
    await db.query('update auth.users set email_confirmed_at=null where id=$1', [ids.pending]);
    await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [ids.banned]);
    await db.query('update auth.users set is_anonymous=true where id=$1', [ids.anonymous]);
    await db.query('update crm.members set active=false where user_id=$1', [ids.inactive]);
    leadId = (await act('lead_save', { title: 'Real visit project', owner: ids.sales })).data.leads[0].id;
    baseline = await read();
    await db.exec((await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
  });
  beforeEach(async () => { await db.exec('begin'); }); afterEach(async () => { await db.exec('rollback'); }); after(async () => { await db.close(); });

  test('upgrade is unchanged; Owner and Manager atomically assign Contacted/Site visit, reassign and unassign', async () => {
    assert.deepEqual(await read(), baseline);
    for (const [index, assignee] of ['owner','manager','sales','operations','accountant','dealer'].entries()) {
      const before = await read(); const actor = index % 2 ? ids.manager : ids.owner; const status = index ? 'SITE_VISIT' : 'CONTACTED';
      const request = plan(await read(actor), 'lead_status', { id: leadId, status, owner: ids[assignee] });
      const first = await commit(request); assert.deepEqual(await commit(request), first);
      const lead = first.data.leads[0]; assert.equal(lead.status, status); assert.equal(lead.owner, ids[assignee]);
      assert.deepEqual(lead, { ...before.leads[0], status, owner: ids[assignee], updatedAt: lead.updatedAt });
      assert.equal(first.data.revision, before.revision + 1); assert.equal(first.data.workorders.length, 0); assert.equal(first.data.followups.length, 0);
    }
    const dealer = await query<{ assignedSites: { leadId: string }[] }>('select public.crm_dealer_leads_read($1::uuid) result', [ids.dealer]);
    assert.ok(dealer.assignedSites.some(row => row.leadId === leadId));
    const unassigned = await act('lead_status', { id: leadId, status: 'SITE_VISIT', owner: '' }); assert.equal(unassigned.data.leads[0].owner, '');
    assert.equal((await query<{ assignedSites: unknown[] }>('select public.crm_dealer_leads_read($1::uuid) result', [ids.dealer])).assignedSites.length, 0);
  });

  test('old clients preserve inactive and missing saved assignees; changes require current active membership', async () => {
    for (const historicalOwner of [ids.inactive, 'former-member']) {
      await db.query("update crm.leads set payload=jsonb_set(payload,'{owner}',to_jsonb($1::text)) where id=$2", [historicalOwner, leadId]);
      assert.equal((await act('lead_status', { id: leadId, status: 'CONTACTED' })).data.leads[0].owner, historicalOwner);
    }
    const before = await read(); const valid = plan(before, 'lead_status', { id: leadId, status: 'SITE_VISIT', owner: ids.operations });
    for (const owner of [ids.inactive, crypto.randomUUID(), null, true]) {
      const forged = structuredClone(valid); forged.changes.upserts.leads[0] = { ...(forged.changes.upserts.leads[0] as Lead), owner };
      await rejects(() => commit(forged), 'PT400'); assert.deepEqual(await read(), before);
    }
    // A previously eligible assignee becomes inactive between preparation and commit.
    await db.query('update crm.members set active=false where user_id=$1', [ids.operations]);
    const deactivated = await read();
    await rejects(() => commit(valid), 'PT400'); assert.deepEqual(await read(), deactivated);
  });

  test('invited Dealers can receive assignments but cannot read them until their account is confirmed', async () => {
    const assigned = await act('lead_status', { id: leadId, status: 'CONTACTED', owner: ids.pending });
    assert.equal(assigned.data.leads[0].owner, ids.pending);
    await rejects(() => query('select public.crm_dealer_leads_read($1::uuid) result', [ids.pending]), 'PT403');
    await db.query('update auth.users set email_confirmed_at=now() where id=$1', [ids.pending]);
    assert.ok((await query<{ assignedSites: { leadId: string }[] }>('select public.crm_dealer_leads_read($1::uuid) result', [ids.pending])).assignedSites.some(row => row.leadId === leadId));
    // Recipient eligibility never changes the authenticated actor requirements.
    await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [ids.manager]);
    const request = plan(await read(), 'lead_status', { id: leadId, status: 'SITE_VISIT', owner: ids.sales });
    await rejects(() => commit({ ...request, actor: ids.manager }), 'PT403');
  });

  test('forged scope changes, other target stages and unprivileged actors cannot use assignment as a bypass', async () => {
    const before = await read(); const request = plan(before, 'lead_status', { id: leadId, status: 'CONTACTED', owner: ids.operations });
    for (const actor of [ids.sales, ids.operations, ids.accountant, ids.dealer]) await rejects(() => commit({ ...request, actor }), 'PT403');
    for (const status of ['NEW','QUOTED','NEGOTIATION','WON','LOST']) {
      const forged = structuredClone(request); forged.changes.upserts.leads[0] = { ...(forged.changes.upserts.leads[0] as Lead), status, lostReason: status === 'LOST' ? 'Actual reason' : '' };
      await rejects(() => commit(forged), 'PT400');
    }
    for (const change of [{ title: 'Changed title' }, { expectedKw: 40 }, { phone: 'Altered phone' }, { customerId: crypto.randomUUID() }]) {
      const forged = structuredClone(request); forged.changes.upserts.leads[0] = { ...(forged.changes.upserts.leads[0] as Lead), ...change };
      await rejects(() => commit(forged), 'PT400');
    }
    assert.deepEqual(await read(), before);
    await act('lead_save', { title: 'Concurrent edit' }); await rejects(() => commit(request), 'PT409');
  });

  test('Lost reopening, terminal Won and automatic approved work/follow-up rules remain unchanged', async () => {
    await act('lead_status', { id: leadId, status: 'LOST', lostReason: 'Customer postponed' });
    assert.throws(() => plan(baseline, 'lead_status', { id: leadId, status: 'WON', owner: ids.operations }));
    const lost = await read(); const forged = plan(baseline, 'lead_status', { id: leadId, status: 'SITE_VISIT', owner: ids.operations }); forged.revision = lost.revision;
    await rejects(() => commit(forged), 'PT400');
    await act('lead_status', { id: leadId, status: 'NEW' });
    await act('lead_status', { id: leadId, status: 'SITE_VISIT', owner: ids.operations });
    const won = (await act('lead_status', { id: leadId, status: 'WON' })).data;
    assert.equal(won.leads[0].owner, ids.operations); assert.equal(won.workorders[0].owner, ids.operations); assert.equal(won.followups[0].owner, ids.operations);
    const attempt = plan(baseline, 'lead_status', { id: leadId, status: 'CONTACTED', owner: ids.dealer }); attempt.revision = won.revision;
    await rejects(() => commit(attempt), 'PT400'); assert.deepEqual(await read(), won);
  });
});
