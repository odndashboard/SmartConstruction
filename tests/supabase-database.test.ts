import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import type { WorkspaceData } from '../lib/types.ts';

/**
 * Execute the actual migration and RPCs against PostgreSQL compiled to WASM.
 * Only the Supabase-provided auth schema/roles are fixtures. PGlite has a single
 * connection: these tests exercise stale revision handling and atomic rollback,
 * but do not claim to simulate concurrent hosted PostgreSQL connections.
 */
const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  manager: '00000000-0000-4000-8000-000000000002',
  sales: '00000000-0000-4000-8000-000000000003',
  operations: '00000000-0000-4000-8000-000000000004',
  viewer: '00000000-0000-4000-8000-000000000005',
  outsider: '00000000-0000-4000-8000-000000000006',
  pending: '00000000-0000-4000-8000-000000000007',
  secondOwner: '00000000-0000-4000-8000-000000000008',
  accountant: '00000000-0000-4000-8000-000000000009',
};
const NOW = new Date('2026-11-23T06:00:00Z');
const hash = 'a'.repeat(64);
let db: PGlite;

async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  const result = await db.query<{ result: T }>(sql, values);
  return result.rows[0]?.result as T;
}

async function setRole(role: 'anon' | 'authenticated' | 'service_role' | 'postgres') {
  await db.exec(`SET LOCAL ROLE ${role}`);
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
}

async function rejectsSql(run: () => Promise<unknown>, codes: string | string[]) {
  const allowed = Array.isArray(codes) ? codes : [codes];
  await db.exec('SAVEPOINT expected_failure');
  try {
    await assert.rejects(run, (error: unknown) => {
      const value = error as { code?: string; message?: string };
      assert.ok(allowed.includes(value.code ?? ''), `Expected SQLSTATE ${allowed.join('/')} but received ${value.code}: ${value.message}`);
      return true;
    });
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}

async function bootstrap(userId = ids.owner) {
  return query('SELECT public.crm_bootstrap_owner($1::uuid) AS result', [userId]);
}

async function read(userId = ids.owner): Promise<WorkspaceData> {
  return query<WorkspaceData>('SELECT public.crm_workspace_read($1::uuid, true) AS result', [userId]);
}

async function addMember(userId: string, name: string, role: string, actor = ids.owner) {
  const email = `${name.toLowerCase()}@example.invalid`;
  return query('SELECT public.crm_add_member($1::uuid, $2::uuid, $3::text, $4::text, $5::text) AS result', [actor, userId, name, email, role]);
}

function emptyChanges(data: WorkspaceData) {
  return {
    company: structuredClone(data.company), sequences: structuredClone(data.sequences),
    upserts: { customers: [] as unknown[], leads: [] as unknown[], followups: [] as unknown[], quotations: [] as unknown[], workorders: [] as unknown[] },
    deleted: { customers: [] as string[], leads: [] as string[], followups: [] as string[], quotations: [] as string[], workorders: [] as string[] },
    members: [] as { userId: string; role: string; active: boolean }[],
    audit: [] as WorkspaceData['activity'], clearDemoAudit: false,
  };
}

function plan(before: WorkspaceData, action: string, payload: unknown, requestId = crypto.randomUUID()) {
  const after = structuredClone(before);
  const message = applyAction(after, action, payload, NOW);
  const changes = emptyChanges(after);
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)]));
    changes.upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row));
    const kept = new Set(after[key].map(row => row.id));
    changes.deleted[key] = before[key].filter(row => !kept.has(row.id)).map(row => row.id);
  }
  changes.members = after.members.filter(member => {
    const previous = before.members.find(row => row.userId === member.userId);
    return previous && (previous.role !== member.role || previous.active !== member.active);
  }).map(({ userId, role, active }) => ({ userId, role, active }));
  const oldEvents = new Set(before.activity.map(event => event.id));
  changes.audit = after.activity.filter(event => !oldEvents.has(event.id));
  changes.clearDemoAudit = action === 'clear_demo';
  return { actor: before.user.userId, expectedRevision: before.revision, requestId, action, payloadHash: hash, changes, message };
}

type Mutation = ReturnType<typeof plan>;
async function commit(input: Mutation): Promise<{ data: WorkspaceData; message: string }> {
  return query('SELECT public.crm_workspace_commit($1::uuid, $2::bigint, $3::text, $4::text, $5::text, $6::jsonb, $7::text) AS result', [
    input.actor, input.expectedRevision, input.requestId, input.action, input.payloadHash, JSON.stringify(input.changes), input.message,
  ]);
}

async function mutate(action: string, payload: unknown, actor = ids.owner) {
  return commit(plan(await read(actor), action, payload));
}

describe('Supabase database authorization and atomic writes', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        email text,
        email_confirmed_at timestamptz,
        banned_until timestamptz,
        raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_anonymous boolean NOT NULL DEFAULT false
      );
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role';
      $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;
    `);
    const migration = await readFile(new URL('../supabase/migrations/202611230001_crm.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(await readFile(new URL('../supabase/migrations/20261124072200_accountant_and_lead_status.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261127062903_lead_expected_kw.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261127065452_manual_lead_won.sql', import.meta.url), 'utf8'));
  });

  beforeEach(async () => {
    await db.exec('BEGIN');
    for (const [name, userId] of Object.entries(ids)) {
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data) VALUES ($1, $2, $3, $4)', [
        userId, `${name.toLowerCase()}@example.invalid`, name === 'pending' ? null : NOW.toISOString(), JSON.stringify({ name }),
      ]);
    }
    await setRole('service_role');
  });

  afterEach(async () => { await db.exec('ROLLBACK'); });
  after(async () => { await db.close(); });

  test('CRM tables have RLS and public roles cannot call privileged functions or query tables', async () => {
    const functions = await db.query<{ name: string; anon: boolean; authenticated: boolean; service: boolean }>(`
      SELECT p.proname AS name,
        has_function_privilege('anon', p.oid, 'execute') AS anon,
        has_function_privilege('authenticated', p.oid, 'execute') AS authenticated,
        has_function_privilege('service_role', p.oid, 'execute') AS service
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'crm_%'
    `);
    assert.ok(functions.rows.length >= 6);
    for (const fn of functions.rows) {
      assert.equal(fn.anon, false, `${fn.name} must not be executable by anonymous clients`);
      assert.equal(fn.authenticated, false, `${fn.name} must not be executable by signed-in browser clients`);
      assert.equal(fn.service, true, `${fn.name} must be callable by the authorized application server`);
    }
    const tables = await db.query<{ name: string; rls: boolean; anon: boolean; authenticated: boolean }>(`
      SELECT c.relname AS name, c.relrowsecurity AS rls,
        has_table_privilege('anon', c.oid, 'select,insert,update,delete') AS anon,
        has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') AS authenticated
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'crm' AND c.relkind = 'r'
    `);
    assert.ok(tables.rows.length >= 8);
    for (const table of tables.rows) {
      assert.equal(table.rls, true, `${table.name} requires RLS`);
      assert.equal(table.anon, false);
      assert.equal(table.authenticated, false);
    }
    await setRole('anon');
    await rejectsSql(() => bootstrap(), '42501');
    await rejectsSql(() => read(), '42501');
    await rejectsSql(() => db.query('SELECT * FROM crm.members'), '42501');
    await setRole('authenticated');
    await rejectsSql(() => read(), '42501');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'service_role' })]);
    await rejectsSql(() => read(), '42501');
    await setRole('service_role');
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: 'authenticated' })]);
    await rejectsSql(() => read(), 'PT403');
  });

  test('an authenticated public visitor receives no membership or owner role', async () => {
    assert.equal(await query('SELECT public.crm_bootstrap_status() AS result'), false);
    await rejectsSql(() => read(ids.outsider), ['PT403', 'PT503']);
    assert.equal(await query('SELECT public.crm_bootstrap_status() AS result'), false);
    await bootstrap();
    await rejectsSql(() => read(ids.outsider), 'PT403');
    const data = await read();
    assert.equal(data.members.length, 1);
    assert.equal(data.members[0].userId, ids.owner);
  });

  test('operator bootstrap designates one exact pending account and cannot be repeated', async () => {
    // Same administrator invocation documented for the Supabase SQL Editor;
    // beforeEach/afterEach supply the surrounding test transaction.
    await setRole('postgres');
    await db.exec(`SET LOCAL ROLE service_role; SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);`);
    await bootstrap(ids.pending);
    assert.equal(await query('SELECT public.crm_bootstrap_status() AS result'), true);
    await rejectsSql(() => read(ids.pending), 'PT403');
    await rejectsSql(() => bootstrap(ids.outsider), 'PT409');
    await setRole('postgres');
    await db.query('UPDATE auth.users SET email_confirmed_at = $1 WHERE id = $2', [NOW.toISOString(), ids.pending]);
    await setRole('service_role');
    const data = await read(ids.pending);
    assert.equal(data.user.role, 'OWNER');
    assert.equal(data.members.length, 1);
  });

  test('member enrollment verifies owner authority and Auth identity; retry cannot escalate a role', async () => {
    await bootstrap();
    await addMember(ids.sales, 'sales', 'SALES');
    const before = await read();
    await addMember(ids.sales, 'sales', 'OWNER');
    const after = await read();
    assert.equal(after.members.find(member => member.userId === ids.sales)?.role, 'SALES');
    assert.equal(after.revision, before.revision);
    await rejectsSql(() => addMember(ids.viewer, 'viewer', 'VIEWER', ids.sales), 'PT403');
    await rejectsSql(() => addMember(ids.viewer, 'wrong-email', 'VIEWER'), ['PT400', 'PT403']);
    assert.equal((await read()).members.length, 2);
  });

  test('ordinary writes persist records, audit, and revision together and retry only once', async () => {
    await bootstrap();
    const before = await read();
    const input = plan(before, 'customer_save', { name: 'Synthetic client' });
    const first = await commit(input);
    assert.equal(first.data.revision, before.revision + 1);
    assert.equal(first.data.customers.length, 1);
    assert.equal(first.data.customers[0].name, 'Synthetic client');
    assert.equal(first.data.activity.filter(event => event.action === 'customer_save').length, 1);
    const retry = await commit(input);
    assert.equal(retry.data.revision, first.data.revision);
    assert.equal(retry.data.customers.length, 1);
    assert.equal(retry.data.activity.filter(event => event.action === 'customer_save').length, 1);
    assert.equal(retry.message, first.message);
    const prepared = await query<{ data: WorkspaceData; receiptMessage: string | null }>(
      'SELECT public.crm_mutation_prepare($1::uuid, $2::text, $3::text, $4::text) AS result',
      [ids.owner, input.requestId, input.action, input.payloadHash],
    );
    assert.equal(prepared.receiptMessage, first.message);
    assert.equal(prepared.data.revision, first.data.revision);
  });

  test('Accountant enrollment and role changes remain Owner-only and never grant CRM writes', async () => {
    await bootstrap();
    await addMember(ids.accountant, 'accountant', 'ACCOUNTANT');
    await addMember(ids.sales, 'sales', 'SALES');
    assert.equal((await read(ids.accountant)).user.role, 'ACCOUNTANT');
    await addMember(ids.accountant, 'accountant', 'OWNER');
    assert.equal((await read(ids.accountant)).user.role, 'ACCOUNTANT', 'Enrollment retry cannot promote an existing Accountant');
    await mutate('member_role', { userId: ids.sales, role: 'ACCOUNTANT' });
    assert.equal((await read(ids.sales)).user.role, 'ACCOUNTANT');
    await rejectsSql(() => addMember(ids.viewer, 'viewer', 'ACCOUNTANT', ids.accountant), 'PT403');
    for (const action of ['customer_save', 'lead_save', 'lead_status', 'followup_save', 'quote_save', 'quote_issue', 'workorder_save', 'company_save', 'member_role', 'member_active']) {
      const before = await read(ids.accountant);
      await rejectsSql(() => commit({ actor: ids.accountant, expectedRevision: before.revision, requestId: crypto.randomUUID(), action, payloadHash: hash, changes: emptyChanges(before), message: 'Forbidden Accountant action' }), 'PT403');
    }
    await mutate('member_role', { userId: ids.accountant, role: 'MANAGER' });
    assert.equal((await read(ids.accountant)).user.role, 'MANAGER');
  });

  test('Admin and Manager change lead status; Sales and Accountant cannot forge the dedicated action', async () => {
    await bootstrap();
    await addMember(ids.manager, 'manager', 'MANAGER');
    await addMember(ids.sales, 'sales', 'SALES');
    await addMember(ids.accountant, 'accountant', 'ACCOUNTANT');
    const customer = (await mutate('customer_save', { name: 'Lead status client' })).data.customers[0];
    const lead = (await mutate('lead_save', { customerId: customer.id, title: 'Lead status project' })).data.leads[0];
    await mutate('lead_status', { id: lead.id, status: 'CONTACTED' });
    await mutate('lead_status', { id: lead.id, status: 'SITE_VISIT' }, ids.manager);
    for (const actor of [ids.sales, ids.accountant]) {
      const forged = plan(await read(), 'lead_status', { id: lead.id, status: 'NEGOTIATION' });
      await rejectsSql(() => commit({ ...forged, actor }), 'PT403');
    }
    assert.equal((await read()).leads[0].status, 'SITE_VISIT');
    await mutate('lead_status', { id: lead.id, status: 'LOST', lostReason: 'Client postponed construction' }, ids.manager);
    assert.equal((await read()).leads[0].lostReason, 'Client postponed construction');
    await mutate('lead_status', { id: lead.id, status: 'NEW' });
    assert.equal((await read()).leads[0].lostReason, '');
  });

  test('Sales cannot bypass lead status permissions through forged lead_save rows or new leads', async () => {
    await bootstrap();
    await addMember(ids.sales, 'sales', 'SALES');
    const customer = (await mutate('customer_save', { name: 'Forged status client' })).data.customers[0];
    const lead = (await mutate('lead_save', { customerId: customer.id, title: 'Sales project' }, ids.sales)).data.leads[0];
    const forgedEdit = plan(await read(), 'lead_save', { id: lead.id, customerId: customer.id, title: lead.title, status: 'NEGOTIATION' });
    await rejectsSql(() => commit({ ...forgedEdit, actor: ids.sales }), 'PT403');
    const forgedCreate = plan(await read(), 'lead_save', { customerId: customer.id, title: 'Forged new status', status: 'CONTACTED' });
    await rejectsSql(() => commit({ ...forgedCreate, actor: ids.sales }), 'PT403');
    await mutate('lead_status', { id: lead.id, status: 'CONTACTED' });
    const saved = await mutate('lead_save', { id: lead.id, customerId: customer.id, title: 'Updated details without changing stage', notes: 'Called customer' }, ids.sales);
    assert.equal(saved.data.leads[0].status, 'CONTACTED');
    assert.equal(saved.data.leads[0].notes, 'Called customer');
    assert.equal(saved.data.leads.length, 1);
  });

  test('SQL status guard preserves lost reasons, reopening rules and terminal Won status', async () => {
    await bootstrap();
    const customer = (await mutate('customer_save', { name: 'Transition client' })).data.customers[0];
    const lead = (await mutate('lead_save', { customerId: customer.id, title: 'Transition project' })).data.leads[0];
    const forgeStatus = async (status: string, lostReason = '') => {
      const before = await read(); const changes = emptyChanges(before);
      changes.upserts.leads = [{ ...before.leads[0], status, lostReason }];
      return commit({ actor: ids.owner, expectedRevision: before.revision, requestId: crypto.randomUUID(), action: 'lead_status', payloadHash: hash, changes, message: 'Forged transition' });
    };
    await rejectsSql(() => forgeStatus('LOST'), 'PT400');
    await mutate('lead_status', { id: lead.id, status: 'LOST', lostReason: 'Postponed' });
    await rejectsSql(() => forgeStatus('NEGOTIATION'), 'PT400');
    await rejectsSql(() => forgeStatus('WON'), 'PT400');
    await mutate('lead_status', { id: lead.id, status: 'NEW' });
    await forgeStatus('WON');
    await rejectsSql(() => forgeStatus('NEW'), 'PT400');
    assert.equal((await read()).leads[0].status, 'WON');
  });

  test('Admin and Manager can mark Won through lead status and save without accepting a quotation', async () => {
    await bootstrap();
    await addMember(ids.manager, 'manager', 'MANAGER');
    for (const actor of [ids.owner, ids.manager]) {
      const lead = (await mutate('lead_save', { title: `Manual Won ${actor}`, expectedKw: '5.5' }, actor)).data.leads.find(row => row.title === `Manual Won ${actor}`)!;
      const quote = (await mutate('quote_save', { leadId: lead.id, title: 'Unaccepted draft', validUntil: '2026-12-23', items: [] }, actor)).data.quotations.find(row => row.leadId === lead.id)!;
      const before = await read(actor);
      const statusResult = await mutate('lead_status', { id: lead.id, status: 'WON' }, actor);
      assert.equal(statusResult.data.leads.find(row => row.id === lead.id)?.status, 'WON');
      assert.equal(statusResult.data.leads.find(row => row.id === lead.id)?.expectedKw, 5.5);
      assert.deepEqual(statusResult.data.quotations, before.quotations);
      assert.deepEqual(statusResult.data.workorders, before.workorders);
      assert.equal(statusResult.data.quotations.find(row => row.id === quote.id)?.status, 'DRAFT');
      const saveLead = (await mutate('lead_save', { title: `Save Won ${actor}` }, actor)).data.leads.find(row => row.title === `Save Won ${actor}`)!;
      const saved = await mutate('lead_save', { id: saveLead.id, title: saveLead.title, status: 'WON' }, actor);
      assert.equal(saved.data.leads.find(row => row.id === saveLead.id)?.status, 'WON');
      const created = await mutate('lead_save', { title: `Created Won ${actor}`, status: 'WON' }, actor);
      assert.equal(created.data.leads.find(row => row.title === `Created Won ${actor}`)?.status, 'WON');
    }
  });

  test('SQL denies forged manual Won by other roles and by unrelated actions', async () => {
    await bootstrap();
    for (const [name, role] of [['sales', 'SALES'], ['operations', 'OPERATIONS'], ['accountant', 'ACCOUNTANT'], ['viewer', 'VIEWER']] as const) {
      await addMember(ids[name], name, role);
    }
    const lead = (await mutate('lead_save', { title: 'Protected manual Won' })).data.leads[0];
    const before = await read();
    for (const actor of [ids.sales, ids.operations, ids.accountant, ids.viewer]) {
      for (const action of ['lead_status', 'lead_save']) {
        const changes = emptyChanges(before);
        changes.upserts.leads = [{ ...lead, status: 'WON' }];
        await rejectsSql(() => commit({ actor, expectedRevision: before.revision, requestId: crypto.randomUUID(), action, payloadHash: hash, changes, message: 'Forged manual Won' }), 'PT403');
      }
      const created = plan(before, 'lead_save', { title: 'Forged created Won', status: 'WON' });
      await rejectsSql(() => commit({ ...created, actor }), 'PT403');
    }
    const unrelated = emptyChanges(before);
    unrelated.upserts.leads = [{ ...lead, status: 'WON' }];
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: before.revision, requestId: crypto.randomUUID(), action: 'quote_issue', payloadHash: hash, changes: unrelated, message: 'Wrong action for Won' }), 'PT400');
    assert.deepEqual(await read(), before);
  });

  test('manual Won SQL migration refuses unrecognized predecessor drift', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20261127065452_manual_lead_won.sql', import.meta.url), 'utf8');
    // The already-updated function is deliberately not the expected predecessor.
    // Execute only the guarded DO statement inside this test's savepoint.
    const guardedChange = migration.slice(migration.indexOf('do $migration$'), migration.indexOf('$migration$;') + '$migration$;'.length);
    await setRole('postgres');
    await rejectsSql(() => db.exec(guardedChange), '55000');
    await setRole('service_role');
  });

  test('a prepared Manager status change cannot be committed after downgrade to Sales', async () => {
    await bootstrap(); await addMember(ids.manager, 'manager', 'MANAGER');
    const customer = (await mutate('customer_save', { name: 'Downgrade client' })).data.customers[0];
    const lead = (await mutate('lead_save', { customerId: customer.id, title: 'Downgrade project' })).data.leads[0];
    const pending = plan(await read(ids.manager), 'lead_status', { id: lead.id, status: 'WON' });
    await mutate('member_role', { userId: ids.manager, role: 'SALES' });
    await rejectsSql(() => commit(pending), 'PT403');
    assert.equal((await read()).leads[0].status, 'NEW');
  });

  test('lead entry creates its customer atomically, persists decimal kW and retries only once', async () => {
    await bootstrap();
    await addMember(ids.sales, 'sales', 'SALES');
    const before = await read(ids.sales);
    const input = plan(before, 'lead_save', { title: 'Rooftop enquiry', contact: 'Actual contact', phone: '9876543210', expectedKw: '10.5', stateCode: '06' });
    const first = await commit(input);
    const retried = await commit(input);
    assert.equal(first.data.customers.length, 1);
    assert.equal(retried.data.customers.length, 1);
    assert.equal(retried.data.leads.length, 1);
    assert.equal(retried.data.revision, first.data.revision);
    const lead = (await read(ids.sales)).leads[0];
    const customer = first.data.customers[0];
    assert.equal(lead.expectedKw, 10.5);
    assert.equal(lead.customerId, customer.id);
    assert.equal(lead.email, '');
    assert.equal(customer.name, 'Actual contact');
    assert.equal(customer.contact, 'Actual contact');
    assert.equal(customer.phone, '9876543210');
    assert.equal(customer.email, '');
    assert.equal(customer.address, '');
    assert.equal(customer.gstin, '');
    const saved = await mutate('lead_save', { id: lead.id, title: lead.title, expectedKw: '12.75' }, ids.sales);
    assert.equal(saved.data.leads[0].expectedKw, 12.75);
    assert.equal(saved.data.leads[0].customerId, customer.id);
    assert.deepEqual(saved.data.customers[0], customer);
    const omitted = await mutate('lead_save', { id: lead.id, title: 'Updated project title' }, ids.sales);
    assert.equal(omitted.data.leads[0].expectedKw, 12.75);
    const cleared = await mutate('lead_save', { id: lead.id, title: lead.title, expectedKw: '' }, ids.sales);
    assert.equal(cleared.data.leads[0].expectedKw, null);
    assert.equal((await mutate('lead_save', { id: lead.id, title: lead.title, expectedKw: 0 }, ids.sales)).data.leads[0].expectedKw, 0);
  });

  test('historical leads retain linked customers and email when the replacement form omits them', async () => {
    await bootstrap();
    const customer = (await mutate('customer_save', { name: 'Existing client', email: 'historic-client@example.invalid' })).data.customers[0];
    const legacy = plan(await read(), 'lead_save', { customerId: customer.id, title: 'Historical lead', email: 'historic-lead@example.invalid' });
    const legacyRow = legacy.changes.upserts.leads[0] as Record<string, unknown>;
    delete legacyRow.expectedKw;
    const original = await commit(legacy);
    assert.equal(Object.hasOwn(original.data.leads[0], 'expectedKw'), false);
    const updated = await mutate('lead_save', { id: original.data.leads[0].id, title: 'Updated historical title', expectedKw: '5.25' });
    assert.equal(updated.data.leads[0].email, 'historic-lead@example.invalid');
    assert.equal(updated.data.leads[0].customerId, customer.id);
    assert.equal(updated.data.leads[0].expectedKw, 5.25);
    assert.deepEqual(updated.data.customers, original.data.customers);
  });

  test('SQL rejects forged expected kW types and values without leaving a customer, lead or receipt', async () => {
    await bootstrap();
    const before = await read();
    for (const expectedKw of [-0.1, '10.5', 'NaN', 'Infinity', true, [], {}]) {
      const input = plan(before, 'lead_save', { title: 'Capacity validation', expectedKw: '5.5' });
      (input.changes.upserts.leads[0] as Record<string, unknown>).expectedKw = expectedKw;
      await rejectsSql(() => commit(input), '23514');
      const after = await read();
      assert.equal(after.revision, before.revision);
      assert.equal(after.customers.length, 0);
      assert.equal(after.leads.length, 0);
      assert.deepEqual(after.activity, before.activity);
      const prepared = await query<{ receiptMessage: string | null }>('SELECT public.crm_mutation_prepare($1::uuid, $2::text, $3::text, $4::text) AS result', [ids.owner, input.requestId, 'lead_save', hash]);
      assert.equal(prepared.receiptMessage, null);
    }
    const saved = await mutate('lead_save', { title: 'Finite capacity', expectedKw: 0 });
    await setRole('postgres');
    await rejectsSql(() => db.query("UPDATE crm.leads SET payload=jsonb_set(payload,'{expectedKw}','1e309'::jsonb) WHERE id=$1", [saved.data.leads[0].id]), '23514');
    await setRole('service_role');
    assert.equal((await read()).leads[0].expectedKw, 0);
  });

  test('lead_save cannot overwrite customers or create unrelated and fabricated customer records', async () => {
    await bootstrap();
    const original = (await mutate('customer_save', { name: 'Protected existing client', phone: '1234567890' })).data.customers[0];
    const before = await read();
    const overwrite = plan(before, 'lead_save', { customerId: original.id, title: 'Existing customer enquiry' });
    overwrite.changes.upserts.customers = [{ ...original, name: 'Overwritten name' }];
    await rejectsSql(() => commit(overwrite), 'PT403');
    for (const field of ['name', 'contact', 'phone', 'email', 'address', 'gstin', 'stateCode']) {
      const input = plan(before, 'lead_save', { title: 'New enquiry', contact: 'Actual contact', phone: '9876543210', stateCode: '06' });
      (input.changes.upserts.customers[0] as Record<string, unknown>)[field] = 'Fabricated value';
      await rejectsSql(() => commit(input), 'PT400');
    }
    const unrelated = plan(before, 'lead_save', { title: 'One new enquiry' });
    unrelated.changes.upserts.customers.push({ ...(unrelated.changes.upserts.customers[0] as object), id: crypto.randomUUID() });
    await rejectsSql(() => commit(unrelated), 'PT400');
    const noLead = plan(before, 'lead_save', { title: 'No linked enquiry' });
    noLead.changes.upserts.leads = [];
    await rejectsSql(() => commit(noLead), 'PT400');
    const saved = await mutate('lead_save', { customerId: original.id, title: 'Existing lead' });
    const reassignment = plan(saved.data, 'lead_save', { title: 'Replacement customer' });
    (reassignment.changes.upserts.leads[0] as Record<string, unknown>).id = saved.data.leads[0].id;
    await rejectsSql(() => commit(reassignment), 'PT400');
    const after = await read();
    assert.deepEqual(after.customers, [original]);
    assert.equal(after.leads.length, 1);
    assert.equal(after.leads[0].customerId, original.id);
  });

  test('automatic customer creation obeys current lead roles and SQL status guards', async () => {
    await bootstrap();
    await addMember(ids.manager, 'manager', 'MANAGER');
    await addMember(ids.sales, 'sales', 'SALES');
    await addMember(ids.operations, 'operations', 'OPERATIONS');
    await addMember(ids.accountant, 'accountant', 'ACCOUNTANT');
    await addMember(ids.viewer, 'viewer', 'VIEWER');
    const before = await read();
    for (const actor of [ids.operations, ids.accountant, ids.viewer]) {
      const input = plan(before, 'lead_save', { title: 'Unauthorized enquiry', expectedKw: '4.5' });
      await rejectsSql(() => commit({ ...input, actor }), 'PT403');
    }
    const forged = plan(before, 'lead_save', { title: 'Forged Sales stage', status: 'CONTACTED' });
    await rejectsSql(() => commit({ ...forged, actor: ids.sales }), 'PT403');
    assert.equal((await read()).customers.length, 0);
    const manager = await mutate('lead_save', { title: 'Manager enquiry', status: 'CONTACTED', expectedKw: 2.5 }, ids.manager);
    assert.equal(manager.data.leads[0].status, 'CONTACTED');
    assert.equal(manager.data.customers[0].name, 'Manager enquiry');
  });

  test('a lead with an automatic customer supports quotation issue, acceptance and work-order snapshots', async () => {
    await bootstrap();
    const { company } = await read();
    await mutate('company_save', { name: company.name, legalName: 'Test contractor', address: 'Supplier address', gstin: '06ABCDE1234F1Z5', stateCode: '06', phone: '', email: '', website: '', terms: company.terms });
    const created = await mutate('lead_save', { title: 'Solar installation', contact: 'Project contact', phone: '9876543210', expectedKw: '10.5', stateCode: '06', siteAddress: 'Actual site address' });
    const lead = created.data.leads[0];
    const customer = created.data.customers[0];
    await mutate('customer_save', { id: customer.id, name: customer.name, contact: customer.contact, phone: customer.phone, email: customer.email, stateCode: customer.stateCode, address: 'Confirmed billing address' });
    const quote = (await mutate('quote_save', {
      leadId: lead.id, title: 'System quotation', validUntil: '2026-12-23', placeOfSupply: '06', siteAddress: lead.siteAddress, terms: 'Agreed terms',
      items: [{ id: 'capacity-item', description: 'Solar installation', hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '10000', discount: '0', gstRate: '18' }],
    })).data.quotations[0];
    const issued = (await mutate('quote_issue', { id: quote.id })).data.quotations[0];
    assert.equal(issued.customer?.id, customer.id);
    assert.equal(issued.customer?.phone, '9876543210');
    assert.equal(issued.customer?.email, '');
    await mutate('quote_accept', { id: quote.id, acceptanceNote: 'Written customer acceptance' });
    const converted = await mutate('quote_convert', { id: quote.id });
    const snapshot = structuredClone(converted.data.workorders[0].snapshot);
    assert.equal(converted.data.leads[0].status, 'WON');
    assert.equal(converted.data.leads[0].expectedKw, 10.5);
    const updated = await mutate('lead_save', { id: lead.id, title: lead.title, expectedKw: '11.25' });
    assert.equal(updated.data.leads[0].expectedKw, 11.25);
    assert.equal(updated.data.leads[0].customerId, customer.id);
    assert.deepEqual(updated.data.workorders[0].snapshot, snapshot);
    assert.deepEqual(updated.data.quotations[0], snapshot);
  });

  test('a receipt cannot be reused for a different payload, action, or actor', async () => {
    await bootstrap();
    await addMember(ids.manager, 'manager', 'MANAGER');
    const input = plan(await read(), 'customer_save', { name: 'Synthetic receipt client' });
    await commit(input);
    await rejectsSql(() => commit({ ...input, payloadHash: 'b'.repeat(64) }), 'PT409');
    await rejectsSql(() => commit({ ...input, action: 'lead_save' }), 'PT409');
    await rejectsSql(() => commit({ ...input, actor: ids.manager }), 'PT409');
    assert.equal((await read()).customers.length, 1);
  });

  test('stale revisions cannot overwrite a newer device or leave partial records', async () => {
    await bootstrap();
    const before = await read();
    const first = plan(before, 'customer_save', { name: 'First device' });
    const stale = plan(before, 'customer_save', { name: 'Stale device' });
    await commit(first);
    await rejectsSql(() => commit(stale), 'PT409');
    const data = await read();
    assert.equal(data.revision, before.revision + 1);
    assert.deepEqual(data.customers.map(customer => customer.name), ['First device']);
    assert.equal(data.activity.filter(event => event.action === 'customer_save').length, 1);
  });

  test('a role change is rechecked at commit, including when a stale server prepared the write', async () => {
    await bootstrap();
    await addMember(ids.sales, 'sales', 'SALES');
    const pending = plan(await read(ids.sales), 'customer_save', { name: 'Stale sales change' });
    await mutate('member_role', { userId: ids.sales, role: 'VIEWER' });
    await rejectsSql(() => commit(pending), ['PT403', 'PT409']);
    const data = await read();
    assert.equal(data.customers.length, 0);
    assert.equal(data.members.find(member => member.userId === ids.sales)?.role, 'VIEWER');
  });

  test('inactive and banned members cannot read, write, replay receipts, or receive recovery links', async () => {
    await bootstrap();
    await addMember(ids.sales, 'sales', 'SALES');
    const completed = plan(await read(ids.sales), 'customer_save', { name: 'Before disable' });
    await commit(completed);
    await mutate('member_active', { userId: ids.sales, active: false });
    await rejectsSql(() => read(ids.sales), 'PT403');
    await rejectsSql(() => commit(completed), 'PT403');
    await rejectsSql(() => query('SELECT public.crm_authorize_member_link($1::uuid, $2::uuid) AS result', [ids.owner, ids.sales]), ['PT403', 'PT404']);
    await setRole('postgres');
    await db.query("UPDATE auth.users SET banned_until = now() + interval '1 day' WHERE id = $1", [ids.owner]);
    await setRole('service_role');
    await rejectsSql(() => read(), 'PT403');
  });

  test('SQL membership controls reject self-disable even if application validation is bypassed', async () => {
    await bootstrap();
    const before = await read();
    const changes = emptyChanges(before);
    changes.members = [{ userId: ids.owner, role: 'OWNER', active: false }];
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: before.revision, requestId: crypto.randomUUID(), action: 'member_active', payloadHash: hash, changes, message: 'Synthetic invalid disable' }), ['PT400', 'PT403', 'PT409']);
    const after = await read();
    assert.equal(after.user.active, true);
    assert.equal(after.revision, before.revision);
  });

  test('failed foreign-key writes roll back revision, audit, receipt, and entity together', async () => {
    await bootstrap();
    const before = await read();
    const changes = emptyChanges(before);
    changes.upserts.leads = [{
      id: 'invalid-parent-lead', customerId: 'absent-customer', title: 'Synthetic invalid lead',
      contact: '', phone: '', email: '', location: '', siteAddress: '', stateCode: '', value: 0,
      status: 'NEW', source: '', owner: '', priority: 'Medium', notes: '', lostReason: '', isDemo: false,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }];
    const requestId = crypto.randomUUID();
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: before.revision, requestId, action: 'lead_save', payloadHash: hash, changes, message: 'Synthetic invalid parent' }), ['23503', 'PT400']);
    const after = await read();
    assert.equal(after.revision, before.revision);
    assert.equal(after.leads.length, 0);
    assert.deepEqual(after.activity, before.activity);
    const prepared = await query<{ receiptMessage: string | null }>('SELECT public.crm_mutation_prepare($1::uuid, $2::text, $3::text, $4::text) AS result', [ids.owner, requestId, 'lead_save', hash]);
    assert.equal(prepared.receiptMessage, null);
  });

  test('example loading and clearing preserve real records and permanent audit history', async () => {
    await bootstrap();
    const saved = await mutate('customer_save', { name: 'Real workspace record' });
    const realId = saved.data.customers[0].id;
    const loaded = await mutate('load_demo', {});
    assert.ok(loaded.data.customers.some(customer => customer.isDemo));
    assert.ok(loaded.data.quotations.length > 0);
    assert.ok(loaded.data.workorders.length > 0);
    const cleared = await mutate('clear_demo', {});
    assert.deepEqual(cleared.data.customers.map(customer => customer.id), [realId]);
    assert.equal(cleared.data.leads.length, 0);
    assert.equal(cleared.data.followups.length, 0);
    assert.equal(cleared.data.quotations.length, 0);
    assert.equal(cleared.data.workorders.length, 0);
    assert.ok(cleared.data.activity.some(event => event.action === 'customer_save'));
    assert.ok(cleared.data.activity.some(event => event.action === 'clear_demo'));
    assert.equal(cleared.data.activity.some(event => event.id.startsWith('demo_')), false);
  });

  test('valid business workflow persists an accepted quotation and a single work order', async () => {
    await bootstrap();
    const { company } = await read();
    await mutate('company_save', {
      name: company.name, legalName: 'Synthetic test contractor', address: 'Synthetic supplier address',
      gstin: '06ABCDE1234F1Z5', stateCode: '06', phone: '', email: '', website: '', terms: company.terms,
    });
    const customerResult = await mutate('customer_save', { name: 'Synthetic client', address: 'Synthetic billing address', stateCode: '06' });
    const customerId = customerResult.data.customers[0].id;
    const leadResult = await mutate('lead_save', { customerId, title: 'Synthetic renovation', siteAddress: 'Synthetic work site', stateCode: '06', value: '10000' });
    const leadId = leadResult.data.leads[0].id;
    const quoteResult = await mutate('quote_save', {
      leadId, title: 'Synthetic quotation', validUntil: '2026-12-23', placeOfSupply: '06', siteAddress: 'Synthetic work site', terms: 'Synthetic agreed terms',
      items: [{ id: 'synthetic-item', description: 'Synthetic construction service', hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '10000', discount: '0', gstRate: '18' }],
    });
    const quoteId = quoteResult.data.quotations[0].id;
    const issuedResult = await mutate('quote_issue', { id: quoteId });
    const issued = issuedResult.data.quotations.find(quote => quote.id === quoteId)!;
    const mislabelled = emptyChanges(issuedResult.data);
    mislabelled.upserts.quotations = [{ ...issued, status: 'ACCEPTED', acceptedAt: NOW.toISOString(), acceptanceNote: 'Synthetic mislabelled approval' }];
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: issuedResult.data.revision, requestId: crypto.randomUUID(), action: 'quote_revise', payloadHash: hash, changes: mislabelled, message: 'Synthetic approval under wrong action' }), 'PT403');
    await mutate('quote_accept', { id: quoteId, acceptanceNote: 'Synthetic written acceptance' });
    const initial = await read();
    const accepted = initial.quotations.find(quote => quote.id === quoteId)!;
    assert.equal(accepted.status, 'ACCEPTED');
    const input = plan(initial, 'quote_convert', { id: accepted.id });
    const first = await commit(input);
    const retry = await commit(input);
    assert.equal(first.data.workorders.filter(order => order.quoteId === accepted.id).length, 1);
    assert.equal(retry.data.workorders.filter(order => order.quoteId === accepted.id).length, 1);
    const order = first.data.workorders.find(item => item.quoteId === accepted.id)!;
    assert.deepEqual(order.snapshot, accepted);
    assert.equal(order.snapshot.totals.total, accepted.totals.total);
    assert.equal(order.snapshot.totals.total, 1_180_000);

    const duplicateChanges = emptyChanges(first.data);
    duplicateChanges.upserts.workorders = [{ ...order, id: crypto.randomUUID(), number: `${order.number}-duplicate` }];
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: first.data.revision, requestId: crypto.randomUUID(), action: 'quote_convert', payloadHash: hash, changes: duplicateChanges, message: 'Synthetic duplicate work order' }), ['23505', 'PT400']);

    const tamperChanges = emptyChanges(first.data);
    tamperChanges.upserts.quotations = [{ ...accepted, title: 'Changed issued scope' }];
    await rejectsSql(() => commit({ actor: ids.owner, expectedRevision: first.data.revision, requestId: crypto.randomUUID(), action: 'quote_save', payloadHash: hash, changes: tamperChanges, message: 'Synthetic tampered quote' }), 'PT400');

    const final = await read();
    assert.equal(final.revision, first.data.revision);
    assert.equal(final.workorders.length, 1);
    assert.deepEqual(final.quotations.find(quote => quote.id === quoteId), accepted);
  });
});
