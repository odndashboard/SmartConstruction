import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import type { WorkspaceData } from '../lib/types.ts';
import type { OperationsData } from '../lib/operations-types.ts';
import type { ExpenseReceipt, OperationsExtension } from '../lib/operations-extensions.ts';

const ids = {
  owner: '20000000-0000-4000-8000-000000000001', manager: '20000000-0000-4000-8000-000000000002',
  sales: '20000000-0000-4000-8000-000000000003', operations: '20000000-0000-4000-8000-000000000004',
  viewer: '20000000-0000-4000-8000-000000000005', removed: '20000000-0000-4000-8000-000000000006',
  outsider: '20000000-0000-4000-8000-000000000007', pending: '20000000-0000-4000-8000-000000000008',
  anonymous: '20000000-0000-4000-8000-000000000009', banned: '20000000-0000-4000-8000-000000000010',
  accountant: '20000000-0000-4000-8000-000000000011',
};
const migrations = ['202611230001_crm.sql', '20261123173951_operations.sql', '20261123182424_operations_extensions.sql', '20261124072200_accountant_and_lead_status.sql', '20261127062903_lead_expected_kw.sql', '20261127065452_manual_lead_won.sql'];
let db: PGlite;
let today: string;
let month: string;
type Result = { data: OperationsData; message: string };
type Reservation = ExpenseReceipt & { state: 'PENDING' | 'READY'; bucket: string; objectPath: string; sha256: string };
const hash = 'a'.repeat(64);

async function initialize(database: PGlite, extensions = true) {
  await database.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,banned_until timestamptz,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}',is_anonymous boolean NOT NULL DEFAULT false);
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'; $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION auth.role() TO anon,authenticated,service_role;
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for (const file of migrations.slice(0, extensions ? migrations.length : 2)) await database.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
}
async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T;
}
async function role(value: 'postgres' | 'service_role' | 'anon' | 'authenticated') {
  await db.exec(`SET LOCAL ROLE ${value}`);
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: value })]);
}
async function rejects(run: () => Promise<unknown>, codes: string | string[]) {
  const expected = Array.isArray(codes) ? codes : [codes];
  await db.exec('SAVEPOINT expected_failure');
  try {
    await assert.rejects(run, (e: unknown) => {
      const error = e as { code?: string; message?: string };
      assert.ok(expected.includes(error.code ?? ''), `Expected ${expected.join('/')} but got ${error.code}: ${error.message}`); return true;
    });
  } finally { await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure'); }
}
async function read(actor = ids.owner, selectedMonth = month): Promise<OperationsData> {
  return query('SELECT public.crm_operations_v2_read($1::uuid,$2) AS result', [actor, selectedMonth]);
}
function request(action: string, payload: unknown, revision: number, actor = ids.owner, requestId = crypto.randomUUID()) {
  return { action, payload, revision, actor, requestId, month, hash: createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex') };
}
async function commit(r: ReturnType<typeof request>, legacy = false): Promise<Result> {
  const fn = legacy ? 'crm_operations_mutate' : 'crm_operations_v2_mutate';
  return query(`SELECT public.${fn}($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result`,
    [r.actor, r.revision, r.requestId, r.action, r.hash, JSON.stringify(r.payload), r.month]);
}
async function mutate(action: string, payload: unknown, actor = ids.owner) { return commit(request(action, payload, (await read(actor)).revision, actor)); }
async function exported(actor = ids.owner): Promise<{ extension: OperationsExtension; audit?: unknown[] }> { return query('SELECT public.crm_operations_v2_export($1::uuid) AS result', [actor]); }
async function site(name = `Site ${crypto.randomUUID()}`) {
  const data = (await mutate('site_save', { name, address: 'Synthetic local test site' })).data;
  return data.extension.sites.find(row => row.name === name)!;
}
async function item(opening = '20') {
  const sku = `MAT-${crypto.randomUUID()}`;
  return (await mutate('stock_item_save', { sku, name: 'Test cement', unit: 'bag', openingQuantity: opening }, ids.sales)).data.stockItems.find(row => row.sku === sku)!;
}
async function expense(actor = ids.sales) {
  const title = `Expense ${crypto.randomUUID()}`;
  return (await mutate('expense_save', { expenseDate: today, title, category: 'Materials', amount: '100' }, actor)).data.expenses.find(row => row.title === title)!;
}
function day(offset: number) { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); }
async function reserve(expenseId: string, actor = ids.sales, requestId = crypto.randomUUID(), values: Partial<{ fileName: string; mime: string; size: number; sha: string }> = {}): Promise<Reservation> {
  return query('SELECT public.crm_expense_receipt_reserve($1::uuid,$2::uuid,$3,$4,$5,$6::bigint,$7) AS result',
    [actor, expenseId, requestId, values.fileName ?? 'bill.png', values.mime ?? 'image/png', values.size ?? 1024, values.sha ?? hash]);
}
async function complete(receipt: Reservation, actor = ids.sales, sha = receipt.sha256): Promise<ExpenseReceipt> {
  return query('SELECT public.crm_expense_receipt_complete($1::uuid,$2::uuid,$3,$4::bigint,$5) AS result', [actor, receipt.id, receipt.mimeType, receipt.sizeBytes, sha]);
}
async function access(id: string, actor = ids.sales): Promise<Reservation> { return query('SELECT public.crm_expense_receipt_access($1::uuid,$2::uuid) AS result', [actor, id]); }
async function remove(id: string, actor = ids.sales): Promise<{ bucket: string; objectPath: string }> { return query('SELECT public.crm_expense_receipt_remove($1::uuid,$2::uuid) AS result', [actor, id]); }
async function assertStock() {
  await role('postgres');
  const mismatches = await query<number>(`SELECT count(*)::int AS result FROM crm.stock_items i WHERE i.quantity_milli<>(SELECT coalesce(sum(b.quantity_milli),0) FROM crm.site_stock_balances b WHERE b.item_id=i.id)`);
  assert.equal(mismatches, 0);
  await db.exec('SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED');
  await role('service_role');
}
async function state() {
  await role('postgres');
  const result = await query(`SELECT jsonb_build_object('revision',(SELECT revision FROM crm.operations_state),'moves',(SELECT count(*) FROM crm.stock_movements),
    'transfers',(SELECT count(*) FROM crm.stock_transfers),'returns',(SELECT count(*) FROM crm.stock_returns),'orders',(SELECT count(*) FROM crm.purchase_orders),
    'lines',(SELECT count(*) FROM crm.purchase_order_lines),'audit',(SELECT count(*) FROM crm.operations_audit),'receipts',(SELECT count(*) FROM crm.operations_receipts)) AS result`);
  await role('service_role'); return result;
}
async function core(action: string, payload: unknown) {
  const before = await query<WorkspaceData>('SELECT public.crm_workspace_read($1::uuid,true) AS result', [ids.owner]);
  const after = structuredClone(before); const message = applyAction(after, action, payload);
  const collections = ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const;
  const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of collections) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row)); deleted[key] = [];
  }
  const oldEvents = new Set(before.activity.map(row => row.id));
  const changes = { company: after.company, sequences: after.sequences, upserts, deleted, members: [], audit: after.activity.filter(row => !oldEvents.has(row.id)), clearDemoAudit: false };
  return query<{ data: WorkspaceData }>('SELECT public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result',
    [ids.owner, before.revision, crypto.randomUUID(), action, hash, JSON.stringify(changes), message]);
}
async function workOrder() {
  const name = `Contract ${crypto.randomUUID()}`;
  const customer = (await core('customer_save', { name, address: 'Test address', stateCode: '06' })).data.customers.find(row => row.name === name)!;
  await core('company_save', { name: 'Smart construction', legalName: 'Test contractor', address: 'Test supplier address', gstin: '06ABCDE1234F1Z5', stateCode: '06', phone: '', email: '', website: '', terms: '' });
  const lead = (await core('lead_save', { customerId: customer.id, title: name, stateCode: '06', siteAddress: 'Test site', value: '10000' })).data.leads.find(row => row.title === name)!;
  const quote = (await core('quote_save', { leadId: lead.id, title: name, validUntil: day(30), placeOfSupply: '06', siteAddress: 'Test site', terms: '',
    items: [{ id: crypto.randomUUID(), description: 'Test service', hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '10000', discount: '0', gstRate: '18' }] })).data.quotations.find(row => row.title === name)!;
  await core('quote_issue', { id: quote.id }); await core('quote_accept', { id: quote.id, acceptanceNote: 'Synthetic written acceptance' });
  return (await core('quote_convert', { id: quote.id })).data.workorders.find(row => row.quoteId === quote.id)!;
}

describe('Operations extensions: real database rules and scoped workflows', { concurrency: false }, () => {
  before(async () => { db = new PGlite(); await initialize(db); });
  beforeEach(async () => {
    await db.exec('BEGIN');
    for (const [name, id] of Object.entries(ids)) await db.query('INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    today = await query<string>("SELECT ((clock_timestamp() at time zone 'Asia/Kolkata')::date)::text AS result"); month = today.slice(0, 7);
    await role('service_role'); await query('SELECT public.crm_bootstrap_owner($1::uuid) AS result', [ids.owner]);
    for (const [name, memberRole] of Object.entries({ manager: 'MANAGER', sales: 'SALES', operations: 'OPERATIONS', accountant: 'ACCOUNTANT', viewer: 'VIEWER', removed: 'SALES', pending: 'SALES', anonymous: 'SALES', banned: 'SALES' })) {
      await query('SELECT public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) AS result', [ids.owner, ids[name as keyof typeof ids], name, `${name}@example.invalid`, memberRole]);
    }
    await role('postgres');
    await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.removed]);
    await db.query('UPDATE auth.users SET email_confirmed_at=null WHERE id=$1', [ids.pending]);
    await db.query('UPDATE auth.users SET is_anonymous=true WHERE id=$1', [ids.anonymous]);
    await db.query("UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=$1", [ids.banned]);
    await role('service_role');
  });
  afterEach(async () => { await db.exec('ROLLBACK'); });
  after(async () => { await db.close(); });

  test('new tables and RPCs retain the private service boundary; bucket is private and constrained', async () => {
    const rows = await db.query<{ name: string; rls: boolean; service: boolean; anon: boolean; authenticated: boolean }>(`SELECT c.relname name,c.relrowsecurity rls,
      has_table_privilege('service_role',c.oid,'select,insert,update,delete') service,has_table_privilege('anon',c.oid,'select,insert,update,delete') anon,
      has_table_privilege('authenticated',c.oid,'select,insert,update,delete') authenticated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='crm' AND c.relkind='r'`);
    for (const row of rows.rows) assert.deepEqual([row.rls, row.service, row.anon, row.authenticated], [true, false, false, false], row.name);
    const functions = await db.query<{ name: string; secure: boolean; config: string[]; anon: boolean; authenticated: boolean; service: boolean }>(`SELECT p.proname name,p.prosecdef secure,p.proconfig config,
      has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') service
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'crm_operations_v2_%' OR p.proname LIKE 'crm_expense_receipt_%')`);
    assert.equal(functions.rows.length, 7);
    for (const fn of functions.rows) { assert.deepEqual([fn.secure, fn.anon, fn.authenticated, fn.service], [true, false, false, true], fn.name); assert.ok(fn.config.includes('search_path=""')); }
    const initial = await read();
    assert.equal(initial.extension.sites.length, 1); assert.equal(initial.extension.sites[0].name, 'Main store'); assert.equal(initial.extension.shiftRule.configured, false);
    await role('postgres');
    const bucket = await query<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }>("SELECT to_jsonb(b) AS result FROM storage.buckets b WHERE id='crm-expense-receipts'");
    assert.equal(bucket.public, false); assert.equal(bucket.file_size_limit, 3145728); assert.equal(bucket.allowed_mime_types.length, 4);
    for (const value of ['anon', 'authenticated'] as const) {
      await role(value); await db.query("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
      await rejects(() => read(), '42501'); await rejects(() => exported(), '42501');
      await rejects(() => reserve(crypto.randomUUID()), '42501'); await rejects(() => db.query('SELECT * FROM crm.customer_payments'), '42501');
    }
    await role('service_role'); await rejects(() => db.query('SELECT crm.main_store_id()'), '42501');
  });

  test('all invalid memberships are denied and every administrative feature denies Manager', async () => {
    for (const actor of [ids.removed, ids.pending, ids.anonymous, ids.banned, ids.outsider]) {
      await rejects(() => read(actor), 'PT403'); await rejects(() => exported(actor), 'PT403');
      await rejects(() => commit(request('site_save', { name: 'Site' }, 0, actor)), 'PT403');
      await rejects(() => access(crypto.randomUUID(), actor), 'PT403');
    }
    for (const action of ['site_save', 'site_assign', 'shift_rule_save', 'attendance_correct', 'attendance_overtime_approve', 'material_request_review', 'material_request_fulfill',
      'purchase_order_create', 'purchase_order_receive', 'purchase_order_cancel', 'payment_installment_add', 'payment_record', 'payment_void']) {
      await rejects(() => mutate(action, {}, ids.manager), 'PT403');
    }
    for (const action of ['stock_transfer', 'stock_return', 'material_request_create', 'attendance_check_in']) await rejects(() => mutate(action, {}, ids.viewer), 'PT403');
    await rejects(() => mutate('stock_location_move', { type: ' ADJUST ' }, ids.manager), 'PT403');
  });

  test('Accountant uses shared stock, own attendance and expenses without Admin financial or activity access', async () => {
    const material = await item();
    const mainStore = (await read()).extension.sites.find(row => row.system)!;
    const assignedSite = await site('Accountant assigned construction site');
    await mutate('site_assign', { userId: ids.accountant, siteId: assignedSite.id });
    await mutate('attendance_check_in', { siteId: assignedSite.id }, ids.accountant);
    await mutate('site_assign', { userId: ids.sales, siteId: assignedSite.id });
    await mutate('attendance_check_in', { siteId: assignedSite.id }, ids.sales);
    await mutate('stock_location_move', { itemId: material.id, siteId: mainStore.id, type: 'OUT', quantity: '1' }, ids.accountant);
    const ownExpense = await expense(ids.accountant);
    const privateExpense = await expense(ids.sales);
    const receipt = await reserve(ownExpense.id, ids.accountant);
    await complete(receipt, ids.accountant);
    await rejects(() => reserve(privateExpense.id, ids.accountant), 'PT404');
    const own = await read(ids.accountant); const out = await exported(ids.accountant);
    assert.equal(own.user.role, 'ACCOUNTANT');
    assert.deepEqual(own.permissions, { admin: false, canWrite: true });
    assert.equal(own.stockItems.find(row => row.id === material.id)?.quantityMilli, 19000);
    assert.deepEqual(own.expenses.map(row => row.id), [ownExpense.id]);
    assert.equal(own.expenseSummary, null);
    assert.equal(own.attendance.length, 1);
    assert.equal(own.attendance[0].userId, ids.accountant);
    assert.ok(own.extension.attendanceCalendar.every(row => row.userId === ids.accountant));
    assert.ok(own.extension.attendanceSummary.every(row => row.userId === ids.accountant));
    assert.deepEqual(own.extension.expenseReceipts.map(row => row.expenseId), [ownExpense.id]);
    assert.deepEqual([own.extension.paymentAccounts, own.extension.paymentInstallments, own.extension.customerPayments, own.extension.purchaseOrders], [null, null, null, null]);
    assert.equal(JSON.stringify(out).includes(privateExpense.id), false);
    assert.equal('audit' in out, false);
    assert.equal('expenseSummary' in out, false);
    for (const action of ['expense_review', 'attendance_correct', 'attendance_overtime_approve', 'payment_record', 'payment_void', 'site_assign', 'purchase_order_create']) {
      await rejects(() => mutate(action, {}, ids.accountant), 'PT403');
    }
    await rejects(() => query('SELECT public.crm_team_activity_read($1::uuid,$2,null,$3,1) AS result', [ids.accountant, month, 'all']), 'PT403');
    const admin = await read();
    assert.equal(admin.expenses.length, 2);
    assert.ok(admin.expenseSummary);
    assert.equal(admin.attendance.length, 2);
  });

  test('assigned sites control employee check-in, forged site labels are ignored and snapshots survive reassignment', async () => {
    const a = await site('Site A'); const b = await site('Site B');
    await rejects(() => mutate('attendance_check_in', {}, ids.sales), 'PT403');
    await mutate('site_assign', { userId: ids.sales, siteId: a.id });
    await rejects(() => mutate('attendance_check_in', { siteId: b.id }, ids.sales), 'PT403');
    const checked = (await mutate('attendance_check_in', { site: 'Forged site', siteId: a.id }, ids.sales)).data.myTodayAttendance!;
    assert.equal(checked.site, 'Site A'); assert.equal(checked.siteId, a.id);
    assert.deepEqual((await read(ids.manager)).extension.assignments, []);
    await mutate('site_save', { id: a.id, name: 'Renamed site' });
    await mutate('site_assign', { userId: ids.sales, siteId: b.id });
    assert.equal((await read(ids.sales)).myTodayAttendance?.site, 'Site A');
    assert.equal((await read(ids.sales)).extension.assignments[0].siteId, b.id);
    await mutate('attendance_check_out', {}, ids.sales);
    await rejects(() => mutate('site_active', { id: b.id, active: false }), 'PT409');
    await mutate('site_assign', { userId: ids.sales, siteId: null });
    await mutate('site_active', { id: b.id, active: false });
    await rejects(() => mutate('site_assign', { userId: ids.sales, siteId: b.id }), 'PT400');
    await mutate('site_assign', { userId: ids.removed, siteId: null });
    await rejects(() => mutate('site_assign', { userId: ids.removed, siteId: a.id }), 'PT404');
    const main = (await read()).extension.sites.find(row => row.system)!;
    await rejects(() => mutate('site_save', { id: main.id, name: 'Renamed main store' }), 'PT409');
    await rejects(() => mutate('site_active', { id: main.id, active: false }), 'PT409');
    await rejects(() => mutate('site_assign', { userId: ids.sales, siteId: main.id }), 'PT400');
    await mutate('attendance_check_in', { siteId: a.id });
    assert.equal((await read()).myTodayAttendance?.site, 'Renamed site');
  });

  test('historical attendance remains correctable after its site is archived without permitting new inactive links', async () => {
    const a = await site('Historical site'); const archived = await site('Other closed site'); const workDate = day(-2);
    const record = (await mutate('attendance_correct', { userId: ids.sales, workDate, status: 'PRESENT', siteId: a.id,
      checkIn: `${workDate}T09:00:00+05:30`, checkOut: `${workDate}T18:00:00+05:30`, reason: 'Historical record' })).data.extension.attendanceCalendar.find(row => row.workDate === workDate)!;
    await mutate('site_save', { id: a.id, name: 'Renamed historical site' });
    await mutate('site_active', { id: a.id, active: false }); await mutate('site_active', { id: archived.id, active: false });
    const corrected = (await mutate('attendance_correct', { userId: ids.sales, workDate, status: 'HALF_DAY', siteId: a.id,
      checkIn: `${workDate}T09:00:00+05:30`, checkOut: `${workDate}T13:00:00+05:30`, reason: 'Confirmed earlier departure' })).data.extension.attendanceCalendar.find(row => row.id === record.id)!;
    assert.equal(corrected.siteId, a.id); assert.equal(corrected.site, 'Historical site'); assert.equal(corrected.status, 'HALF_DAY');
    assert.equal(corrected.metrics.workedMinutes, 240); assert.deepEqual(corrected.shiftSnapshot, record.shiftSnapshot);
    await rejects(() => mutate('attendance_correct', { userId: ids.sales, workDate, status: 'PRESENT', siteId: archived.id, reason: 'Cannot move to another closed site' }), 'PT400');
    await rejects(() => mutate('attendance_correct', { userId: ids.manager, workDate, status: 'PRESENT', siteId: a.id, reason: 'Cannot add a new record at a closed site' }), 'PT400');
    await mutate('attendance_correct', { userId: ids.sales, workDate, status: 'PRESENT', siteId: null, reason: 'Correct site to office' });
    assert.equal((await read(ids.sales)).extension.attendanceCalendar.find(row => row.id === record.id)?.siteId, null);
  });

  test('shift metrics freeze per record, overtime is reviewed and corrections clear approval', async () => {
    const old = day(-3); const workDate = day(-2);
    await mutate('attendance_correct', { userId: ids.sales, workDate: old, status: 'PRESENT', checkIn: `${old}T09:00:00+05:30`, checkOut: `${old}T19:00:00+05:30`, reason: 'Old shift' });
    await mutate('shift_rule_save', { configured: true, startLocal: '09:00', endLocal: '18:00', breakMinutes: 60, graceMinutes: 10, overnight: false });
    const record = (await mutate('attendance_correct', { userId: ids.sales, workDate, status: 'PRESENT', checkIn: `${workDate}T09:20:00+05:30`, checkOut: `${workDate}T19:30:00+05:30`, reason: 'Shift record' })).data.extension.attendanceCalendar.find(row => row.workDate === workDate)!;
    assert.deepEqual([record.metrics.elapsedMinutes, record.metrics.workedMinutes, record.metrics.expectedMinutes, record.metrics.lateMinutes, record.metrics.eligibleOvertimeMinutes], [610, 550, 480, 10, 70]);
    await rejects(() => mutate('attendance_overtime_approve', { id: record.id, minutes: 71, reason: 'Too much' }), 'PT400');
    await mutate('attendance_overtime_approve', { id: record.id, minutes: 60, reason: 'Approved site overtime' });
    await mutate('shift_rule_save', { configured: true, startLocal: '08:00', endLocal: '16:00', breakMinutes: 30, graceMinutes: 0 });
    let data = await read(ids.sales);
    const frozen = data.extension.attendanceCalendar.find(row => row.id === record.id)!;
    assert.equal(frozen.shiftSnapshot.startLocal, '09:00'); assert.equal(frozen.metrics.approvedOvertimeMinutes, 60);
    const oldRecord = (await exported(ids.sales)).extension.attendanceCalendar.find(row => row.workDate === old)!;
    assert.equal(oldRecord.shiftSnapshot.configured, false); assert.equal(oldRecord.metrics.expectedMinutes, null); assert.equal(oldRecord.metrics.workedMinutes, 600);
    await mutate('attendance_correct', { userId: ids.sales, workDate, status: 'HALF_DAY', checkIn: `${workDate}T09:20:00+05:30`, checkOut: `${workDate}T19:00:00+05:30`, reason: 'Corrected departure' });
    data = await read(ids.sales);
    const corrected = data.extension.attendanceCalendar.find(row => row.id === record.id)!;
    assert.equal(corrected.shiftSnapshot.startLocal, '09:00'); assert.equal(corrected.metrics.approvedOvertimeMinutes, 0); assert.equal(corrected.metrics.overtimeReviewedBy, null);
    await rejects(() => mutate('shift_rule_save', { configured: true, startLocal: '18:00', endLocal: '09:00', overnight: false }), 'PT400');
    await mutate('shift_rule_save', { configured: true, startLocal: '20:00', endLocal: '06:00', overnight: true, breakMinutes: 60, graceMinutes: 0 });
    const overnightDate = day(-1);
    await mutate('attendance_correct', { userId: ids.manager, workDate: workDate, status: 'PRESENT', checkIn: `${workDate}T20:00:00+05:30`, checkOut: `${overnightDate}T07:00:00+05:30`, reason: 'Overnight shift' });
    assert.equal((await read(ids.manager)).extension.attendanceCalendar[0].metrics.eligibleOvertimeMinutes, 60);
  });

  test('calendar is complete beyond the base history limit, scoped by member and never invents absences', async () => {
    await role('postgres');
    await db.exec(`INSERT INTO auth.users(id,email,email_confirmed_at) SELECT ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'calendar'||n||'@example.invalid',now() FROM generate_series(1,20)n;
      INSERT INTO crm.members(user_id,name,email,role) SELECT id,'Calendar member',email,'SALES' FROM auth.users WHERE email LIKE 'calendar%';
      INSERT INTO crm.attendance(user_id,work_date,status,source) SELECT m.user_id,d::date,'PRESENT','ADMIN' FROM crm.members m CROSS JOIN generate_series(date '2020-01-01',date '2020-01-31',interval '1 day')d WHERE m.email LIKE 'calendar%';`);
    await role('service_role');
    const all = await read(ids.owner, '2020-01'); assert.equal(all.attendance.length, 500); assert.equal(all.extension.attendanceCalendar.length, 620);
    assert.equal(all.extension.attendanceSummary.length, 20);
    assert.ok(all.extension.attendanceSummary.every(row => row.recordedDays === 31 && row.presentDays === 31 && row.absentDays === 0 && row.workedMinutes === 0));
    const own = await read('30000000-0000-4000-8000-000000000001', '2020-01');
    assert.equal(own.extension.attendanceCalendar.length, 31); assert.equal(own.extension.attendanceSummary.length, 1);
    assert.equal((await read(ids.manager, '2020-01')).extension.attendanceCalendar.length, 0);
    assert.equal((await exported()).extension.attendanceCalendar.length, 620);
  });

  test('legacy movements, site transfers and unused returns preserve locations and company totals', async () => {
    const stock = await item('20'); const a = await site(); const b = await site(); const main = (await read()).extension.sites.find(row => row.system)!;
    await mutate('stock_transfer', { itemId: stock.id, fromSiteId: main.id, toSiteId: a.id, quantity: '12.5' }, ids.sales);
    let data = await read(ids.manager); assert.equal(data.stockItems[0].receivedMilli, '20000'); assert.equal(data.stockItems[0].usedMilli, '0'); assert.equal(data.stockItems[0].quantityMilli, 20000);
    const before = await state();
    await rejects(() => commit(request('stock_move', { itemId: stock.id, type: 'OUT', quantity: '8' }, data.revision, ids.sales), true), 'PT409');
    assert.deepEqual(await state(), before);
    const used = await mutate('stock_location_move', { itemId: stock.id, siteId: a.id, type: 'OUT', quantity: '5' }, ids.operations);
    const out = used.data.stockMovements.find(row => row.type === 'OUT')!;
    await mutate('stock_return', { movementId: out.id, siteId: b.id, quantity: '2', reason: 'Unused bags returned' }, ids.sales);
    data = await read(ids.viewer);
    assert.deepEqual([data.stockItems[0].receivedMilli, data.stockItems[0].usedMilli, data.stockItems[0].returnedMilli, data.stockItems[0].adjustedMilli, data.stockItems[0].quantityMilli], ['20000', '3000', '2000', '0', 17000]);
    assert.equal(data.stockMovements.find(row => row.id === out.id)?.returnedMilli, '2000');
    assert.equal(data.stockMovements.find(row => row.kind === 'RETURN')?.siteId, b.id);
    await rejects(() => mutate('stock_return', { movementId: out.id, quantity: '3.001', reason: 'Too many' }, ids.sales), 'PT409');
    await rejects(() => mutate('stock_transfer', { itemId: stock.id, fromSiteId: a.id, toSiteId: a.id, quantity: '1' }, ids.sales), 'PT400');
    await mutate('stock_location_move', { itemId: stock.id, siteId: a.id, type: 'ADJUST', quantity: '6', note: 'Physical count' });
    data = await read(); assert.equal(data.stockItems[0].adjustedMilli, '-1500'); assert.equal(data.stockItems[0].quantityMilli, 15500);
    await assertStock();
    await rejects(() => mutate('site_active', { id: a.id, active: false }), 'PT409');
    await rejects(() => mutate('stock_item_save', { id: stock.id, sku: stock.sku, name: stock.name, unit: 'kg' }), 'PT409');
  });

  test('material requests are private to the requester, reviewed by Owner and partially fulfilled atomically', async () => {
    const stock = await item('20'); const a = await site(); const b = await site(); const main = (await read()).extension.sites.find(row => row.system)!;
    await mutate('site_assign', { userId: ids.sales, siteId: a.id });
    await rejects(() => mutate('material_request_create', { siteId: b.id, itemId: stock.id, quantity: '5' }, ids.sales), 'PT403');
    const created = (await mutate('material_request_create', { siteId: a.id, itemId: stock.id, quantity: '5', note: 'Needed for slab' }, ids.sales)).data.extension.materialRequests[0];
    assert.equal((await read(ids.manager)).extension.materialRequests.length, 0);
    await rejects(() => mutate('material_request_cancel', { id: created.id, reason: 'Other user' }, ids.manager), 'PT403');
    await rejects(() => mutate('material_request_review', { id: created.id, status: 'REJECTED' }), 'PT400');
    await mutate('material_request_review', { id: created.id, status: 'APPROVED' });
    await rejects(() => mutate('material_request_cancel', { id: created.id, reason: 'After approval' }, ids.sales), 'PT409');
    await mutate('material_request_fulfill', { id: created.id, fromSiteId: main.id, quantity: '2' });
    let current = (await read(ids.sales)).extension.materialRequests[0]; assert.equal(current.fulfilledMilli, 2000); assert.equal(current.status, 'APPROVED');
    const before = await state(); await rejects(() => mutate('material_request_fulfill', { id: created.id, fromSiteId: main.id, quantity: '4' }), 'PT409'); assert.deepEqual(await state(), before);
    await mutate('material_request_fulfill', { id: created.id, fromSiteId: main.id, quantity: '3' });
    current = (await read(ids.sales)).extension.materialRequests[0]; assert.equal(current.fulfilledMilli, 5000); assert.equal(current.status, 'FULFILLED');
    assert.equal((await read()).stockItems[0].receivedMilli, '20000'); assert.equal((await read()).stockItems[0].usedMilli, '0'); await assertStock();
  });

  test('pending requests and purchase orders freeze material units before the first delivery', async () => {
    const requested = await item('0'); const purchased = await item('0'); const a = await site();
    await mutate('material_request_create', { siteId: a.id, itemId: requested.id, quantity: '5' });
    await mutate('purchase_order_create', { supplier: 'Pending supplier', siteId: a.id, lines: [{ itemId: purchased.id, quantity: '10' }] });
    assert.equal((await read()).stockMovements.length, 0);
    for (const stock of [requested, purchased]) {
      await rejects(() => mutate('stock_item_save', { id: stock.id, sku: stock.sku, name: stock.name, unit: 'kg' }), 'PT409');
      assert.equal((await read()).stockItems.find(row => row.id === stock.id)?.unit, 'bag');
    }
  });

  test('purchase receipts are Owner-only, partial and atomic across every line', async () => {
    const first = await item('0'); const second = await item('0'); const a = await site();
    const created = (await mutate('purchase_order_create', { supplier: 'Test supplier', siteId: a.id, lines: [{ itemId: first.id, quantity: '10' }, { itemId: second.id, quantity: '5' }] })).data.extension.purchaseOrders![0];
    assert.match(created.number, /^SC\/PO\/[0-9]{6}$/); assert.equal((await read(ids.manager)).extension.purchaseOrders, null); assert.equal((await exported(ids.manager)).extension.purchaseOrders, null);
    const firstLine = created.lines.find(row => row.itemId === first.id)!; const secondLine = created.lines.find(row => row.itemId === second.id)!;
    await mutate('purchase_order_receive', { id: created.id, lines: [{ lineId: firstLine.id, quantity: '4' }] });
    assert.equal((await read()).extension.purchaseOrders![0].status, 'PART_RECEIVED');
    const before = await state();
    await rejects(() => mutate('purchase_order_receive', { id: created.id, lines: [{ lineId: firstLine.id, quantity: '2' }, { lineId: secondLine.id, quantity: '6' }] }), 'PT409');
    assert.deepEqual(await state(), before); assert.equal((await read()).stockItems.find(row => row.id === first.id)?.quantityMilli, 4000);
    await rejects(() => mutate('purchase_order_create', { supplier: 'Duplicate', siteId: a.id, lines: [{ itemId: first.id, quantity: '1' }, { itemId: first.id, quantity: '2' }] }), 'PT400');
    await mutate('purchase_order_receive', { id: created.id, lines: [{ lineId: firstLine.id, quantity: '6' }, { lineId: secondLine.id, quantity: '5' }], reference: 'DELIVERY-1' });
    assert.equal((await read()).extension.purchaseOrders![0].status, 'RECEIVED');
    await rejects(() => mutate('purchase_order_receive', { id: created.id, lines: [{ lineId: firstLine.id, quantity: '1' }] }), 'PT409');
    await assertStock();
    const cancelled = (await mutate('purchase_order_create', { supplier: 'Other supplier', siteId: a.id, lines: [{ itemId: first.id, quantity: '5' }] })).data.extension.purchaseOrders!.find(row => row.id !== created.id)!;
    await mutate('purchase_order_receive', { id: cancelled.id, lines: [{ lineId: cancelled.lines[0].id, quantity: '1' }] });
    await mutate('purchase_order_cancel', { id: cancelled.id, reason: 'Supplier cannot deliver the remainder' });
    assert.equal((await read()).extension.purchaseOrders!.find(row => row.id === cancelled.id)?.lines[0].receivedMilli, 1000);
    await role('postgres'); await db.exec('UPDATE crm.operations_state SET purchase_sequence=999999 WHERE id=1'); await role('service_role');
    const expanded = (await mutate('purchase_order_create', { supplier: 'Expanded numbering', siteId: a.id, lines: [{ itemId: first.id, quantity: '1' }] })).data.extension.purchaseOrders!.find(row => row.supplier === 'Expanded numbering')!;
    assert.equal(expanded.number, 'SC/PO/1000000');
  });

  test('payments allocate FIFO with exact Owner-only totals, advances, cancellations and immutable void history', async () => {
    const order = await workOrder(); assert.equal(order.snapshot.totals.total, 1180000);
    const overdue = (await mutate('payment_installment_add', { workOrderId: order.id, title: 'First installment', dueDate: day(-1), amount: '4000' })).data.extension.paymentInstallments![0];
    const later = (await mutate('payment_installment_add', { workOrderId: order.id, title: 'Second installment', dueDate: day(10), amount: '4000' })).data.extension.paymentInstallments!.find(row => row.id !== overdue.id)!;
    await rejects(() => mutate('payment_installment_add', { workOrderId: order.id, title: 'Too much', dueDate: today, amount: '4000' }), 'PT409');
    await rejects(() => mutate('payment_record', { workOrderId: order.id, paymentDate: day(1), amount: '1', method: 'CASH' }), 'PT400');
    let data = (await mutate('payment_record', { workOrderId: order.id, paymentDate: today, amount: '3000', method: 'BANK', reference: 'PRIVATE-PAYMENT-REF' })).data;
    const paid = data.extension.customerPayments![0];
    assert.equal(data.extension.paymentInstallments!.find(row => row.id === overdue.id)?.balancePaise, '100000');
    assert.equal(data.extension.paymentAccounts![0].overduePaise, '100000');
    data = (await mutate('payment_record', { workOrderId: order.id, paymentDate: today, amount: '6000', method: 'UPI' })).data;
    assert.deepEqual([data.extension.paymentAccounts![0].receivedPaise, data.extension.paymentAccounts![0].outstandingPaise, data.extension.paymentAccounts![0].unallocatedPaise], ['900000', '280000', '100000']);
    assert.equal(data.extension.paymentInstallments!.find(row => row.id === later.id)?.paidPaise, '400000');
    await rejects(() => mutate('payment_record', { workOrderId: order.id, paymentDate: today, amount: '2800.01', method: 'CASH' }), 'PT409');
    data = (await mutate('payment_void', { id: paid.id, reason: 'Duplicate bank entry' })).data;
    assert.equal(data.extension.paymentAccounts![0].receivedPaise, '600000'); assert.equal(data.extension.customerPayments!.find(row => row.id === paid.id)?.voidReason, 'Duplicate bank entry');
    assert.equal(data.extension.paymentInstallments!.find(row => row.id === later.id)?.paidPaise, '200000');
    await mutate('payment_installment_cancel', { id: overdue.id, reason: 'Revised payment plan' });
    assert.equal((await read()).extension.paymentAccounts![0].unallocatedPaise, '200000');
    for (const actor of [ids.manager, ids.sales, ids.operations, ids.accountant, ids.viewer]) {
      const own = await read(actor); const out = await exported(actor);
      assert.deepEqual([own.extension.paymentAccounts, own.extension.paymentInstallments, own.extension.customerPayments], [null, null, null]);
      assert.equal(JSON.stringify(out).includes('PRIVATE-PAYMENT-REF'), false);
    }
    await role('postgres'); await rejects(() => db.query('UPDATE crm.customer_payments SET amount_paise=1 WHERE id=$1', [paid.id]), 'PT403');
    await rejects(() => db.query('DELETE FROM crm.customer_payment_voids WHERE payment_id=$1', [paid.id]), 'PT403'); await role('service_role');
    await core('workorder_save', { id: order.id, owner: '', startDate: '', endDate: '', status: 'CANCELLED' });
    await rejects(() => mutate('payment_record', { workOrderId: order.id, paymentDate: today, amount: '1', method: 'CASH' }), 'PT409');
    const remaining = (await read()).extension.customerPayments!.find(row => !row.voidedAt)!;
    await mutate('payment_void', { id: remaining.id, reason: 'Cancelled contract receipt correction' });
    assert.equal((await read()).extension.paymentAccounts![0].receivedPaise, '0');
    const activity = await query<{ entries: { module: string }[] }>('SELECT public.crm_team_activity_read($1::uuid,$2,null,$3,1) AS result', [ids.owner, month, 'payments']);
    assert.ok(activity.entries.length > 0 && activity.entries.every(row => row.module === 'payments'));
  });

  test('extension receipts prevent duplicate writes, reject stale state and reauthorize Owner after downgrade', async () => {
    const initial = await read(); const req = request('site_save', { name: 'One site only' }, initial.revision);
    const first = await commit(req); await item();
    const replay = await commit(req); assert.equal(replay.data.revision, first.data.revision + 1); assert.equal(replay.data.extension.sites.filter(row => row.name === 'One site only').length, 1);
    await rejects(() => commit({ ...req, actor: ids.manager }), 'PT403');
    await rejects(() => commit({ ...req, payload: { name: 'Different' } }), 'PT409');
    const before = await state(); await rejects(() => commit(request('site_save', { name: 'Stale' }, 0)), 'PT409'); assert.deepEqual(await state(), before);
    await role('postgres'); await db.query("UPDATE crm.members SET role='MANAGER' WHERE user_id=$1", [ids.owner]); await role('service_role');
    await rejects(() => commit(req), 'PT403');
  });

  test('receipt reservation binds bytes and quota, never publishes pending metadata, and finalization is idempotent', async () => {
    const e = await expense(); const revision = (await read(ids.sales)).revision; const requestId = crypto.randomUUID();
    const pending = await reserve(e.id, ids.sales, requestId);
    assert.equal(pending.state, 'PENDING'); assert.equal(pending.bucket, 'crm-expense-receipts'); assert.equal(pending.objectPath, `expenses/${e.id}/${pending.id}.png`);
    assert.equal((await read(ids.sales)).revision, revision); assert.equal((await read(ids.sales)).extension.expenseReceipts.length, 0);
    assert.deepEqual(await reserve(e.id, ids.sales, requestId), pending);
    await rejects(() => reserve(e.id, ids.sales, requestId, { sha: 'b'.repeat(64) }), 'PT409');
    await rejects(() => complete(pending, ids.sales, 'b'.repeat(64)), 'PT409');
    await rejects(() => access(pending.id), 'PT404');
    const ready = await complete(pending); assert.equal((await read(ids.sales)).revision, revision + 1);
    assert.equal('objectPath' in ready, false); assert.equal('sha256' in ready, false);
    assert.deepEqual(await complete(pending), ready); assert.equal((await read(ids.sales)).revision, revision + 1);
    assert.equal((await reserve(e.id, ids.sales, requestId)).state, 'READY');
    assert.equal((await read(ids.sales)).extension.expenseReceipts.length, 1);
    for (let n = 0; n < 4; n++) await reserve(e.id);
    await rejects(() => reserve(e.id), 'PT409');
    const metadata = (await exported(ids.sales)).extension.expenseReceipts[0]; assert.equal('objectPath' in metadata, false); assert.equal('sha256' in metadata, false);
  });

  test('receipt access has no IDOR and approval races cannot attach or remove evidence', async () => {
    const own = await expense(); const pending = await reserve(own.id);
    for (const actor of [ids.manager, ids.owner, ids.operations, ids.viewer]) {
      await rejects(() => reserve(own.id, actor), actor === ids.viewer ? 'PT403' : 'PT404');
      await rejects(() => complete(pending, actor), actor === ids.viewer ? 'PT403' : 'PT404');
      await rejects(() => remove(pending.id, actor), actor === ids.viewer ? 'PT403' : 'PT404');
    }
    await mutate('expense_review', { id: own.id, status: 'APPROVED' });
    await rejects(() => complete(pending), 'PT409');
    const removedPending = await remove(pending.id); assert.equal(removedPending.objectPath, pending.objectPath);
    const again = await remove(pending.id); assert.deepEqual(again, removedPending);
    const second = await expense(); const secondRequest = crypto.randomUUID(); const ready = await reserve(second.id, ids.sales, secondRequest); await complete(ready);
    await rejects(() => access(ready.id, ids.manager), 'PT404');
    assert.equal((await access(ready.id, ids.owner)).objectPath, ready.objectPath);
    await mutate('expense_review', { id: second.id, status: 'APPROVED' });
    await rejects(() => remove(ready.id), 'PT409'); assert.equal((await access(ready.id)).id, ready.id);
    // A response lost after successful completion must remain safely retryable,
    // even if the Owner has reviewed the expense in the meantime.
    assert.equal((await complete(ready)).id, ready.id);
    assert.equal((await reserve(second.id, ids.sales, secondRequest)).state, 'READY');
    await role('postgres'); await db.query('UPDATE crm.members SET active=false WHERE user_id=$1', [ids.sales]); await role('service_role');
    await rejects(() => access(ready.id), 'PT403'); await rejects(() => complete(ready), 'PT403');
    assert.equal((await access(ready.id, ids.owner)).id, ready.id);
  });

  test('receipt type, size, expiration and immutable identity rules are enforced in PostgreSQL', async () => {
    const e = await expense();
    await rejects(() => reserve(e.id, ids.sales, crypto.randomUUID(), { mime: 'text/html' }), 'PT400');
    await rejects(() => reserve(e.id, ids.sales, crypto.randomUUID(), { size: 3145729 }), 'PT400');
    await rejects(() => reserve(e.id, ids.sales, crypto.randomUUID(), { fileName: '../bill.png' }), 'PT400');
    const expiredId = crypto.randomUUID(); const expiredRequest = crypto.randomUUID();
    await role('postgres');
    await db.query(`INSERT INTO crm.expense_receipts(id,expense_id,request_id,file_name,mime_type,size_bytes,sha256,object_path,uploaded_by,expires_at)
      VALUES($1,$2,$3,'bill.png','image/png',1024,$4,$5,$6,clock_timestamp()-interval '1 minute')`, [expiredId, e.id, expiredRequest, hash, `expenses/${e.id}/${expiredId}.png`, ids.sales]);
    await role('service_role');
    await rejects(() => reserve(e.id, ids.sales, expiredRequest), 'PT409');
    const kept = await reserve(e.id);
    for (let n = 0; n < 4; n++) await reserve(e.id);
    await rejects(() => reserve(e.id), 'PT409');
    await role('postgres');
    await rejects(() => db.query("UPDATE crm.expense_receipts SET sha256=$1 WHERE id=$2", ['b'.repeat(64), kept.id]), 'PT403');
    await rejects(() => db.query('DELETE FROM crm.expense_receipts WHERE id=$1', [kept.id]), 'PT403');
    await role('service_role');
    await rejects(() => complete({ ...kept, id: expiredId }), 'PT409');
  });
});

test('the additive migration allocates existing stock without changing totals or manufacturing receipt history', async () => {
  const legacy = new PGlite();
  try {
    await initialize(legacy, false);
    await legacy.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())', [ids.owner, 'upgrade@example.invalid']);
    await legacy.exec('SET ROLE service_role');
    await legacy.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'service_role' })]);
    await legacy.query('SELECT public.crm_bootstrap_owner($1::uuid)', [ids.owner]);
    const selectedMonth = (await legacy.query<{ month: string }>("SELECT to_char(clock_timestamp() at time zone 'Asia/Kolkata','YYYY-MM') AS month")).rows[0].month;
    const legacyMutation = async (action: string, payload: Record<string, unknown>, revision: number) =>
      (await legacy.query<{ result: Result }>('SELECT public.crm_operations_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result',
        [ids.owner, revision, crypto.randomUUID(), action, hash, JSON.stringify(payload), selectedMonth])).rows[0].result;
    const opening = await legacyMutation('stock_item_save', { sku: 'UPGRADE-001', name: 'Existing stock', unit: 'bag', openingQuantity: '40' }, 0);
    const stock = opening.data.stockItems[0];
    const used = await legacyMutation('stock_move', { itemId: stock.id, type: 'OUT', quantity: '7.5' }, opening.data.revision);
    assert.equal(used.data.stockItems[0].quantityMilli, 32500); assert.equal(used.data.stockMovements.length, 2);
    await legacy.exec('RESET ROLE');
    for (const file of migrations.slice(2)) await legacy.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    await legacy.exec('SET ROLE service_role');
    const updated = (await legacy.query<{ result: OperationsData }>('SELECT public.crm_operations_v2_read($1::uuid,$2) AS result', [ids.owner, selectedMonth])).rows[0].result;
    const main = updated.extension.sites.find(row => row.system)!;
    assert.equal(updated.revision, used.data.revision); assert.equal(updated.stockMovements.length, 2);
    assert.deepEqual([updated.stockItems[0].quantityMilli, updated.stockItems[0].receivedMilli, updated.stockItems[0].usedMilli, updated.stockItems[0].adjustedMilli], [32500, '40000', '7500', '0']);
    assert.deepEqual(updated.extension.siteBalances, [{ itemId: stock.id, siteId: main.id, quantityMilli: 32500 }]);
    assert.ok(updated.stockMovements.every(row => row.siteId === main.id));
    assert.equal(updated.extension.transfers.length, 0); assert.equal(updated.extension.returns.length, 0);
    const after = (await legacy.query<{ result: Result }>('SELECT public.crm_operations_v2_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) AS result',
      [ids.owner, updated.revision, crypto.randomUUID(), 'stock_location_move', hash,
        JSON.stringify({ itemId: stock.id, siteId: main.id, type: 'OUT', quantity: '2.5' }), selectedMonth])).rows[0].result.data;
    assert.equal(after.stockItems[0].quantityMilli, 30000); assert.equal(after.extension.siteBalances[0].quantityMilli, 30000);
  } finally { await legacy.close(); }
});
