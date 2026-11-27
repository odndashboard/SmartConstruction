import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { todayIST } from '../lib/finance.ts';
import type { Quotation, WorkspaceData } from '../lib/types.ts';
import type { OperationsData } from '../lib/operations-types.ts';
import { completeQuoteItems } from './fixtures/quotation-items.ts';

const migration = '20261127125931_package_quotation_pricing.sql';
const owner = '78000000-0000-4000-8000-000000000001'; const sales = '78000000-0000-4000-8000-000000000002';
const hash = 'a'.repeat(64); const future = todayIST(new Date(Date.now() + 30 * 86400000)); const month = todayIST().slice(0, 7);
let db: PGlite; let leadId: string; let legacyDraftId: string; let baseline: WorkspaceData;
async function query<T>(sql: string, values: unknown[] = []): Promise<T> { return (await db.query<{ result: T }>(sql, values)).rows[0]?.result as T; }
async function read(actor = owner): Promise<WorkspaceData> { return query('select public.crm_workspace_read($1::uuid,false) result', [actor]); }
async function rejects(run: () => Promise<unknown>, codes: string | string[] = ['PT400', '23514']) {
  await db.exec('savepoint expected_failure');
  try { await assert.rejects(run, (error: unknown) => { const value = error as { code: string; message: string }; assert.ok((Array.isArray(codes) ? codes : [codes]).includes(value.code), `${value.code}: ${value.message}`); return true; }); }
  finally { await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure'); }
}
function plan(before: WorkspaceData, action: string, payload: unknown) {
  const after = structuredClone(before); const message = applyAction(after, action, payload); const upserts: Record<string, unknown[]> = {}; const deleted: Record<string, string[]> = {};
  for (const key of ['customers', 'leads', 'followups', 'quotations', 'workorders'] as const) {
    const previous = new Map(before[key].map(row => [row.id, JSON.stringify(row)])); upserts[key] = after[key].filter(row => previous.get(row.id) !== JSON.stringify(row)); deleted[key] = [];
  }
  const events = new Set(before.activity.map(row => row.id));
  return { actor: before.user.userId, revision: before.revision, requestId: crypto.randomUUID(), action, message,
    changes: { company: after.company, sequences: after.sequences, upserts, deleted, members: [], audit: after.activity.filter(row => !events.has(row.id)), clearDemoAudit: false } };
}
async function commit(r: ReturnType<typeof plan>) {
  return query<{ data: WorkspaceData }>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result', [r.actor, r.revision, r.requestId, r.action, hash, JSON.stringify(r.changes), r.message]);
}
async function act(action: string, payload: unknown, actor = owner) { return commit(plan(await read(actor), action, payload)); }
function rows() {
  const result = completeQuoteItems([{ id: crypto.randomUUID(), description: 'Actual panel specification', warranty: '25 years performance warranty', quantity: '2.125', unit: 'pcs', unitPrice: '0', hsnSac: '', discount: '0', gstRate: '0' }]);
  result[1] = { ...result[1], warranty: '' }; return result;
}
function input(overrides: Record<string, unknown> = {}) {
  return { leadId, title: crypto.randomUUID(), validUntil: future, placeOfSupply: '06', siteAddress: 'Actual installation address',
    gstEnabled: false, packagePrice: '12345.67', packageGstRate: '0', items: rows(), ...overrides };
}
async function save(overrides: Record<string, unknown> = {}, actor = owner) {
  const payload = input(overrides); const result = await act('quote_save', payload, actor);
  return result.data.quotations.find(row => row.title === payload.title)!;
}
async function company(stateCode: string) {
  return act('company_save', { name: 'Actual contractor', legalName: 'Actual contractor', address: 'Actual supplier address', stateCode,
    gstin: stateCode ? `${stateCode}ABCDE1234F1Z5` : '' });
}
function edit(quote: Quotation, overrides: Record<string, unknown> = {}) {
  return { id: quote.id, leadId: quote.leadId, title: quote.title, validUntil: quote.validUntil, placeOfSupply: quote.placeOfSupply,
    siteAddress: quote.siteAddress, gstEnabled: quote.gstEnabled, packagePrice: quote.packagePrice, packageGstRate: quote.packageGstRate,
    items: quote.items.map(({ id, category, warranty, description, quantity, unit, unitPrice, discount, gstRate, hsnSac }) => ({ id, category, warranty, description, quantity, unit, unitPrice, discount, gstRate, hsnSac })), ...overrides };
}

describe('one package price and item warranties in PostgreSQL', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite();
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'$$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for (const file of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(file => file.endsWith('.sql') && file < migration).sort()) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    for (const [id, name] of [[owner, 'Owner'], [sales, 'Sales']]) await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)', [id, `${name}@example.invalid`, JSON.stringify({ name })]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result', [owner]);
    await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result', [owner, sales, 'Sales', 'Sales@example.invalid', 'SALES']);
    await company('06');
    leadId = (await act('lead_save', { title: 'Actual project', siteAddress: 'Actual installation address' })).data.leads[0].id;
    const customer = (await read()).customers[0]; await act('customer_save', { id: customer.id, name: customer.name, address: 'Actual billing address', stateCode: '06' });
    const legacy = await save({ title: 'Historical itemized quote', packagePrice: undefined, packageGstRate: undefined, gstEnabled: true,
      items: completeQuoteItems([{ id: 'historical-scope', description: 'Historical scope', quantity: '1', unit: 'job', unitPrice: '100', discount: '0', gstRate: '18', hsnSac: '' }]) });
    await act('quote_issue', { id: legacy.id }); await act('quote_accept', { id: legacy.id, acceptanceNote: 'Historical genuine acceptance' });
    legacyDraftId = (await save({ title: 'Historical editable draft', packagePrice: undefined, packageGstRate: undefined,
      items: completeQuoteItems([{ id: 'legacy-draft', description: 'Legacy draft scope', quantity: '1', unit: 'job', unitPrice: '50', discount: '0', gstRate: '0', hsnSac: '' }]) })).id;
    baseline = await read();
    await db.exec((await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')).replace(/\r?\n/g, '\r\n'));
  });
  beforeEach(async () => { await db.exec('begin'); }); afterEach(async () => { await db.exec('rollback'); }); after(async () => { await db.close(); });

  test('upgrade preserves legacy money and accepted snapshots; new package stores one total and actual optional warranties', async () => {
    assert.deepEqual(await read(), baseline);
    const quote = await save({}, sales);
    assert.equal(quote.packagePrice, '12345.67'); assert.equal(quote.items.length, 9); assert.equal(quote.totals.total, 1234567);
    assert.equal(quote.totals.mode, 'NO_GST'); assert.equal(quote.items[0].warranty, '25 years performance warranty'); assert.equal(quote.items[1].warranty, '');
    assert.equal(quote.items[2].warranty, undefined);
    for (const item of quote.items) for (const key of ['gross', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'total'] as const) assert.equal(item[key], 0);
    assert.equal((await save({ packagePrice: '0' })).totals.total, 0);
    assert.equal((await save({ packagePrice: '90000000000' })).totals.total, 9000000000000);
  });

  test('GST modes and half-up component rounding exactly match the single package calculation', async () => {
    for (const example of [
      { supplier: '06', place: '06', mode: 'CGST_SGST', total: 7, cgst: 1, sgst: 1, utgst: 0, igst: 0 },
      { supplier: '06', place: '07', mode: 'IGST', total: 6, cgst: 0, sgst: 0, utgst: 0, igst: 1 },
      { supplier: '04', place: '04', mode: 'CGST_UTGST', total: 7, cgst: 1, sgst: 0, utgst: 1, igst: 0 },
    ]) {
      await company(example.supplier);
      const quote = await save({ packagePrice: '0.05', packageGstRate: '20', gstEnabled: true, placeOfSupply: example.place });
      assert.deepEqual(quote.totals, { subtotal: 5, discount: 0, taxable: 5, cgst: example.cgst, sgst: example.sgst, utgst: example.utgst, igst: example.igst,
        total: example.total, mode: example.mode, needsConfig: false });
    }
  });

  test('unconfigured taxable drafts recalculate on settings changes without losing package price, scope or warranties', async () => {
    await company(''); const draft = await save({ gstEnabled: true, packageGstRate: '18' });
    assert.equal(draft.totals.mode, 'UNCONFIGURED'); assert.equal(draft.totals.needsConfig, true); assert.equal(draft.totals.total, 1234567);
    const next = await company('07'); const configured = next.data.quotations.find(row => row.id === draft.id)!;
    assert.equal(configured.totals.mode, 'IGST'); assert.equal(configured.totals.total, 1456789);
    assert.equal(configured.packagePrice, draft.packagePrice); assert.equal(configured.packageGstRate, draft.packageGstRate); assert.deepEqual(configured.items, draft.items);
    await act('quote_issue', { id: draft.id });
    const issued = (await read()).quotations.find(row => row.id === draft.id)!;
    await company('04'); assert.deepEqual((await read()).quotations.find(row => row.id === issued.id), issued);
    await act('quote_accept', { id: issued.id, acceptanceNote: 'Accepted after company state changed' });
  });

  test('issue, acceptance, work-order snapshot and payments retain the package amount and warranties', async () => {
    const draft = await save({ packagePrice: '1000' }); const issued = (await act('quote_issue', { id: draft.id })).data.quotations.find(row => row.id === draft.id)!;
    await rejects(async () => commit({ ...plan(await read(), 'quote_accept', { id: issued.id, acceptanceNote: 'Recorded' }), actor: sales }), 'PT403');
    const accepted = (await act('quote_accept', { id: draft.id, acceptanceNote: 'Actual customer acceptance' })).data;
    const quote = accepted.quotations.find(row => row.id === draft.id)!; const work = accepted.workorders.find(row => row.quoteId === draft.id)!;
    assert.equal(quote.totals.total, 100000); assert.deepEqual(work.snapshot, quote); assert.equal(work.snapshot?.items[0].warranty, draft.items[0].warranty);
    assert.equal(await query('select crm.contract_amount($1,true)::text result', [work.id]), '100000');
    const operations = await query<OperationsData>('select public.crm_operations_v2_read($1::uuid,$2) result', [owner, month]);
    await query('select public.crm_operations_v2_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result', [owner, operations.revision, crypto.randomUUID(), 'payment_record', hash,
      JSON.stringify({ workOrderId: work.id, paymentDate: todayIST(), amount: '10', method: 'CASH', reference: 'Actual receipt' }), month]);
    const paid = await query<OperationsData>('select public.crm_operations_v2_read($1::uuid,$2) result', [owner, month]);
    const account = paid.extension.paymentAccounts?.find(row => row.workOrderId === work.id);
    assert.equal(account?.contractPaise, '100000'); assert.equal(account?.receivedPaise, '1000'); assert.equal(account?.outstandingPaise, '99000');
    assert.deepEqual((await read()).workorders.find(row => row.id === work.id)?.snapshot, quote);
  });

  test('revisions preserve package context and warranties while genuine draft edits and legacy-to-package conversion are allowed', async () => {
    const draft = await save(); await act('quote_issue', { id: draft.id });
    const revision = (await act('quote_revise', { id: draft.id })).data.quotations.find(row => row.revisionOf === draft.id)!;
    assert.equal(revision.packagePrice, draft.packagePrice); assert.equal(revision.packageGstRate, draft.packageGstRate);
    assert.deepEqual(revision.items.map(row => row.warranty), draft.items.map(row => row.warranty));
    const edited = (await act('quote_save', edit(revision, { packagePrice: '20000', items: revision.items.map(({ id, category, description, quantity, unit, unitPrice, discount, gstRate, hsnSac }) => ({ id, category, description, quantity, unit, unitPrice, discount, gstRate, hsnSac })) }))).data.quotations.find(row => row.id === revision.id)!;
    assert.equal(edited.totals.total, 2000000); assert.equal(edited.items[0].warranty, draft.items[0].warranty);
    const oldClient = plan(await read(), 'quote_save', edit(edited, { title: 'Older-client scope edit' }));
    delete (oldClient.changes.upserts.quotations[0] as Quotation).items[0].warranty;
    assert.equal((await commit(oldClient)).data.quotations.find(row => row.id === revision.id)!.items[0].warranty, draft.items[0].warranty);
    const legacy = (await read()).quotations.find(row => row.id === legacyDraftId)!;
    const converted = (await act('quote_save', input({ id: legacy.id, title: legacy.title, packagePrice: '35000' }))).data.quotations.find(row => row.id === legacy.id)!;
    assert.equal(converted.packagePrice, '35000'); assert.equal(converted.totals.total, 3500000);
  });

  test('forged package types, precision, totals, line prices, quantities and warranty values are rejected atomically', async () => {
    const before = await read(); const request = plan(before, 'quote_save', input()); const valid = request.changes.upserts.quotations[0] as Quotation;
    const variations: Record<string, unknown>[] = [
      ...[-1, null, true, '-1', '1e3', '1.001', '90000000000.01', '9'.repeat(31)].map(packagePrice => ({ packagePrice })),
      ...[null, '100.01', '0.001', '-1', '18'].map(packageGstRate => ({ packageGstRate })),
      { totals: { ...valid.totals, total: valid.totals.total + 1 } }, { totals: { ...valid.totals, total: String(valid.totals.total) } },
      { totals: { ...valid.totals, mode: 'IGST' } }, { totals: { ...valid.totals, needsConfig: true } },
      ...[{ unitPrice: '1' }, { discount: '1' }, { gstRate: '1' }, { total: 1 }, { warranty: null }, { warranty: 'x'.repeat(201) }, { quantity: '0' }, { quantity: '1.0001' }, { quantity: '1000000000.001' }].map(change => ({ items: [{ ...valid.items[0], ...change }, ...valid.items.slice(1)] })),
    ];
    for (const change of variations) {
      const forged = structuredClone(request); forged.changes.upserts.quotations[0] = { ...valid, ...change }; await rejects(() => commit(forged));
    }
    const missing = structuredClone(request); delete (missing.changes.upserts.quotations[0] as Quotation).packagePrice; await rejects(() => commit(missing));
    const overflow = structuredClone(request); overflow.changes.upserts.quotations[0] = { ...valid, packagePrice: '90000000000', packageGstRate: '100', gstEnabled: true,
      totals: { subtotal: 9000000000000, discount: 0, taxable: 9000000000000, cgst: 4500000000000, sgst: 4500000000000, utgst: 0, igst: 0, total: 18000000000000, mode: 'CGST_SGST', needsConfig: false } };
    await rejects(() => commit(overflow)); assert.deepEqual(await read(), before);
  });

  test('issue/settings/revision cannot drop package fields or warranty and old itemized overwrites cannot erase package mode', async () => {
    const draft = await save(); const before = await read(); const issue = plan(before, 'quote_issue', { id: draft.id });
    for (const key of ['packagePrice', 'packageGstRate', 'warranty']) {
      const forged = structuredClone(issue); const row = forged.changes.upserts.quotations[0] as Quotation;
      if (key === 'warranty') delete row.items[0].warranty; else delete row[key as 'packagePrice' | 'packageGstRate'];
      await rejects(() => commit(forged));
    }
    const oldSave = plan(before, 'quote_save', edit(draft, { title: 'Forged itemized overwrite' }));
    delete (oldSave.changes.upserts.quotations[0] as Quotation).packagePrice; delete (oldSave.changes.upserts.quotations[0] as Quotation).packageGstRate;
    await rejects(() => commit(oldSave)); assert.deepEqual(await read(), before);
    const settings = plan(before, 'company_save', { name: 'Actual contractor', legalName: 'Actual contractor', address: 'Actual supplier address', stateCode: '07', gstin: '07ABCDE1234F1Z5' });
    const settingsQuote = settings.changes.upserts.quotations.find(row => (row as Quotation).id === draft.id) as Quotation;
    assert.ok(settingsQuote); delete settingsQuote.items[0].warranty;
    await rejects(() => commit(settings)); assert.deepEqual(await read(), before);
    await act('quote_issue', { id: draft.id }); const revise = plan(await read(), 'quote_revise', { id: draft.id });
    const next = revise.changes.upserts.quotations.find(row => (row as Quotation).revisionOf === draft.id) as Quotation;
    delete next.packagePrice; delete next.packageGstRate; await rejects(() => commit(revise));
  });

  test('a taxable package cannot be issued unconfigured or accepted with a changed commercial snapshot', async () => {
    const draft = await save({ gstEnabled: true, packageGstRate: '18' }); const before = await read();
    const forged = plan(before, 'quote_issue', { id: draft.id }); const row = forged.changes.upserts.quotations[0] as Quotation;
    row.placeOfSupply = ''; row.totals = { ...row.totals, cgst: 0, sgst: 0, utgst: 0, igst: 0, total: row.totals.taxable, mode: 'UNCONFIGURED', needsConfig: true };
    await rejects(() => commit(forged)); assert.deepEqual(await read(), before);
    await act('quote_issue', { id: draft.id }); const issued = await read();
    const acceptance = plan(issued, 'quote_accept', { id: draft.id, acceptanceNote: 'Actual acceptance' });
    (acceptance.changes.upserts.quotations[0] as Quotation).items[0].warranty = 'Replaced commercial warranty';
    await rejects(() => commit(acceptance)); assert.deepEqual(await read(), issued);
  });
});
