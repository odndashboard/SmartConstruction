import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Customer, Lead, Quotation, WorkOrder } from '../lib/types.ts';

// Build actual historical rows under the old schema, then execute the release
// migration. Fixtures deliberately do not use today's automatic-work-order code.
const predecessors = ['202611230001_crm.sql', '20261123173951_operations.sql', '20261123182424_operations_extensions.sql',
  '20261124072200_accountant_and_lead_status.sql', '20261127062903_lead_expected_kw.sql', '20261127065452_manual_lead_won.sql'];
const migrationUrl = new URL('../supabase/migrations/20261127072310_won_lead_workorders.sql', import.meta.url);
const owner = '70000000-0000-4000-8000-000000000001';
const accountant = '70000000-0000-4000-8000-000000000002';
const inactive = '70000000-0000-4000-8000-000000000003';
const stamp = '2026-11-24T08:00:00.000Z';
let db: PGlite;
let migration: string;
let sequenceKey: string;
type State = {
  revision: number; company: unknown; sequences: Record<string, number>;
  customers: Customer[]; leads: Lead[]; quotations: Quotation[]; workorders: WorkOrder[];
  members: unknown[]; audit: { id: string; [key: string]: unknown }[]; receipts: unknown[];
};
let original: State;
let upgraded: State;

async function state(): Promise<State> {
  return (await db.query<{ result: State }>(`select jsonb_build_object(
    'revision',(select revision from crm.workspace),'company',(select company from crm.workspace),
    'sequences',(select sequences from crm.workspace),
    'customers',(select coalesce(jsonb_agg(payload order by id),'[]') from crm.customers),
    'leads',(select coalesce(jsonb_agg(payload order by id),'[]') from crm.leads),
    'quotations',(select coalesce(jsonb_agg(payload order by id),'[]') from crm.quotations),
    'workorders',(select coalesce(jsonb_agg(payload order by id),'[]') from crm.workorders),
    'members',(select coalesce(jsonb_agg(to_jsonb(m) order by user_id),'[]') from crm.members m),
    'audit',(select coalesce(jsonb_agg(payload order by id),'[]') from crm.audit_events),
    'receipts',(select coalesce(jsonb_agg(to_jsonb(r) order by request_id),'[]') from crm.mutation_receipts r)
  ) as result`)).rows[0].result;
}

async function insertLead(id: string, status: Lead['status'], expectedKw: number | null, isDemo = false) {
  const customer: Customer = { id: `customer-${id}`, name: `Synthetic ${id} customer`, contact: 'Site contact', phone: '9000000000',
    email: 'historical@example.invalid', address: 'Synthetic billing address', stateCode: '06', gstin: '', isDemo, createdAt: stamp };
  const lead: Lead = { id, customerId: customer.id, title: `Synthetic ${id} rooftop project`, contact: customer.contact, phone: customer.phone,
    email: customer.email, expectedKw, location: 'Hisar', siteAddress: 'Synthetic rooftop site', stateCode: '06', value: 7654321, status,
    source: 'Referral', owner, priority: 'High', notes: 'Retain these original project notes.', lostReason: status === 'LOST' ? 'Earlier postponement' : '',
    isDemo, createdAt: stamp, updatedAt: stamp };
  await db.query('insert into crm.customers(id,payload) values($1,$2::jsonb)', [customer.id, JSON.stringify(customer)]);
  await db.query('insert into crm.leads(id,payload) values($1,$2::jsonb)', [lead.id, JSON.stringify(lead)]);
  return { customer, lead };
}

async function insertQuote(id: string, lead: Lead, customer: Customer, acceptedAt?: string) {
  const draft: Quotation = { id, leadId: lead.id, number: null, title: `Approved scope ${id}`, validUntil: '2030-12-31', placeOfSupply: '06',
    siteAddress: `Quoted site ${id}`, terms: `Preserve commercial terms ${id}`, items: [{ id: `item-${id}`, description: `Solar work ${id}`,
      hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '1000.00', discount: '0.00', gstRate: '18',
      gross: 100000, taxable: 100000, cgst: 9000, sgst: 9000, utgst: 0, igst: 0, total: 118000 }],
    totals: { subtotal: 100000, discount: 0, taxable: 100000, cgst: 9000, sgst: 9000, utgst: 0, igst: 0, total: 118000, mode: 'CGST_SGST', needsConfig: false },
    status: 'DRAFT', revision: 1, acceptanceNote: '', isDemo: lead.isDemo, createdAt: stamp, updatedAt: stamp };
  await db.query('insert into crm.quotations(id,payload) values($1,$2::jsonb)', [id, JSON.stringify(draft)]);
  await db.query("select set_config('crm.action','quote_issue',true)");
  const issued: Quotation = { ...draft, number: `SC/Q/2026-27/${id}`, status: 'ISSUED', issuedAt: stamp, customer: structuredClone(customer) };
  await db.query('update crm.quotations set payload=$2::jsonb where id=$1', [id, JSON.stringify(issued)]);
  if (!acceptedAt) return issued;
  await db.query("select set_config('crm.action','quote_accept',true)");
  const accepted: Quotation = { ...issued, status: 'ACCEPTED', acceptedAt, acceptanceNote: `Original approval ${id}`, updatedAt: acceptedAt };
  await db.query('update crm.quotations set payload=$2::jsonb where id=$1', [id, JSON.stringify(accepted)]);
  return accepted;
}

describe('historical Won and accepted-quotation work-order upgrade', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,
        raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'; $$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const file of predecessors) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    await db.exec('begin');
    for (const [id, name, role, active] of [[owner, 'Owner', 'OWNER', true], [accountant, 'Accountant', 'ACCOUNTANT', true], [inactive, 'Former employee', 'SALES', false]] as const) {
      await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)', [id, `${role.toLowerCase()}@example.invalid`, stamp]);
      await db.query('insert into crm.members(user_id,name,email,role,active) values($1,$2,$3,$4,$5)', [id, name, `${role.toLowerCase()}@example.invalid`, role, active]);
    }
    sequenceKey = (await db.query<{ key: string }>(`select 'WO/'||y::text||'-'||right((y+1)::text,2) as key from
      (select extract(year from current_timestamp at time zone 'Asia/Kolkata')::int - case when extract(month from current_timestamp at time zone 'Asia/Kolkata')<4 then 1 else 0 end y) d`)).rows[0].key;
    await db.query('update crm.workspace set revision=41,sequences=$1::jsonb', [JSON.stringify({ [sequenceKey]: 2, 'Q/2026-27': 19 })]);

    const manual = await insertLead('manual-won', 'WON', 40.5);
    await insertQuote('manual-issued', manual.lead, manual.customer);
    const legacy = await insertLead('legacy-won', 'WON', 0);
    const first = await insertQuote('legacy-first', legacy.lead, legacy.customer, '2026-11-24T09:00:00.000Z');
    await insertQuote('legacy-second', legacy.lead, legacy.customer, '2026-11-25T09:00:00.000Z');
    const legacyOrder: WorkOrder = { id: 'legacy-order', quoteId: first.id, number: `SC/${sequenceKey}/000007`, title: first.title,
      customerName: legacy.customer.name, siteAddress: first.siteAddress, owner: accountant, startDate: '2026-11-25', endDate: '2026-12-20',
      status: 'ACTIVE', snapshot: structuredClone(first), milestones: [{ id: 'legacy-milestone', title: 'Original delivery checkpoint', dueDate: '2026-12-01', status: 'PENDING' }],
      isDemo: false, createdAt: stamp, updatedAt: stamp };
    await db.query("select set_config('crm.action','quote_convert',true)");
    await db.query('insert into crm.workorders(id,payload) values($1,$2::jsonb)', [legacyOrder.id, JSON.stringify(legacyOrder)]);

    const unreconciled = await insertLead('accepted-lost', 'LOST', 8.75);
    await insertQuote('unconverted-first', unreconciled.lead, unreconciled.customer, '2026-11-24T10:00:00.000Z');
    await insertQuote('unconverted-second', unreconciled.lead, unreconciled.customer, '2026-11-26T10:00:00.000Z');
    const open = await insertLead('open-unaccepted', 'CONTACTED', 5.25);
    await insertQuote('open-issued', open.lead, open.customer);
    await insertLead('demo-won', 'WON', 25, true);
    await db.query("insert into crm.audit_events(id,actor_id,payload) values('historical-audit',$1,$2::jsonb)", [owner,
      JSON.stringify({ id: 'historical-audit', actor: 'Owner', action: 'lead_save', entityType: 'lead', entityId: manual.lead.id, description: 'Historical record', createdAt: stamp })]);
    await db.query("insert into crm.mutation_receipts(request_id,actor_id,action,payload_hash,revision,message) values('historical-request',$1,'lead_save',$2,41,'Historical saved lead')", [owner, 'a'.repeat(64)]);
    await db.exec('commit');
    original = await state();
    migration = await readFile(migrationUrl, 'utf8');
    await db.exec(migration);
    upgraded = await state();
  });
  after(async () => { await db?.close(); });

  test('existing Won lead with only an unaccepted quotation gets honest unpriced planned work', () => {
    const source = original.leads.find(row => row.id === 'manual-won')!;
    const orders = upgraded.workorders.filter(row => row.leadId === source.id);
    assert.equal(orders.length, 1);
    const order = orders[0];
    assert.equal(order.status, 'PLANNED');
    assert.equal(order.quoteId, null);
    assert.equal(order.snapshot, null);
    assert.equal(order.expectedKw, 40.5);
    assert.equal(order.title, source.title);
    assert.equal(order.siteAddress, source.siteAddress);
    assert.equal(order.owner, source.owner);
    assert.equal(order.customerName, original.customers.find(row => row.id === source.customerId)!.name);
    assert.equal(order.startDate, ''); assert.equal(order.endDate, ''); assert.deepEqual(order.milestones, []);
    assert.equal(order.automaticForLead, true);
    assert.equal(upgraded.quotations.find(row => row.id === 'manual-issued')!.status, 'ISSUED');
  });

  test('each historical accepted quotation has its own order while legacy delivery data is untouched', () => {
    const legacy = original.workorders.find(row => row.id === 'legacy-order')!;
    assert.deepEqual(upgraded.workorders.find(row => row.id === legacy.id), legacy);
    const accepted = original.quotations.filter(row => row.status === 'ACCEPTED');
    for (const quote of accepted) {
      const orders = upgraded.workorders.filter(row => row.quoteId === quote.id);
      assert.equal(orders.length, 1, `${quote.id} must have exactly one linked order`);
      assert.deepEqual(orders[0].snapshot, quote);
      assert.equal(orders[0].leadId || orders[0].snapshot?.leadId, quote.leadId);
      if (orders[0].id !== legacy.id) assert.equal(orders[0].status, 'PLANNED');
    }
    assert.equal(upgraded.workorders.length, accepted.length + 1);
    assert.equal(new Set(upgraded.workorders.map(row => row.number)).size, upgraded.workorders.length);
    assert.equal(upgraded.sequences[sequenceKey], 11, 'allocate after the actual historical number, even if the saved counter is behind');
  });

  test('upgrade preserves original business records and roles, changing only necessary accepted-lead status', () => {
    for (const key of ['company', 'customers', 'quotations', 'members', 'receipts'] as const) assert.deepEqual(upgraded[key], original[key], key);
    assert.equal(upgraded.leads.length, original.leads.length);
    for (const lead of original.leads) {
      const saved = upgraded.leads.find(row => row.id === lead.id)!;
      if (lead.id === 'accepted-lost') {
        assert.equal(saved.status, 'WON'); assert.equal(saved.lostReason, '');
        assert.deepEqual({ ...saved, status: lead.status, lostReason: lead.lostReason, updatedAt: lead.updatedAt }, lead);
      } else assert.deepEqual(saved, lead);
    }
    assert.equal(upgraded.workorders.some(row => row.leadId === 'open-unaccepted' || row.leadId === 'demo-won'), false);
    assert.deepEqual(upgraded.audit.find(row => row.id === 'historical-audit'), original.audit[0]);
    assert.ok(upgraded.audit.length > original.audit.length);
    assert.equal(upgraded.revision, original.revision + 1);
    assert.equal(upgraded.sequences['Q/2026-27'], original.sequences['Q/2026-27']);
  });

  test('repeating the migration backfill work adds no duplicate orders, numbers or audit events', async () => {
    const block = migration.match(/do \$backfill\$[\s\S]*?\$backfill\$;/)?.[0];
    assert.ok(block, 'the migration backfill must remain directly testable');
    await db.exec(`begin; ${block} commit;`);
    assert.deepEqual(await state(), upgraded);
  });
});
