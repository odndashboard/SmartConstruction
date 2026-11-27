import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { todayIST } from '../lib/finance.ts';
import type { WorkspaceData } from '../lib/types.ts';
import type { OperationsData } from '../lib/operations-types.ts';

const migration = '20261127111750_compact_workspace_refresh.sql';
const ids = {
  owner: '73000000-0000-4000-8000-000000000001', manager: '73000000-0000-4000-8000-000000000002',
  operations: '73000000-0000-4000-8000-000000000003', sales: '73000000-0000-4000-8000-000000000004',
  accountant: '73000000-0000-4000-8000-000000000005', dealer: '73000000-0000-4000-8000-000000000006',
  invite: '73000000-0000-4000-8000-000000000007', unknown: '73000000-0000-4000-8000-000000000008',
};
type Compact = { unchanged: true; revision: number; user: WorkspaceData['user'] };
let db: PGlite; let baseline: WorkspaceData; let originalReadDefinition: string; let orderId: string;
const month = todayIST().slice(0, 7); const hash = 'a'.repeat(64);
async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T;
}
async function read(actor = ids.owner): Promise<WorkspaceData> {
  return query('select public.crm_workspace_read($1::uuid,false) result', [actor]);
}
async function refresh(revision: number | null, actor = ids.owner): Promise<WorkspaceData | Compact> {
  return query('select public.crm_workspace_refresh($1::uuid,$2::bigint) result', [actor, revision]);
}
async function role(value: 'postgres' | 'service_role' | 'anon' | 'authenticated') {
  await db.exec(`set local role ${value}`);
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: value })]);
}
async function rejects(run: () => Promise<unknown>, code: string) {
  await db.exec('savepoint expected_failure');
  try {
    await assert.rejects(run, (error: unknown) => { assert.equal((error as { code: string }).code, code); return true; });
  } finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload);
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const old = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => old.get(row.id) !== JSON.stringify(row)); deleted[key] = [];
  }
  const events = new Set(before.activity.map(row => row.id));
  const members = after.members.filter(row => {
    const previous = before.members.find(member => member.userId === row.userId);
    return previous && (previous.role !== row.role || previous.active !== row.active);
  }).map(({ userId, role: memberRole, active }) => ({ userId, role: memberRole, active }));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members,
      audit: after.activity.filter(row => !events.has(row.id)), clearDemoAudit: false } };
}
async function act(action: string, payload: unknown) {
  const request = plan(await read(), action, payload);
  return query<{ data: WorkspaceData }>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',
    [request.actor, request.revision, request.requestId, action, hash, JSON.stringify(request.changes), request.message]);
}

describe('compact workspace refresh on the complete production schema', { concurrency: false }, () => {
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
    for (const [name, id] of Object.entries(ids).filter(([name]) => name !== 'unknown')) {
      await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    }
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result', [ids.owner]);
    for (const [name, memberRole] of Object.entries({ manager: 'MANAGER', operations: 'OPERATIONS', sales: 'SALES', accountant: 'ACCOUNTANT', dealer: 'DEALER' })) {
      await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [ids.owner, ids[name as keyof typeof ids], name, `${name}@example.invalid`, memberRole]);
    }
    orderId = (await act('lead_save', { title: 'Working project', status: 'WON', expectedKw: 10.5 })).data.workorders[0].id;
    await act('workorder_save', { id: orderId, status: 'ACTIVE' });
    baseline = await read();
    originalReadDefinition = await query("select pg_get_functiondef('public.crm_workspace_read(uuid,boolean)'::regprocedure) result");
    await db.exec((await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
  });
  beforeEach(async () => { await db.exec('begin'); await role('service_role'); });
  afterEach(async () => { await db.exec('rollback'); });
  after(async () => { await db.close(); });

  test('upgrade changes no existing records or full read contract; matching revision omits collections', async () => {
    assert.deepEqual(await read(), baseline);
    assert.equal(await query("select pg_get_functiondef('public.crm_workspace_read(uuid,boolean)'::regprocedure) result"), originalReadDefinition);
    const compact = await refresh(baseline.revision);
    assert.deepEqual(compact, { unchanged: true, revision: baseline.revision, user: baseline.user });
    assert.ok(JSON.stringify(compact).length < JSON.stringify(baseline).length / 10);
    for (const actor of [ids.manager, ids.sales, ids.operations, ids.accountant]) {
      const full = await read(actor); assert.deepEqual(await refresh(full.revision, actor), { unchanged: true, revision: full.revision, user: full.user });
    }
  });

  test('old and future revisions return the existing full snapshot with its role-scoped audit', async () => {
    for (const revision of [0, baseline.revision - 1, baseline.revision + 1]) assert.deepEqual(await refresh(revision), await read());
    const sales = await refresh(0, ids.sales); assert.deepEqual(sales, await read(ids.sales));
    assert.equal('activity' in sales && sales.activity.length, 0);
    await rejects(() => refresh(null), 'PT400'); await rejects(() => refresh(-1), 'PT400');
  });

  test('trusted service, existing membership and current account eligibility apply even to matching revisions', async () => {
    for (const clientRole of ['anon', 'authenticated'] as const) {
      await role(clientRole); await rejects(() => refresh(baseline.revision), '42501');
    }
    await role('service_role');
    for (const actor of [ids.dealer, ids.invite, ids.unknown]) await rejects(() => refresh(baseline.revision, actor), 'PT403');
    for (const patch of ["active=false", "role='DEALER'"]) {
      await role('postgres'); await db.query(`update crm.members set ${patch} where user_id=$1`, [ids.manager]);
      await role('service_role'); await rejects(() => refresh(baseline.revision, ids.manager), 'PT403');
      await role('postgres'); await db.query("update crm.members set active=true,role='MANAGER' where user_id=$1", [ids.manager]);
    }
    for (const patch of ["email_confirmed_at=null", "banned_until=now()+interval '1 day'", 'is_anonymous=true']) {
      await role('postgres'); await db.query(`update auth.users set ${patch} where id=$1`, [ids.manager]);
      await role('service_role'); await rejects(() => refresh(baseline.revision, ids.manager), 'PT403');
      await role('postgres'); await db.query('update auth.users set email_confirmed_at=now(),banned_until=null,is_anonymous=false where id=$1', [ids.manager]);
    }
    await role('service_role');
    await db.exec(`select set_config('request.jwt.claims','{"role":"authenticated"}',true)`);
    await rejects(() => refresh(baseline.revision), 'PT403');
  });

  test('current member metadata is never cached, and a normal role change forces the full downgraded snapshot', async () => {
    await role('postgres'); await db.query("update crm.members set role='SALES',name='Updated member' where user_id=$1", [ids.manager]);
    await role('service_role');
    const compact = await refresh(baseline.revision, ids.manager);
    assert.equal(compact.user.role, 'SALES'); assert.equal(compact.user.name, 'Updated member');
    await act('member_role', { userId: ids.manager, role: 'ACCOUNTANT' });
    const full = await refresh(baseline.revision, ids.manager);
    assert.deepEqual(full, await read(ids.manager)); assert.equal(full.user.role, 'ACCOUNTANT');
    assert.ok('activity' in full); assert.deepEqual(full.activity, []);
  });

  test('lead, automatic work, paper, member and dealer writes invalidate the compact response', async () => {
    const writes = [
      () => act('lead_save', { title: 'New won project', status: 'WON', expectedKw: 2.5 }),
      () => act('workorder_paper_filing', { id: orderId, document: 'photo', documentStatus: 'RECEIVED' }),
      () => query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [ids.owner, ids.invite, 'Invited', 'invite@example.invalid', 'SALES']),
      () => query('select public.crm_authorize_member_link($1::uuid,$2::uuid) result', [ids.owner, ids.invite]),
      () => query('select public.crm_dealer_lead_create($1::uuid,$2,$3::jsonb) result', [ids.dealer, crypto.randomUUID(), JSON.stringify({ title: 'Dealer submission', expectedKw: 3.25 })]),
    ];
    for (const write of writes) {
      const previous = await read(); await write(); const result = await refresh(previous.revision);
      assert.ok(result.revision > previous.revision); assert.deepEqual(result, await read());
      assert.deepEqual(await refresh(result.revision), { unchanged: true, revision: result.revision, user: result.user });
    }
  });

  test('operational updates remain independent and visible while unchanged core data stays compact', async () => {
    const previous = await query<OperationsData>('select public.crm_operations_v2_read($1::uuid,$2) result', [ids.owner, month]);
    await query('select public.crm_operations_v2_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',
      [ids.operations, previous.revision, crypto.randomUUID(), 'job_filing_complete', hash, JSON.stringify({ workOrderId: orderId }), month]);
    const current = await query<OperationsData>('select public.crm_job_materials_read($1::uuid,$2,$3) result', [ids.owner, month, orderId]);
    assert.ok(current.revision > previous.revision); assert.equal(current.extension.jobMaterialEntries?.length, 1);
    assert.deepEqual(await refresh(baseline.revision), { unchanged: true, revision: baseline.revision, user: baseline.user });
  });
});
