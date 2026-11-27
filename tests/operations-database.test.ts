import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import type { OperationsData, StockItem, StockMovement, AttendanceRecord, Expense } from '../lib/operations-types.ts';
import type { WorkspaceData } from '../lib/types.ts';

/** Real migrations and PostgreSQL RPCs. PGlite is one connection: stale-revision
 * and rollback tests exercise transactional behavior, not hosted concurrency. */
const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  manager: '10000000-0000-4000-8000-000000000002',
  sales: '10000000-0000-4000-8000-000000000003',
  operations: '10000000-0000-4000-8000-000000000004',
  viewer: '10000000-0000-4000-8000-000000000005',
  outsider: '10000000-0000-4000-8000-000000000006',
  pending: '10000000-0000-4000-8000-000000000007',
  anonymous: '10000000-0000-4000-8000-000000000008',
  banned: '10000000-0000-4000-8000-000000000009',
};
const migrationPath = '../supabase/migrations/20261123173951_operations.sql';
type OperationsExport = {
  revision: number;
  stockItems: StockItem[]; stockMovements: StockMovement[];
  attendance: AttendanceRecord[]; expenses: Expense[];
  audit?: { action: string; entityId: string; reason: string; before: Record<string, unknown> | null; after: Record<string, unknown> }[];
};
type MutationResult = { data: OperationsData; message: string };
type TeamActivityEntry = {
  id: string; actorId: string | null; actorName: string; action: string; module: string;
  entityType: string; entityId: string; description: string; createdAt: string;
  source: 'CRM' | 'OPERATIONS'; before: Record<string, unknown> | null;
  after: Record<string, unknown> | null; reason: string;
};
type TeamActivity = {
  month: string; employeeId: string | null; module: string; page: number;
  pageSize: number; total: number; serverTime: string; entries: TeamActivityEntry[];
};
type MutationRequest = {
  actor: string; revision: number; requestId: string; action: string;
  hash: string; payload: unknown; month: string;
};
let db: PGlite;
let today: string;
let month: string;

async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  const result = await db.query<{ result: T }>(sql, values);
  return result.rows[0]?.result as T;
}
async function setRole(role: 'anon' | 'authenticated' | 'service_role' | 'postgres') {
  await db.exec(`SET LOCAL ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
}
async function rejectsSql(run: () => Promise<unknown>, code: string | string[]) {
  const allowed = Array.isArray(code) ? code : [code];
  await db.exec('SAVEPOINT expected_failure');
  try {
    await assert.rejects(run, (error: unknown) => {
      const e = error as { code?: string; message?: string };
      assert.ok(allowed.includes(e.code ?? ''), `Expected ${allowed.join('/')} but got ${e.code}: ${e.message}`);
      return true;
    });
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}
async function read(actor = ids.owner, selectedMonth = month): Promise<OperationsData> {
  return query('SELECT public.crm_operations_read($1::uuid,$2::text) AS result', [actor, selectedMonth]);
}
async function exportData(actor = ids.owner): Promise<OperationsExport> {
  return query('SELECT public.crm_operations_export($1::uuid) AS result', [actor]);
}
async function legacyRead(actor = ids.owner, fullAudit = false): Promise<WorkspaceData> {
  return query('SELECT public.crm_workspace_read($1::uuid,$2::boolean) AS result', [actor, fullAudit]);
}
async function teamActivity(actor = ids.owner, filters: { month?: string; employeeId?: string | null; module?: string; page?: number } = {}): Promise<TeamActivity> {
  return query('SELECT public.crm_team_activity_read($1::uuid,$2::text,$3::uuid,$4::text,$5::integer) AS result',
    [actor, filters.month ?? month, filters.employeeId ?? null, filters.module ?? 'all', filters.page ?? 1]);
}
async function coreCreateCustomer(actor: string, name: string) {
  const before = await legacyRead(actor);
  const after = structuredClone(before);
  const message = applyAction(after, 'customer_save', { name });
  const oldCustomers = new Set(before.customers.map(row => row.id));
  const oldEvents = new Set(before.activity.map(row => row.id));
  const changes = {
    company: after.company, sequences: after.sequences,
    upserts: { customers: after.customers.filter(row => !oldCustomers.has(row.id)), leads: [], followups: [], quotations: [], workorders: [] },
    deleted: { customers: [], leads: [], followups: [], quotations: [], workorders: [] },
    members: [], audit: after.activity.filter(row => !oldEvents.has(row.id)), clearDemoAudit: false,
  };
  return query<{ data: WorkspaceData; message: string }>('SELECT public.crm_workspace_commit($1::uuid,$2::bigint,$3::text,$4::text,$5::text,$6::jsonb,$7::text) AS result',
    [actor, before.revision, crypto.randomUUID(), 'customer_save', 'a'.repeat(64), JSON.stringify(changes), message]);
}
function request(action: string, payload: unknown, revision: number, actor = ids.owner, requestId = crypto.randomUUID()): MutationRequest {
  return { actor, revision, requestId, action, payload, month,
    hash: createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex') };
}
async function commit(r: MutationRequest): Promise<MutationResult> {
  return query('SELECT public.crm_operations_mutate($1::uuid,$2::bigint,$3::text,$4::text,$5::text,$6::jsonb,$7::text) AS result',
    [r.actor, r.revision, r.requestId, r.action, r.hash, JSON.stringify(r.payload), r.month]);
}
async function mutate(action: string, payload: unknown, actor = ids.owner) {
  return commit(request(action, payload, (await read(actor)).revision, actor));
}
async function item(actor = ids.owner, overrides: Record<string, unknown> = {}) {
  const sku = `ITEM-${crypto.randomUUID()}`;
  const result = await mutate('stock_item_save', { sku, name: 'Portland cement', unit: 'bag', ...overrides }, actor);
  return result.data.stockItems.find(row => row.sku === (overrides.sku ?? sku))!;
}
async function expense(actor = ids.sales, overrides: Record<string, unknown> = {}) {
  const title = `Site expense ${crypto.randomUUID()}`;
  const result = await mutate('expense_save', { expenseDate: today, title, category: 'Materials', amount: '1250.25', ...overrides }, actor);
  return result.data.expenses.find(row => row.title === (overrides.title ?? title))!;
}
function dateOffset(days: number) {
  const value = new Date(`${today}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
async function state() {
  await setRole('postgres');
  const value = await query<Record<string, number>>(`SELECT jsonb_build_object(
    'revision',(select revision from crm.operations_state),
    'legacyRevision',(select revision from crm.workspace),
    'items',(select count(*) from crm.stock_items),'moves',(select count(*) from crm.stock_movements),
    'attendance',(select count(*) from crm.attendance),'expenses',(select count(*) from crm.expenses),
    'audit',(select count(*) from crm.operations_audit),'receipts',(select count(*) from crm.operations_receipts),
    'legacyAudit',(select count(*) from crm.audit_events)) AS result`);
  await setRole('service_role');
  return value;
}

describe('Operations database permissions, privacy and atomic state', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz,
        banned_until timestamptz, raw_user_meta_data jsonb NOT NULL DEFAULT '{}',
        is_anonymous boolean NOT NULL DEFAULT false
      );
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role';
      $$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION auth.role() TO anon,authenticated,service_role;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/202611230001_crm.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL(migrationPath, import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261124072200_accountant_and_lead_status.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261127062903_lead_expected_kw.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261127065452_manual_lead_won.sql', import.meta.url), 'utf8'));
  });
  beforeEach(async () => {
    await db.exec('BEGIN');
    for (const [name, id] of Object.entries(ids)) {
      await db.query('INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),$3)',
        [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    }
    today = await query<string>("SELECT ((clock_timestamp() at time zone 'Asia/Kolkata')::date)::text AS result");
    month = today.slice(0, 7);
    await setRole('service_role');
    await query('SELECT public.crm_bootstrap_owner($1::uuid) AS result', [ids.owner]);
    for (const [name, role] of Object.entries({ manager: 'MANAGER', sales: 'SALES', operations: 'OPERATIONS', viewer: 'VIEWER', pending: 'SALES', anonymous: 'SALES', banned: 'SALES' })) {
      await query('SELECT public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) AS result',
        [ids.owner, ids[name as keyof typeof ids], name, `${name}@example.invalid`, role]);
    }
    await setRole('postgres');
    await db.query('UPDATE auth.users SET email_confirmed_at = NULL WHERE id = $1', [ids.pending]);
    await db.query('UPDATE auth.users SET is_anonymous = true WHERE id = $1', [ids.anonymous]);
    await db.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [ids.banned]);
    await setRole('service_role');
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  after(async () => { await db.close(); });

  test('new tables and helpers stay private; only trusted-server RPCs are callable', async () => {
    const tables = await db.query<{ name: string; rls: boolean; anon: boolean; authenticated: boolean; service: boolean }>(`
      SELECT c.relname AS name,c.relrowsecurity AS rls,
        has_table_privilege('anon',c.oid,'select,insert,update,delete') AS anon,
        has_table_privilege('authenticated',c.oid,'select,insert,update,delete') AS authenticated,
        has_table_privilege('service_role',c.oid,'select,insert,update,delete') AS service
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='crm' AND c.relname IN ('operations_state','stock_items','stock_movements','attendance','expenses','operations_audit','operations_receipts')
    `);
    assert.equal(tables.rows.length, 7);
    for (const row of tables.rows) assert.deepEqual([row.rls, row.anon, row.authenticated, row.service], [true, false, false, false], row.name);
    const functions = await db.query<{ name: string; definer: boolean; config: string[]; anon: boolean; authenticated: boolean; service: boolean }>(`
      SELECT p.proname AS name,p.prosecdef AS definer,p.proconfig AS config,
        has_function_privilege('anon',p.oid,'execute') AS anon,
        has_function_privilege('authenticated',p.oid,'execute') AS authenticated,
        has_function_privilege('service_role',p.oid,'execute') AS service
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND (p.proname LIKE 'crm_operations_%' OR p.proname='crm_team_activity_read')
    `);
    assert.equal(functions.rows.length, 4);
    for (const fn of functions.rows) {
      assert.deepEqual([fn.definer, fn.anon, fn.authenticated, fn.service], [true, false, false, true], fn.name);
      assert.ok(fn.config.includes('search_path=""'), fn.name);
    }
    for (const role of ['anon', 'authenticated'] as const) {
      await setRole(role);
      await db.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
      await rejectsSql(() => read(), '42501');
      await rejectsSql(() => exportData(), '42501');
      await rejectsSql(() => teamActivity(), '42501');
      await rejectsSql(() => commit(request('attendance_check_in', {}, 0)), '42501');
      await rejectsSql(() => db.query('SELECT * FROM crm.expenses'), '42501');
    }
    await setRole('service_role');
    await rejectsSql(() => db.query('SELECT * FROM crm.operations_audit'), '42501');
    await rejectsSql(() => db.query('SELECT crm.operations_expense_totals()'), '42501');
    await db.query("SELECT set_config('request.jwt.claims','{\"role\":\"authenticated\"}',true)");
    await rejectsSql(() => read(), 'PT403');
  });

  test('outsiders, pending, anonymous and banned accounts cannot read, mutate or export', async () => {
    for (const actor of [ids.outsider, ids.pending, ids.anonymous, ids.banned]) {
      await rejectsSql(() => read(actor), 'PT403');
      await rejectsSql(() => exportData(actor), 'PT403');
      await rejectsSql(() => commit(request('attendance_check_in', {}, 0, actor)), 'PT403');
    }
    const empty = await read();
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.stockItems, []);
    assert.deepEqual(empty.counts, { stockMovements: 0, attendance: 0, expenses: 0 });
    assert.equal(empty.expenseSummary?.allTime.submittedPaise, '0');
    assert.equal(empty.today, today);
  });

  test('all working roles can create stock and IN/OUT; only Owner edits, archives or adjusts', async () => {
    for (const actor of [ids.owner, ids.manager, ids.sales, ids.operations]) {
      const created = await item(actor, { openingQuantity: '2.125', minQuantity: '0.500' });
      assert.equal(created.quantityMilli, 2125);
      assert.equal(created.minQuantityMilli, 500);
      const incoming = await mutate('stock_move', { itemId: created.id, type: 'IN', quantity: '1.001' }, actor);
      assert.equal(incoming.data.stockItems.find(row => row.id === created.id)?.quantityMilli, 3126);
      const outgoing = await mutate('stock_move', { itemId: created.id, type: 'OUT', quantity: '0.126' }, actor);
      assert.equal(outgoing.data.stockItems.find(row => row.id === created.id)?.quantityMilli, 3000);
      if (actor !== ids.owner) {
        await rejectsSql(() => mutate('stock_item_save', { id: created.id, sku: created.sku, name: 'Renamed', unit: created.unit }, actor), 'PT403');
        await rejectsSql(() => mutate('stock_item_active', { id: created.id, active: false }, actor), 'PT403');
        await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'ADJUST', quantity: '0', note: 'Count correction' }, actor), 'PT403');
        await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: ' ADJUST ', quantity: '0', note: 'Count correction' }, actor), 'PT403');
      }
    }
    const ownerRead = await read();
    const viewerRead = await read(ids.viewer);
    assert.deepEqual(viewerRead.stockItems, ownerRead.stockItems);
    assert.deepEqual(viewerRead.stockMovements, ownerRead.stockMovements);
    assert.equal(viewerRead.permissions.canWrite, false);
    await rejectsSql(() => item(ids.viewer), 'PT403');
    await rejectsSql(() => mutate('attendance_check_in', {}, ids.viewer), 'PT403');
    await rejectsSql(() => expense(ids.viewer), 'PT403');
    assert.equal(viewerRead.expenseSummary, null);
  });

  test('stock validation, insufficient quantities and bounds leave no partial state', async () => {
    const created = await item(ids.sales, { openingQuantity: '10.001' });
    const before = await state();
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'OUT', quantity: '10.002' }, ids.sales), 'PT409');
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'IN', quantity: '0.0001' }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'IN', quantity: 1 }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'OUT', quantity: '-1' }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'ADJUST', quantity: '0', note: '  ' }), 'PT400');
    await rejectsSql(() => item(ids.sales, { sku: created.sku.toLowerCase() }), 'PT409');
    await rejectsSql(() => item(ids.sales, { openingQuantity: '9000000000.001' }), 'PT400');
    assert.deepEqual(await state(), before);
    const maximum = await item(ids.sales, { openingQuantity: '9000000000' });
    const boundedState = await state();
    await rejectsSql(() => mutate('stock_move', { itemId: maximum.id, type: 'IN', quantity: '0.001' }), 'PT400');
    assert.deepEqual(await state(), boundedState);
    const adjusted = await mutate('stock_move', { itemId: created.id, type: 'ADJUST', quantity: '1.125', note: 'Physical count' });
    const ledger = adjusted.data.stockMovements.find(row => row.type === 'ADJUST')!;
    assert.deepEqual([ledger.quantityMilli, ledger.deltaMilli, ledger.balanceAfterMilli], [1125, -8876, 1125]);
  });

  test('master edits preserve unit history and archiving requires a zero stock balance', async () => {
    const created = await item(ids.sales, { openingQuantity: '1' });
    const payload = { id: created.id, sku: created.sku, name: 'Cement revised', unit: created.unit };
    await rejectsSql(() => mutate('stock_item_save', { ...payload, unit: 'tonne' }), 'PT409');
    await rejectsSql(() => mutate('stock_item_save', { ...payload, openingQuantity: '1' }), 'PT400');
    await rejectsSql(() => mutate('stock_item_active', { id: created.id, active: false }), 'PT409');
    const saved = await mutate('stock_item_save', { ...payload, minQuantity: '2' });
    assert.equal(saved.data.stockItems.find(row => row.id === created.id)?.name, 'Cement revised');
    await mutate('stock_move', { itemId: created.id, type: 'OUT', quantity: '1' }, ids.operations);
    await mutate('stock_item_active', { id: created.id, active: false });
    await rejectsSql(() => mutate('stock_move', { itemId: created.id, type: 'IN', quantity: '1' }, ids.sales), 'PT409');
    assert.equal((await read(ids.viewer)).stockItems.find(row => row.id === created.id)?.active, false);
    await mutate('stock_item_active', { id: created.id, active: true });
    await mutate('stock_move', { itemId: created.id, type: 'IN', quantity: '1' }, ids.manager);
    const untouched = await item(ids.sales);
    await mutate('stock_item_save', { id: untouched.id, sku: untouched.sku, name: untouched.name, unit: 'kg' });
    assert.equal((await read()).stockItems.find(row => row.id === untouched.id)?.unit, 'kg');
  });

  test('receipts are actor/action/payload bound, replay returns current scope, and revisions stay separate', async () => {
    const baseline = await state();
    const req = request('stock_item_save', { sku: 'REPLAY-01', name: 'Steel', unit: 'kg', openingQuantity: '1.250' }, 0, ids.sales);
    const first = await commit(req);
    assert.equal(first.data.revision, 1);
    await expense(ids.manager);
    const replay = await commit(req);
    assert.equal(replay.data.revision, 2);
    assert.equal(replay.data.stockItems.length, 1);
    assert.deepEqual(replay.data.expenses, []);
    assert.equal(replay.data.expenseSummary, null);
    assert.deepEqual(replay.data.counts, { stockMovements: 1, attendance: 0, expenses: 0 });
    assert.equal((await state()).legacyRevision, baseline.legacyRevision);
    await rejectsSql(() => commit({ ...req, actor: ids.manager }), 'PT409');
    await rejectsSql(() => commit({ ...req, action: 'expense_save' }), 'PT409');
    await rejectsSql(() => commit({ ...req, hash: 'f'.repeat(64) }), 'PT409');
    await rejectsSql(() => commit({ ...req, payload: { ...(req.payload as object), name: 'Changed' } }), 'PT409');
    const beforeStale = await state();
    await rejectsSql(() => commit(request('stock_item_save', { sku: 'STALE', name: 'Sand', unit: 'kg' }, 0, ids.sales)), 'PT409');
    assert.deepEqual(await state(), beforeStale);
    assert.equal(beforeStale.audit, 2);
    assert.equal(beforeStale.receipts, 2);
    assert.equal(beforeStale.legacyAudit, baseline.legacyAudit);
  });

  test('membership and current permissions are rechecked before reads, exports and receipt replay', async () => {
    const req = request('attendance_check_in', {}, 0, ids.sales);
    await commit(req);
    await setRole('postgres');
    await db.query("UPDATE crm.members SET role='VIEWER' WHERE user_id=$1", [ids.sales]);
    await setRole('service_role');
    await rejectsSql(() => commit(req), 'PT403');
    assert.equal((await read(ids.sales)).permissions.canWrite, false);
    await setRole('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.sales]);
    await setRole('service_role');
    await rejectsSql(() => read(ids.sales), 'PT403');
    await rejectsSql(() => exportData(ids.sales), 'PT403');
    await rejectsSql(() => commit(req), 'PT403');
    await rejectsSql(() => commit(request('attendance_check_out', {}, 1, ids.sales)), 'PT403');
    const created = await item(ids.owner);
    const adminReq = request('stock_move', { itemId: created.id, type: ' ADJUST ', quantity: '0', note: 'Owner check' }, (await read()).revision);
    await commit(adminReq);
    await setRole('postgres');
    await db.query("UPDATE crm.members SET role='MANAGER' WHERE user_id=$1", [ids.owner]);
    await setRole('service_role');
    await rejectsSql(() => commit(adminReq), 'PT403');
  });

  test('attendance uses SQL time and self identity and prevents duplicate or parallel shifts', async () => {
    const baseline = await state();
    await rejectsSql(() => mutate('attendance_check_in', { userId: ids.owner }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('attendance_check_in', { checkIn: '2000-01-01T00:00:00Z' }, ids.sales), 'PT400');
    assert.deepEqual(await state(), baseline);
    const result = await mutate('attendance_check_in', { site: 'Sector 21', notes: 'Foundation work' }, ids.sales);
    const row = result.data.myTodayAttendance!;
    assert.equal(row.userId, ids.sales);
    assert.equal(row.workDate, today);
    assert.equal(row.source, 'SELF');
    assert.equal(row.status, 'PRESENT');
    assert.ok(Date.parse(result.data.serverTime) >= Date.parse(row.checkIn!));
    assert.ok(Date.parse(result.data.serverTime) - Date.parse(row.checkIn!) < 10_000);
    await rejectsSql(() => mutate('attendance_check_in', {}, ids.sales), 'PT409');
    await rejectsSql(() => mutate('attendance_check_out', { userId: ids.sales }, ids.manager), 'PT400');
    await rejectsSql(() => mutate('attendance_check_out', {}, ids.manager), 'PT409');
    const closed = await mutate('attendance_check_out', {}, ids.sales);
    assert.equal(closed.data.myOpenAttendance, null);
    assert.ok(Date.parse(closed.data.myTodayAttendance!.checkOut!) > Date.parse(row.checkIn!));
    await rejectsSql(() => mutate('attendance_check_in', {}, ids.sales), 'PT409');
    await rejectsSql(() => mutate('attendance_check_out', {}, ids.sales), 'PT409');
  });

  test('a previous-day open shift appears independently of the selected month and supports checkout', async () => {
    const priorDate = dateOffset(-1);
    await mutate('attendance_correct', { userId: ids.sales, workDate: priorDate, status: 'PRESENT', checkIn: `${priorDate}T09:00:00+05:30`, reason: 'Missed check-in' });
    const oldMonth = '2001-01';
    const data = await read(ids.sales, oldMonth);
    assert.deepEqual(data.attendance, []);
    assert.equal(data.myOpenAttendance?.workDate, priorDate);
    assert.equal(data.myTodayAttendance, null);
    await rejectsSql(() => mutate('attendance_check_in', {}, ids.sales), 'PT409');
    const result = await mutate('attendance_check_out', {}, ids.sales);
    assert.equal(result.data.myOpenAttendance, null);
    const exported = await exportData(ids.sales);
    assert.ok(Date.parse(exported.attendance[0].checkOut!) > Date.parse(exported.attendance[0].checkIn!));
    await mutate('attendance_check_in', {}, ids.sales);
    assert.equal((await read(ids.sales, oldMonth)).myTodayAttendance?.workDate, today);
  });

  test('Owner corrections enforce real dates, IST day, ordered times, no future dates and one open shift', async () => {
    const past = dateOffset(-2);
    const next = dateOffset(-1);
    const payload = { userId: ids.sales, workDate: past, status: 'PRESENT', checkIn: `${past}T23:00:00+05:30`, checkOut: `${next}T06:00:00+05:30`, reason: 'Overnight concrete pour' };
    await rejectsSql(() => mutate('attendance_correct', payload, ids.manager), 'PT403');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, reason: ' ' }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, workDate: '2026-02-30' }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, workDate: next }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, checkOut: payload.checkIn }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, status: 'ABSENT' }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { userId: ids.sales, workDate: dateOffset(1), status: 'LEAVE', reason: 'Tomorrow' }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, checkOut: `${dateOffset(1)}T06:00:00+05:30` }), 'PT400');
    await rejectsSql(() => mutate('attendance_correct', { ...payload, userId: ids.outsider }), 'PT404');
    await mutate('attendance_correct', payload);
    const row = (await exportData(ids.sales)).attendance[0];
    assert.equal(row.workDate, past);
    assert.equal(row.source, 'ADMIN');
    assert.equal(Date.parse(row.checkOut!) - Date.parse(row.checkIn!), 7 * 60 * 60 * 1000);
    await mutate('attendance_correct', { userId: ids.sales, workDate: past, status: 'HALF_DAY', reason: 'Updated shift log' });
    const corrected = (await exportData(ids.sales)).attendance[0];
    assert.equal(corrected.id, row.id);
    assert.equal(corrected.checkIn, null);
    assert.equal(corrected.checkOut, null);
    await mutate('attendance_correct', { userId: ids.sales, workDate: past, status: 'PRESENT', checkIn: `${past}T09:00:00+05:30`, reason: 'Open old shift' });
    await rejectsSql(() => mutate('attendance_correct', { userId: ids.sales, workDate: next, status: 'PRESENT', checkIn: `${next}T09:00:00+05:30`, reason: 'Another open shift' }), 'PT409');
    await setRole('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.sales]);
    await setRole('service_role');
    await mutate('attendance_correct', { userId: ids.sales, workDate: past, status: 'LEAVE', reason: 'Historical correction for former employee' });
    assert.equal((await exportData()).attendance[0].status, 'LEAVE');
  });

  test('employees and Managers receive only their attendance and expenses, exact scoped counts, and no audit or company totals', async () => {
    const baseline = await state();
    await expense(ids.sales, { title: 'Private sales bill', notes: 'Private supplier details', amount: '123.45' });
    await expense(ids.manager, { title: 'Manager travel', amount: '50' });
    await expense(ids.owner, { title: 'Owner expense', amount: '200' });
    await mutate('attendance_check_in', { notes: 'Private sales shift' }, ids.sales);
    await mutate('attendance_check_in', {}, ids.manager);
    await item(ids.operations, { openingQuantity: '2' });
    for (const actor of [ids.sales, ids.manager, ids.operations, ids.viewer]) {
      const data = await read(actor);
      const exported = await exportData(actor);
      const expected = actor === ids.sales || actor === ids.manager ? 1 : 0;
      assert.equal(data.expenses.length, expected);
      assert.equal(data.attendance.length, expected);
      assert.equal(data.counts.expenses, expected);
      assert.equal(data.counts.attendance, expected);
      assert.equal(data.counts.stockMovements, 1);
      assert.equal(data.expenseSummary, null);
      assert.equal(data.permissions.admin, false);
      assert.ok(data.expenses.every(row => row.userId === actor));
      assert.ok(data.attendance.every(row => row.userId === actor));
      assert.ok(exported.expenses.every(row => row.userId === actor));
      assert.ok(exported.attendance.every(row => row.userId === actor));
      assert.equal('audit' in exported, false);
      assert.equal('expenseSummary' in exported, false);
      assert.equal(exported.stockItems.length, 1);
      if (actor !== ids.sales) assert.equal(JSON.stringify({ data, exported }).includes('Private sales'), false);
    }
    const admin = await read();
    assert.equal(admin.expenses.length, 3);
    assert.equal(admin.attendance.length, 2);
    assert.equal(admin.expenseSummary?.month.submittedPaise, '37345');
    assert.equal((await exportData()).audit?.length, 6);
    assert.equal((await state()).legacyAudit, baseline.legacyAudit);
    const legacy = await query<Record<string, unknown>>('SELECT public.crm_workspace_read($1::uuid,true) AS result', [ids.manager]);
    assert.equal(JSON.stringify(legacy).includes('Private sales'), false);
  });

  test('expense ownership cannot be forged and Owner cannot alter another submitter details', async () => {
    const baseline = await state();
    const base = { expenseDate: today, title: 'Site materials', category: 'Materials', amount: '50.25' };
    await rejectsSql(() => mutate('expense_save', { ...base, userId: ids.owner }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('expense_save', { ...base, reviewedBy: ids.owner }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('expense_save', { ...base, amountPaise: 1 }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('expense_save', { ...base, expenseDate: dateOffset(1) }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('expense_save', { ...base, amount: '1.001' }, ids.sales), 'PT400');
    await rejectsSql(() => mutate('expense_save', { ...base, amount: '0' }, ids.sales), 'PT400');
    assert.deepEqual(await state(), baseline);
    const created = await expense(ids.sales);
    for (const actor of [ids.owner, ids.manager, ids.operations]) {
      await rejectsSql(() => mutate('expense_save', { ...base, id: created.id }, actor), 'PT404');
      await rejectsSql(() => mutate('expense_withdraw', { id: created.id }, actor), 'PT404');
    }
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'APPROVED' }, ids.manager), 'PT403');
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'APPROVED' }, ids.sales), 'PT403');
    const edited = await mutate('expense_save', { ...base, id: created.id }, ids.sales);
    assert.equal(edited.data.expenses[0].amountPaise, 5025);
    assert.equal(edited.data.expenses[0].userId, ids.sales);
  });

  test('expense reviews, rejected resubmission, withdrawal and paid immutability preserve audit history', async () => {
    const created = await expense(ids.sales);
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'PAID' }), 'PT409');
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'REJECTED', note: ' ' }), 'PT400');
    await mutate('expense_review', { id: created.id, status: 'REJECTED', note: 'Add bill reference' });
    const rejected = (await read(ids.sales)).expenses[0];
    assert.equal(rejected.reviewedBy, ids.owner);
    assert.equal(rejected.reviewNote, 'Add bill reference');
    assert.ok(rejected.reviewedAt);
    await mutate('expense_save', { id: created.id, expenseDate: today, title: created.title, category: created.category, amount: '100.01', reference: 'BILL-123' }, ids.sales);
    const resubmitted = (await read(ids.sales)).expenses[0];
    assert.equal(resubmitted.status, 'SUBMITTED');
    assert.deepEqual([resubmitted.reviewedBy, resubmitted.reviewedAt, resubmitted.reviewNote], [null, null, '']);
    const audit = (await exportData()).audit!;
    const editAudit = audit.find(row => row.action === 'expense_save' && row.before?.status === 'REJECTED');
    assert.equal(editAudit?.before?.reviewNote, 'Add bill reference');
    assert.equal(editAudit?.after.status, 'SUBMITTED');
    await mutate('expense_review', { id: created.id, status: 'APPROVED', note: 'Bill checked' });
    await rejectsSql(() => mutate('expense_save', { id: created.id, expenseDate: today, title: created.title, category: 'Other', amount: '1' }, ids.sales), 'PT409');
    await rejectsSql(() => mutate('expense_withdraw', { id: created.id }, ids.sales), 'PT409');
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'REJECTED', note: 'Changed mind' }), 'PT409');
    await mutate('expense_review', { id: created.id, status: 'PAID', note: 'Bank transfer' });
    await rejectsSql(() => mutate('expense_review', { id: created.id, status: 'APPROVED' }), 'PT409');
    await rejectsSql(() => mutate('expense_save', { id: created.id, expenseDate: today, title: created.title, category: 'Other', amount: '1' }, ids.sales), 'PT409');
    await rejectsSql(() => mutate('expense_withdraw', { id: created.id }, ids.sales), 'PT409');
    const withdraw = await expense(ids.manager, { amount: '20' });
    await mutate('expense_review', { id: withdraw.id, status: 'REJECTED', note: 'Not a company expense' });
    await mutate('expense_withdraw', { id: withdraw.id }, ids.manager);
    await rejectsSql(() => mutate('expense_save', { id: withdraw.id, expenseDate: today, title: withdraw.title, category: 'Other', amount: '1' }, ids.manager), 'PT409');
    await rejectsSql(() => mutate('expense_review', { id: withdraw.id, status: 'APPROVED' }), 'PT409');
    const totals = (await read()).expenseSummary!.allTime;
    assert.deepEqual(totals, { count: 2, submittedPaise: '0', approvedPaise: '0', paidPaise: '10001', rejectedPaise: '0', withdrawnPaise: '2000' });
  });

  test('month boundaries use IST while current balances and personal current shifts remain current', async () => {
    const created = await item(ids.sales);
    await setRole('postgres');
    await db.query(`INSERT INTO crm.stock_movements(item_id,type,quantity_milli,delta_milli,balance_after_milli,actor_id,actor_name,created_at)
      VALUES($1,'IN',1000,1000,1000,$2,'sales','2020-01-31T18:29:59.999Z'),
            ($1,'IN',2000,2000,3000,$2,'sales','2020-01-31T18:30:00Z'),
            ($1,'IN',3000,3000,6000,$2,'sales','2020-02-29T18:29:59.999Z'),
            ($1,'IN',4000,4000,10000,$2,'sales','2020-02-29T18:30:00Z')`, [created.id, ids.sales]);
    await db.query('UPDATE crm.stock_items SET quantity_milli=10000 WHERE id=$1', [created.id]);
    await db.query(`INSERT INTO crm.expenses(user_id,expense_date,title,category,amount_paise)
      VALUES($1,'2020-01-31','January bill','Other',100),($1,'2020-02-29','February bill','Other',200),($2,'2020-02-01','Private February bill','Other',300)`, [ids.sales, ids.manager]);
    await setRole('service_role');
    await mutate('attendance_check_in', {}, ids.sales);
    const feb = await read(ids.sales, '2020-02');
    assert.equal(feb.stockItems[0].quantityMilli, 10000);
    assert.deepEqual(feb.stockMovements.map(row => row.quantityMilli), [3000, 2000]);
    assert.equal(feb.counts.stockMovements, 2);
    assert.equal(feb.expenses.length, 1);
    assert.equal(feb.expenses[0].title, 'February bill');
    assert.equal(feb.myOpenAttendance?.workDate, today);
    assert.equal(feb.myTodayAttendance?.workDate, today);
    assert.deepEqual(feb.attendance, []);
    assert.equal((await read(ids.sales, '2020-01')).stockMovements.length, 1);
    assert.equal((await read(ids.sales, '2020-03')).stockMovements.length, 1);
    const admin = await read(ids.owner, '2020-02');
    assert.equal(admin.expenseSummary?.month.submittedPaise, '500');
    assert.equal(admin.expenseSummary?.allTime.submittedPaise, '600');
    await rejectsSql(() => read(ids.owner, '2020-13'), 'PT400');
    await rejectsSql(() => read(ids.owner, '0000-01'), 'PT400');
    await rejectsSql(() => read(ids.owner, '2020-2'), 'PT400');
  });

  test('histories cap at 500 with exact scoped counts, full export and exact company sums beyond JS safe integers', async () => {
    const created = await item(ids.sales);
    await setRole('postgres');
    await db.query(`INSERT INTO crm.expenses(user_id,expense_date,title,category,amount_paise)
      SELECT $1::uuid,$2::date,'Large bill '||n,'Other',9000000000000 FROM generate_series(1,1002) AS n`, [ids.sales, today]);
    await db.query(`INSERT INTO crm.expenses(user_id,expense_date,title,category,amount_paise)
      VALUES($1,$2::date,'Manager own entry','Travel',123)`, [ids.manager, today]);
    await db.query(`INSERT INTO crm.stock_movements(item_id,type,quantity_milli,delta_milli,balance_after_milli,actor_id,actor_name)
      SELECT $1::uuid,'IN',1,1,n,$2::uuid,'sales' FROM generate_series(1,501) AS n`, [created.id, ids.sales]);
    await db.query('UPDATE crm.stock_items SET quantity_milli=501 WHERE id=$1', [created.id]);
    await setRole('service_role');
    const employee = await read(ids.sales);
    assert.equal(employee.historyLimit, 500);
    assert.equal(employee.expenses.length, 500);
    assert.equal(employee.counts.expenses, 1002);
    assert.equal(employee.stockMovements.length, 500);
    assert.equal(employee.counts.stockMovements, 501);
    assert.equal(employee.expenseSummary, null);
    const manager = await read(ids.manager);
    assert.equal(manager.expenses.length, 1);
    assert.equal(manager.counts.expenses, 1);
    assert.equal(manager.expenseSummary, null);
    const admin = await read();
    assert.equal(admin.counts.expenses, 1003);
    assert.equal(admin.expenseSummary?.allTime.submittedPaise, '9018000000000123');
    assert.equal(admin.expenseSummary?.month.submittedPaise, '9018000000000123');
    const employeeExport = await exportData(ids.sales);
    assert.equal(employeeExport.expenses.length, 1002);
    assert.equal(employeeExport.stockMovements.length, 501);
    assert.equal('audit' in employeeExport, false);
    assert.equal((await exportData(ids.manager)).expenses.length, 1);
    assert.equal((await exportData()).expenses.length, 1003);
  });

  test('ledger, private audit and receipts cannot be rewritten or deleted', async () => {
    const baseline = await state();
    const created = await item(ids.sales, { openingQuantity: '1' });
    await expense(ids.manager, { notes: 'Sensitive private note' });
    await setRole('postgres');
    await rejectsSql(() => db.query("UPDATE crm.stock_movements SET note='tampered' WHERE item_id=$1", [created.id]), 'PT403');
    await rejectsSql(() => db.query('DELETE FROM crm.stock_movements WHERE item_id=$1', [created.id]), 'PT403');
    await rejectsSql(() => db.query("UPDATE crm.operations_audit SET reason='tampered'"), 'PT403');
    await rejectsSql(() => db.query('DELETE FROM crm.operations_audit'), 'PT403');
    await rejectsSql(() => db.query("UPDATE crm.operations_receipts SET message='tampered'"), 'PT403');
    await rejectsSql(() => db.query('DELETE FROM crm.operations_receipts'), 'PT403');
    await setRole('service_role');
    assert.equal((await state()).legacyAudit, baseline.legacyAudit);
    assert.equal((await exportData()).audit?.length, 2);
  });

  test('all roles see exact lifetime received, used, adjusted and remaining stock including opening balances', async () => {
    const created = await item(ids.sales, { openingQuantity: '10.001' });
    assert.deepEqual([created.receivedMilli, created.usedMilli, created.adjustedMilli, created.quantityMilli], ['10001', '0', '0', 10001]);
    const received = await mutate('stock_move', { itemId: created.id, type: 'IN', quantity: '2.500' }, ids.manager);
    assert.equal(received.data.stockItems[0].receivedMilli, '12501');
    const used = await mutate('stock_move', { itemId: created.id, type: 'OUT', quantity: '3.125' }, ids.operations);
    assert.equal(used.data.stockItems[0].usedMilli, '3125');
    const adjusted = await mutate('stock_move', { itemId: created.id, type: 'ADJUST', quantity: '7', note: 'Count shortage' });
    assert.equal(adjusted.data.stockItems[0].adjustedMilli, '-2376');
    await mutate('stock_move', { itemId: created.id, type: 'ADJUST', quantity: '8.001', note: 'Count correction' });
    for (const actor of [ids.owner, ids.manager, ids.sales, ids.operations, ids.viewer]) {
      const data = await read(actor, '2001-01');
      const row = data.stockItems[0];
      assert.deepEqual(data.stockMovements, []);
      assert.deepEqual([row.receivedMilli, row.usedMilli, row.adjustedMilli, row.quantityMilli], ['12501', '3125', '-1375', 8001]);
      assert.equal(BigInt(row.receivedMilli) - BigInt(row.usedMilli) + BigInt(row.adjustedMilli), BigInt(row.quantityMilli));
      assert.deepEqual((await exportData(actor)).stockItems[0], row);
    }
    const cycled = await item(ids.sales, { sku: 'HIGH-TURNOVER' });
    await setRole('postgres');
    await db.query(`INSERT INTO crm.stock_movements(item_id,type,quantity_milli,delta_milli,balance_after_milli,actor_id,actor_name,created_at)
      SELECT $1::uuid,'IN',9000000000000,9000000000000,9000000000000,$2::uuid,'sales',now() + n * interval '2 microseconds'
      FROM generate_series(1,1002) AS n
      UNION ALL
      SELECT $1::uuid,'OUT',9000000000000,-9000000000000,0,$2::uuid,'sales',now() + n * interval '2 microseconds' + interval '1 microsecond'
      FROM generate_series(1,1002) AS n`, [cycled.id, ids.sales]);
    await setRole('service_role');
    const highTurnover = (await read(ids.manager)).stockItems.find(row => row.id === cycled.id)!;
    assert.deepEqual([highTurnover.receivedMilli, highTurnover.usedMilli, highTurnover.adjustedMilli, highTurnover.quantityMilli], ['9018000000000000', '9018000000000000', '0', 0]);
  });

  test('team activity is Owner-only for every filter and inactive Owners cannot access it', async () => {
    for (const actor of [ids.manager, ids.sales, ids.operations, ids.viewer, ids.outsider, ids.pending, ids.anonymous, ids.banned]) {
      await rejectsSql(() => teamActivity(actor), 'PT403');
      await rejectsSql(() => teamActivity(actor, { month: 'not-a-month', module: 'invalid' }), 'PT403');
    }
    await rejectsSql(() => teamActivity(ids.owner, { month: '2020-13' }), 'PT400');
    await rejectsSql(() => teamActivity(ids.owner, { module: 'private-table' }), 'PT400');
    await rejectsSql(() => teamActivity(ids.owner, { page: 0 }), 'PT400');
    await rejectsSql(() => teamActivity(ids.owner, { page: 10001 }), 'PT400');
    await setRole('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.owner]);
    await setRole('service_role');
    await rejectsSql(() => teamActivity(), 'PT403');
  });

  test('combined activity attributes core and private actions to the same employee with Owner-only detail', async () => {
    await coreCreateCustomer(ids.sales, 'Activity customer');
    const created = await expense(ids.sales, { title: 'Activity bill', notes: 'Private invoice notes' });
    await mutate('attendance_check_in', { site: 'Activity site' }, ids.sales);
    const stock = await item(ids.sales, { name: 'Activity cement' });
    await mutate('stock_move', { itemId: stock.id, type: 'IN', quantity: '2' }, ids.sales);
    await mutate('expense_review', { id: created.id, status: 'REJECTED', note: 'Need receipt reference' });
    const activity = await teamActivity(ids.owner, { employeeId: ids.sales });
    assert.equal(activity.total, 5);
    assert.equal(activity.pageSize, 100);
    assert.equal(activity.employeeId, ids.sales);
    assert.ok(activity.entries.every(row => row.actorId === ids.sales && row.actorName === 'sales'));
    const core = activity.entries.find(row => row.source === 'CRM')!;
    assert.equal(core.module, 'customers');
    assert.equal(core.description, 'Added customer Activity customer');
    assert.deepEqual([core.before, core.after, core.reason], [null, null, '']);
    const submitted = activity.entries.find(row => row.action === 'expense_save')!;
    assert.equal(submitted.module, 'expenses');
    assert.equal(submitted.description, 'Submitted expense: Activity bill');
    assert.equal(submitted.after?.notes, 'Private invoice notes');
    const stockMove = activity.entries.find(row => row.action === 'stock_move')!;
    assert.equal(stockMove.description, 'Received stock: Activity cement');
    assert.equal(stockMove.before?.quantityMilli, 0);
    assert.equal(stockMove.after?.balanceAfterMilli, 2000);
    for (const [module, count] of [['customers', 1], ['expenses', 1], ['attendance', 1], ['stock', 2]] as const) {
      const filtered = await teamActivity(ids.owner, { employeeId: ids.sales, module });
      assert.equal(filtered.total, count);
      assert.ok(filtered.entries.every(row => row.module === module));
    }
    const reviewed = (await teamActivity(ids.owner, { employeeId: ids.owner, module: 'expenses' })).entries[0];
    assert.equal(reviewed.reason, 'Need receipt reference');
    assert.equal(reviewed.before?.status, 'SUBMITTED');
    assert.equal(reviewed.after?.status, 'REJECTED');
    assert.equal(reviewed.after?.userId, ids.sales);
    const legacyOwner = await legacyRead(ids.owner, true);
    assert.equal(JSON.stringify(legacyOwner.activity).includes('Private invoice notes'), false);
    assert.equal((await exportData(ids.sales)).audit, undefined);
    await setRole('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.sales]);
    await setRole('service_role');
    assert.equal((await teamActivity(ids.owner, { employeeId: ids.sales })).total, 5);
  });

  test('activity month, actor, module and page filters count before pagination with deterministic ordering', async () => {
    await setRole('postgres');
    await db.query(`INSERT INTO crm.audit_events(id,actor_id,created_at,payload)
      SELECT 'activity-'||lpad(n::text,4,'0'),$1::uuid,'2020-02-01T00:00:00Z',
        jsonb_build_object('id','activity-'||lpad(n::text,4,'0'),'actor','Historical sales name','action','lead_save',
          'entityType','lead','entityId','lead-'||n,'description','Lead event '||n,'createdAt','2020-02-01T00:00:00Z')
      FROM generate_series(1,251) AS n`, [ids.sales]);
    await db.query(`INSERT INTO crm.operations_audit(actor_id,actor_name,action,entity_type,entity_id,after_data,created_at)
      VALUES($1,'sales','expense_save','expense',gen_random_uuid(),'{"title":"Historical bill","amountPaise":100}', '2020-02-01T00:00:00Z')`, [ids.sales]);
    for (const [id, actor, timestamp, demo] of [
      ['demo-activity', null, '2020-02-01T00:00:00Z', true],
      ['manager-activity', ids.manager, '2020-02-01T00:00:00Z', false],
      ['before-activity', ids.sales, '2020-01-31T18:29:59.999Z', false],
      ['after-activity', ids.sales, '2020-02-29T18:30:00Z', false],
    ] as const) {
      await db.query('INSERT INTO crm.audit_events(id,actor_id,is_demo,created_at,payload) VALUES($1,$2,$3,$4,$5)',
        [id, actor, demo, timestamp, JSON.stringify({ id, actor: demo ? 'Example user' : 'Team member', action: 'lead_save', entityType: 'lead', entityId: 'lead', description: id, createdAt: timestamp })]);
    }
    await setRole('service_role');
    const filters = { month: '2020-02', employeeId: ids.sales };
    const page1 = await teamActivity(ids.owner, { ...filters, page: 1 });
    const page2 = await teamActivity(ids.owner, { ...filters, page: 2 });
    const page3 = await teamActivity(ids.owner, { ...filters, page: 3 });
    assert.equal(page1.total, 252);
    assert.equal(page2.total, 252);
    assert.equal(page3.total, 252);
    assert.deepEqual([page1.entries.length, page2.entries.length, page3.entries.length], [100, 100, 52]);
    const entries = [...page1.entries, ...page2.entries, ...page3.entries];
    assert.equal(new Set(entries.map(row => `${row.source}:${row.id}`)).size, 252);
    assert.deepEqual(page1.entries.map(row => row.id), Array.from({ length: 100 }, (_, i) => `activity-${String(i + 1).padStart(4, '0')}`));
    assert.equal(page1.entries[0].actorName, 'Historical sales name');
    assert.equal(page3.entries.at(-1)?.source, 'OPERATIONS');
    assert.deepEqual((await teamActivity(ids.owner, { ...filters, page: 1 })).entries, page1.entries);
    assert.deepEqual((await teamActivity(ids.owner, { ...filters, page: 4 })).entries, []);
    assert.equal((await teamActivity(ids.owner, { ...filters, module: 'leads' })).total, 251);
    assert.equal((await teamActivity(ids.owner, { ...filters, module: 'expenses' })).total, 1);
    assert.equal((await teamActivity(ids.owner, { ...filters, month: '2020-01' })).total, 1);
    assert.equal((await teamActivity(ids.owner, { ...filters, month: '2020-03' })).total, 1);
    const unfiltered = await teamActivity(ids.owner, { month: '2020-02', page: 3 });
    assert.equal(unfiltered.total, 254);
    assert.equal(unfiltered.entries.find(row => row.id === 'demo-activity')?.actorId, null);
    assert.equal((await teamActivity(ids.owner, { month: '2020-02', employeeId: ids.manager })).total, 1);
    const ownerShort = await legacyRead();
    const ownerFull = await legacyRead(ids.owner, true);
    assert.equal(ownerShort.activity.length, 250);
    assert.equal(ownerFull.activity.length, (await state()).legacyAudit);
  });

  test('legacy employee reads and exports hide all activity while normal employee CRM writes still work', async () => {
    for (const actor of [ids.manager, ids.sales, ids.operations, ids.viewer]) {
      assert.deepEqual((await legacyRead(actor)).activity, []);
      assert.deepEqual((await legacyRead(actor, true)).activity, []);
    }
    const before = await legacyRead(ids.sales);
    const created = await coreCreateCustomer(ids.sales, 'Employee-owned customer');
    assert.equal(created.data.revision, before.revision + 1);
    assert.ok(created.data.customers.some(row => row.name === 'Employee-owned customer'));
    assert.deepEqual(created.data.activity, []);
    const second = await coreCreateCustomer(ids.manager, 'Manager-created customer');
    assert.deepEqual(second.data.activity, []);
    assert.equal(second.data.customers.length, 2);
    const employeeFull = await legacyRead(ids.sales, true);
    assert.deepEqual(employeeFull.activity, []);
    assert.equal(employeeFull.customers.length, 2);
    const owner = await legacyRead(ids.owner, true);
    assert.ok(owner.activity.some(row => row.description === 'Added customer Employee-owned customer'));
    assert.ok(owner.activity.some(row => row.description === 'Added customer Manager-created customer'));
    assert.equal((await teamActivity(ids.owner, { employeeId: ids.sales, module: 'customers' })).total, 1);
    assert.equal((await teamActivity(ids.owner, { employeeId: ids.manager, module: 'customers' })).total, 1);
  });
});
