import { completeQuoteItems } from './fixtures/quotation-items.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { reusableQuoteScope } from '../lib/quotation-reuse.ts';
import { computeQuote } from '../lib/finance.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Company, QuoteItemInput, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-27T06:00:00Z');
function act(data: WorkspaceData, action: string, payload: unknown) { return applyAction(data, action, payload, now); }
function workspace(registered = false): WorkspaceData {
  const user = { userId: 'owner', name: 'Test Owner', email: 'test@example.invalid', role: 'OWNER' as const, active: true };
  const data: WorkspaceData = {
    revision: 1, user, members: [user], company: { ...DEFAULT_COMPANY, legalName: 'Test supplier', address: 'Real supplier test address',
      ...(registered ? { gstin: '06ABCDE1234F1Z5', stateCode: '06' } : {}) },
    leads: [], customers: [], quotations: [], workorders: [], followups: [], activity: [], sequences: {},
  };
  act(data, 'customer_save', { name: 'Test customer', address: 'Real billing test address' });
  act(data, 'lead_save', { title: 'Solar project', customerId: data.customers[0].id, siteAddress: 'Real site test address' });
  return data;
}
function input(data: WorkspaceData) {
  return { leadId: data.leads[0].id, title: 'Solar installation', validUntil: '2026-12-27', siteAddress: 'Real site test address',
    items: completeQuoteItems([{ id: 'item-1', description: 'Solar installation', quantity: '2', unit: 'job', unitPrice: '500.05' }]) };
}
function companyInput(company: Company) {
  const { name, legalName, address, gstin, stateCode, phone, email, website, terms } = company;
  return { name, legalName, address, gstin, stateCode, phone, email, website, terms };
}

test('No GST issues and accepts without GSTIN, state, HSN/SAC or discount inputs', () => {
  const data = workspace();
  act(data, 'quote_save', { ...input(data), gstEnabled: false });
  const quote = data.quotations[0];
  assert.equal(quote.gstEnabled, false);
  assert.equal(quote.items[0].hsnSac, '');
  assert.equal(quote.items[0].discount, '0');
  assert.equal(quote.items[0].gstRate, '0');
  assert.deepEqual(quote.totals, { subtotal: 100010, discount: 0, taxable: 100010, cgst: 0, sgst: 0, utgst: 0, igst: 0, total: 100010, mode: 'NO_GST', needsConfig: false });
  act(data, 'quote_issue', { id: quote.id });
  assert.equal(quote.status, 'ISSUED');
  assert.equal(quote.supplier?.gstin, '');
  assert.equal(quote.placeOfSupply, '');
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Customer agreed to this scope and total.' });
  assert.equal(data.leads[0].status, 'WON');
  assert.equal(data.workorders.length, 1);
  assert.equal(data.workorders[0].quoteId, quote.id);
  assert.deepEqual(data.workorders[0].snapshot, quote);
  act(data, 'quote_convert', { id: quote.id });
  assert.equal(data.workorders.length, 1);
});

test('new omitted mode defaults off without a positive rate and preserves older positive-rate clients', () => {
  for (const rate of [undefined, '', '0', '0.00', '18']) {
    const data = workspace(true);
    const payload = input(data);
    act(data, 'quote_save', { ...payload, placeOfSupply: '06', items: payload.items.map(item => ({ ...item, ...(rate === undefined ? {} : { gstRate: rate }) })) });
    assert.equal(data.quotations[0].gstEnabled, rate === '18');
    assert.equal(data.quotations[0].totals.mode, rate === '18' ? 'CGST_SGST' : 'NO_GST');
  }
});

test('explicit GST still requires genuine registration, states and valid rates but no HSN code', () => {
  const data = workspace();
  const payload = input(data);
  const taxedInput = { ...payload, gstEnabled: true, placeOfSupply: '06', items: payload.items.map(item => ({ ...item, gstRate: '18' })) };
  act(data, 'quote_save', taxedInput);
  const quote = data.quotations[0];
  assert.equal(quote.totals.needsConfig, true);
  assert.throws(() => act(data, 'quote_issue', { id: quote.id }), /GSTIN/);
  act(data, 'company_save', { ...companyInput(data.company), gstin: '06ABCDE1234F1Z5', stateCode: '06' });
  act(data, 'quote_save', { ...taxedInput, id: quote.id, placeOfSupply: '' });
  assert.throws(() => act(data, 'quote_issue', { id: quote.id }), /place of supply/);
  act(data, 'quote_save', { ...taxedInput, id: quote.id });
  act(data, 'quote_issue', { id: quote.id });
  assert.equal(quote.items[0].hsnSac, '');
  assert.equal(quote.totals.total, 118012);
  assert.equal(quote.totals.cgst, 9001);
  assert.equal(quote.totals.sgst, 9001);
  assert.equal(quote.status, 'ISSUED');
});

test('No GST rejects hidden positive, negative, malformed or nonfinite rates and malformed flags', () => {
  for (const rate of ['18', '-1', '100.01', '0.001', 'NaN', 'Infinity', '1e2', '0x0', false, 0]) {
    const data = workspace(); const payload = input(data);
    assert.throws(() => act(data, 'quote_save', { ...payload, gstEnabled: false, items: payload.items.map(item => ({ ...item, gstRate: rate })) }), CRMError);
    assert.equal(data.quotations.length, 0);
  }
  for (const flag of ['false', 0, null]) {
    const data = workspace();
    assert.throws(() => act(data, 'quote_save', { ...input(data), gstEnabled: flag }), CRMError);
  }
});

test('No GST still validates company, customer billing, site, validity and item requirements', () => {
  const cases = [
    (data: WorkspaceData) => { data.company.legalName = ''; },
    (data: WorkspaceData) => { data.company.address = ''; },
    (data: WorkspaceData) => { data.customers[0].address = ''; },
    (data: WorkspaceData) => { data.quotations[0].siteAddress = ''; },
    (data: WorkspaceData) => { data.quotations[0].validUntil = '2026-11-26'; },
    (data: WorkspaceData) => { data.quotations[0].items = []; },
  ];
  for (const removeRequired of cases) {
    const data = workspace(); act(data, 'quote_save', { ...input(data), gstEnabled: false });
    removeRequired(data);
    assert.throws(() => act(data, 'quote_issue', { id: data.quotations[0].id }), CRMError);
    assert.equal(data.quotations[0].status, 'DRAFT');
    assert.deepEqual(data.sequences, {});
  }
});

test('hidden historical HSN and discount survive draft edits by item ID and omitted GST mode', () => {
  const data = workspace(true); const payload = input(data);
  act(data, 'quote_save', { ...payload, placeOfSupply: '06', items: payload.items.map(item => ({ ...item, hsnSac: '9954', discount: item.id === 'item-1' ? '12.34' : '0', gstRate: '18' })) });
  const quote = data.quotations[0];
  delete quote.gstEnabled; // Represents a draft saved before the optional-GST release.
  const before = structuredClone(quote.totals);
  act(data, 'quote_save', { ...payload, id: quote.id, placeOfSupply: '06', items: payload.items.map(item => ({ ...item, gstRate: '18' })) });
  assert.equal(quote.gstEnabled, true);
  assert.equal(quote.items[0].hsnSac, '9954');
  assert.equal(quote.items[0].discount, '12.34');
  assert.deepEqual(quote.totals, before);
  act(data, 'quote_save', { ...payload, id: quote.id, placeOfSupply: '06', items: [
    { ...payload.items[0], category: undefined, id: 'new-item', gstRate: '18' }, { ...payload.items[0], gstRate: '18' }, ...payload.items.slice(1),
  ] });
  assert.equal(quote.items[0].discount, '0');
  assert.equal(quote.items[0].hsnSac, '');
  assert.equal(quote.items[1].discount, '12.34');
  assert.equal(quote.items[1].hsnSac, '9954');
  act(data, 'quote_save', { ...payload, id: quote.id, gstEnabled: false });
  assert.equal(quote.items[0].discount, '12.34');
  assert.equal(quote.totals.total, 98776);
  act(data, 'quote_save', { ...payload, id: quote.id });
  assert.equal(quote.gstEnabled, false);
  assert.equal(quote.totals.total, 98776);
});

test('issued historical financial snapshots stay intact after settings changes and revision', () => {
  const data = workspace(true); const payload = input(data);
  act(data, 'quote_save', { ...payload, placeOfSupply: '06', items: payload.items.map(item => ({ ...item, gstRate: '18', hsnSac: '9954', discount: item.id === 'item-1' ? '12.34' : '0' })) });
  const quote = data.quotations[0]; delete quote.gstEnabled;
  act(data, 'quote_issue', { id: quote.id });
  const frozen = structuredClone(quote);
  act(data, 'company_save', { ...companyInput(data.company), gstin: '', stateCode: '', legalName: 'Updated supplier' });
  assert.deepEqual(quote, frozen);
  assert.throws(() => act(data, 'quote_save', { ...payload, id: quote.id, gstEnabled: false }), /immutable/);
  act(data, 'quote_revise', { id: quote.id });
  const revision = data.quotations[1];
  assert.equal(revision.gstEnabled, true);
  assert.equal(revision.items[0].hsnSac, '9954');
  assert.equal(revision.items[0].discount, '12.34');
  assert.deepEqual(quote.items, frozen.items);
  assert.deepEqual(quote.totals, frozen.totals);
  assert.deepEqual(quote.supplier, frozen.supplier);
});

test('No GST revisions and company updates retain their explicit treatment and totals', () => {
  const data = workspace(); act(data, 'quote_save', { ...input(data), gstEnabled: false });
  const quote = data.quotations[0]; act(data, 'quote_issue', { id: quote.id });
  act(data, 'quote_revise', { id: quote.id });
  const revised = data.quotations[1]; const totals = structuredClone(revised.totals);
  act(data, 'company_save', { ...companyInput(data.company), gstin: '06ABCDE1234F1Z5', stateCode: '06' });
  assert.equal(revised.gstEnabled, false);
  assert.deepEqual(revised.totals, totals);
  act(data, 'quote_issue', { id: revised.id });
  assert.equal(revised.status, 'ISSUED');
});

test('No GST calculations retain exact rounding and validation without mutating inputs', () => {
  const items: QuoteItemInput[] = [{ id: 'item', description: 'Fractional item', hsnSac: '', quantity: '0.125', unit: 'm', unitPrice: '0.04', discount: '0', gstRate: '' }];
  const original = structuredClone(items);
  const result = computeQuote(items, '', '', false);
  assert.equal(result.items[0].gross, 1);
  assert.equal(result.items[0].gstRate, '0');
  assert.equal(result.totals.total, 1);
  assert.equal(result.totals.needsConfig, false);
  assert.deepEqual(items, original);
  for (const patch of [{ quantity: '0' }, { unitPrice: '-1' }, { discount: '1' }, { gstRate: '1' }]) {
    assert.throws(() => computeQuote([{ ...items[0], ...patch }], '', '', false));
  }
});

test('optional GST does not change who may issue or accept quotations', () => {
  const data = workspace(); act(data, 'quote_save', { ...input(data), gstEnabled: false });
  const quote = data.quotations[0];
  for (const role of ['SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER'] as const) {
    data.user.role = role;
    for (const action of ['quote_issue', 'quote_accept']) {
      assert.throws(() => act(data, action, action === 'quote_accept' ? { id: quote.id, acceptanceNote: 'Customer approval' } : { id: quote.id }), error => error instanceof CRMError && error.status === 403);
    }
  }
});


function packageInput(data: WorkspaceData) {
  const rows = completeQuoteItems([]).map(row => ({ ...row, warranty: row.category === 'Panels' ? '10 years' : '' }));
  return { ...input(data), items: rows, gstEnabled: true, placeOfSupply: '06', packagePrice: '100.10', packageGstRate: '18' };
}

test('a package charges once for all quantities and uses the same regional rounding as one priced scope', () => {
  const p = packageInput(workspace(true));
  for (const [supplier, place, enabled] of [['06','06',true], ['04','04',true], ['06','07',true], ['','',true], ['','',false]] as const) {
    const gstRate = enabled ? p.packageGstRate : '0';
    const reference = computeQuote([{ ...p.items[0], quantity: '1', unitPrice: p.packagePrice, gstRate }], supplier, place, enabled);
    const actual = computeQuote(p.items.map(row => ({ ...row, quantity: '28.125' })), supplier, place, enabled,
      { packagePrice: p.packagePrice, packageGstRate: gstRate });
    assert.deepEqual(actual.totals, reference.totals);
    assert.equal(actual.items.length, 9);
    assert.ok(actual.items.every(row => row.total === 0));
    assert.equal(actual.items[0].warranty, '10 years');
  }
});

test('invalid package pricing, duplicate line charges and invalid warranty fail before saving', () => {
  for (const patch of [{packagePrice:'-1'}, {packagePrice:'1e3'}, {packagePrice:'1.005'}, {packagePrice:'90000000001'},
      {packageGstRate:'100.01'}, {packageGstRate:undefined}, {packagePrice:undefined}, {gstEnabled:false},
      {packagePrice:'90000000000',packageGstRate:'100'}]) {
    const data=workspace(true);
    assert.throws(() => act(data, 'quote_save', { ...packageInput(data), ...patch }), CRMError);
    assert.equal(data.quotations.length,0);
  }
  for (const patch of [{unitPrice:'5'}, {discount:'1'}, {gstRate:'5'}, {warranty:'x'.repeat(201)}, {warranty:2026}]) {
    const data=workspace(true), p=packageInput(data);
    assert.throws(() => act(data, 'quote_save', { ...p, items:p.items.map((item,i)=>i ? item : {...item,...patch}) }), CRMError);
    assert.equal(data.quotations.length,0);
  }
});

test('package amount and warranties survive draft edit, settings, issue, revision, acceptance and work order', () => {
  const data = workspace(true), p = packageInput(data);
  act(data,'quote_save',p);
  const quote = data.quotations[0];
  const legacyEdit = { ...input(data), id: quote.id };
  assert.throws(() => act(data,'quote_save',legacyEdit), /Reload/);
  act(data,'quote_save',{ ...p, id: quote.id, packagePrice:'125.50', items:p.items.map(row=>({...row,warranty:undefined})) });
  assert.equal(quote.items[0].warranty,'10 years');
  act(data,'company_save',companyInput(data.company));
  assert.equal(quote.totals.total,14810);
  act(data,'quote_issue',{id:quote.id});
  act(data,'quote_revise',{id:quote.id});
  const revised=data.quotations.find(row=>row.revisionOf===quote.id)!;
  assert.equal(revised.packagePrice,'125.50'); assert.equal(revised.packageGstRate,'18');
  assert.equal(revised.items[0].warranty,'10 years');
  assert.notEqual(revised.items[0].id,quote.items[0].id);
  act(data,'quote_issue',{id:revised.id});
  act(data,'quote_accept',{id:revised.id, acceptanceNote:'Approved package'});
  assert.deepEqual(data.workorders[0].snapshot,revised);
  assert.equal(data.workorders[0].snapshot?.totals.total,14810);
});

test('reusing quotes copies specifications into distinct lines and excludes every client and acceptance field', () => {
  const data=workspace(true); act(data,'quote_save',packageInput(data));
  const source=data.quotations[0], previous=structuredClone(source);
  const scope=reusableQuoteScope(source);
  assert.deepEqual(Object.keys(scope).sort(), ['gstEnabled','items','packageGstRate','packagePrice']);
  assert.equal(scope.packagePrice,'100.10'); assert.equal(scope.packageGstRate,'18');
  assert.equal(scope.items.length,9); assert.equal(scope.items[0].warranty,'10 years');
  assert.ok(scope.items.every(row=>source.items.every(original=>row.id!==original.id)));
  scope.items[0].warranty='25 years';
  act(data,'lead_save',{title:'Second client roof',contact:'Second client',siteAddress:'Second site'});
  act(data,'quote_save',{...scope, leadId:data.leads[1].id,title:'Second client proposal',siteAddress:'Second site',validUntil:'2026-12-27',placeOfSupply:'07'});
  assert.deepEqual(source,previous);
  assert.equal(data.quotations[1].totals.mode,'IGST'); assert.equal(data.quotations[1].items[0].warranty,'25 years');
  assert.equal(data.quotations[1].leadId,data.leads[1].id);
});

test('reusing a historical quotation carries its discounted pre-tax amount and asks for one rate when rates differ', () => {
  const data=workspace(true), p=input(data);
  const items=p.items.map((row,i)=>({...row,unitPrice:i<2?'100.00':'0',gstRate:i===0?'5':'18',discount:i===0?'0.25':'0'}));
  act(data,'quote_save',{...p,gstEnabled:true,placeOfSupply:'06',items});
  const source=data.quotations[0]; const scope=reusableQuoteScope(source);
  assert.equal(scope.packagePrice,(source.totals.taxable/100).toFixed(2));
  assert.equal(scope.packageGstRate,'');
  const legacy={...source,items:[{...source.items[0],category:undefined}]};
  const legacyScope=reusableQuoteScope(legacy);
  assert.equal(legacyScope.packageGstRate,'5');
  assert.equal(legacyScope.items.length,10); assert.equal(legacyScope.items[1].description,'');
  assert.ok(legacyScope.items.every(row=>row.unitPrice==='0'&&row.discount==='0'&&row.gstRate==='0'));
});
