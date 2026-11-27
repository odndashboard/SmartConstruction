import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { computeQuote } from '../lib/finance.ts';
import { REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS, getMissingQuoteCategories } from '../lib/quotation-categories.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { QuoteItemInput, Quotation, Role, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-27T06:00:00Z');
function act(data: WorkspaceData, action: string, payload: unknown) { return applyAction(data, action, payload, now); }
function workspace(): WorkspaceData {
  const user = { userId: 'owner', name: 'Synthetic Owner', email: 'owner@example.invalid', role: 'OWNER' as const, active: true };
  const data: WorkspaceData = {
    revision: 1, user, members: [user], company: { ...DEFAULT_COMPANY, legalName: 'Synthetic supplier', address: 'Synthetic registered address' },
    customers: [], leads: [], quotations: [], workorders: [], followups: [], activity: [], sequences: {},
  };
  act(data, 'customer_save', { name: 'Synthetic customer', address: 'Synthetic billing address' });
  act(data, 'lead_save', { title: 'Solar project', customerId: data.customers[0].id, siteAddress: 'Synthetic project address' });
  return data;
}
function line(id: string, unitPrice = '0'): QuoteItemInput {
  return { id, description: `Documented scope ${id}`, quantity: '1', unit: 'job', unitPrice, hsnSac: '', discount: '0', gstRate: '0' };
}
function requiredItems(): QuoteItemInput[] {
  return REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line(`required-${index}`, index === 0 ? '123.45' : '0'), category }));
}
function input(data: WorkspaceData, items = requiredItems()) {
  return { leadId: data.leads[0].id, title: 'Documented solar installation', validUntil: '2026-12-27', gstEnabled: false,
    placeOfSupply: '', siteAddress: 'Synthetic project address', terms: 'Agreed written scope', items };
}
function legacy(data: WorkspaceData, status: 'DRAFT' | 'ISSUED' = 'ISSUED'): Quotation {
  const quote: Quotation = {
    ...input(data), ...computeQuote([line('historical-item', '345.67')], '', '', false), id: 'historical-quote',
    status, revision: 1, number: status === 'ISSUED' ? 'SC/Q/2026-27/000001' : null,
    supplier: structuredClone(data.company), customer: structuredClone(data.customers[0]), acceptanceNote: '', isDemo: false,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), ...(status === 'ISSUED' ? { issuedAt: now.toISOString() } : {}),
  };
  data.quotations.push(quote);
  return quote;
}

test('all nine exact categories persist with decimal values, explicit no-charge rows and optional extras', () => {
  assert.deepEqual(REQUIRED_QUOTE_CATEGORIES, ['Panels', 'Inverter', 'Structure', 'DC Wire', 'Ac Wire', 'Earthing Wire', 'Earthing ROD', 'Lighting Arrester', 'Filing']);
  const data = workspace(); const items = requiredItems(); items[0].quantity = '1.5'; items.push(line('extra', '10.01'));
  act(data, 'quote_save', input(data, items));
  const quote = data.quotations[0];
  assert.equal(quote.itemSchemaVersion, 2);
  assert.deepEqual(quote.items.map(item => item.category), [...REQUIRED_QUOTE_CATEGORIES, undefined]);
  assert.equal(quote.items[8].unitPrice, '0');
  assert.equal(quote.totals.total, 19519);
  act(data, 'quote_issue', { id: quote.id });
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Actual written test approval' });
  assert.deepEqual(data.workorders[0].snapshot!.items, quote.items);
  assert.equal(data.workorders[0].snapshot!.itemSchemaVersion, 2);
});

test('missing category/version, duplicate categories and forged category names cannot bypass mandatory rows', () => {
  for (const version of [undefined, 2]) {
    for (const items of [[], requiredItems().slice(1), requiredItems().map(item => { const row = { ...item }; delete row.category; return row; })]) {
      const data = workspace();
      assert.throws(() => act(data, 'quote_save', { ...input(data, items), ...(version ? { itemSchemaVersion: version } : {}) }), /all nine required/);
      assert.equal(data.quotations.length, 0);
    }
  }
  for (const category of ['Panels', 'AC Wire', '', null]) {
    const data = workspace(); const items = requiredItems();
    const payload = input(data, items);
    assert.throws(() => act(data, 'quote_save', { ...payload, items: [...items, { ...line('duplicate'), category }] }), CRMError);
  }
  for (const itemSchemaVersion of [0, 1, '2', true]) {
    const data = workspace();
    assert.throws(() => act(data, 'quote_save', { ...input(data), itemSchemaVersion }), CRMError);
  }
});

test('every required row needs a description, unit, positive quantity and explicit valid price', () => {
  const invalid = [
    ['description', ' '], ['unit', ''], ['quantity', ''], ['quantity', '0'], ['quantity', '-1'], ['quantity', '1.0001'],
    ['unitPrice', ''], ['unitPrice', '-1'], ['unitPrice', '1.001'], ['unitPrice', '1e3'],
  ];
  for (const [field, value] of invalid) {
    const data = workspace(); const items = requiredItems();
    items[5] = { ...items[5], [field]: value };
    assert.throws(() => act(data, 'quote_save', input(data, items)), CRMError, `${field}=${value}`);
    assert.equal(data.quotations.length, 0);
  }
  const data = workspace(); const items = requiredItems();
  const withoutPrice: Partial<QuoteItemInput> = { ...items[8] }; delete withoutPrice.unitPrice;
  assert.throws(() => act(data, 'quote_save', { ...input(data), items: [...items.slice(0, 8), withoutPrice] }), CRMError);
});

test('editing persists required-row identities and values, and cannot remove or duplicate their category', () => {
  const data = workspace(); act(data, 'quote_save', input(data)); const quote = data.quotations[0];
  const items = requiredItems(); items[0].unitPrice = '222.22'; items[5].description = 'Confirmed copper earthing specification';
  act(data, 'quote_save', { ...input(data, items), id: quote.id });
  assert.equal(quote.items[0].id, 'required-0'); assert.equal(quote.items[0].unitPrice, '222.22');
  assert.equal(quote.items[5].category, 'Earthing Wire'); assert.equal(quote.items[5].description, items[5].description);
  const before = structuredClone(quote);
  assert.throws(() => act(data, 'quote_save', { ...input(data, items.slice(0, -1)), id: quote.id }), CRMError);
  assert.deepEqual(quote, before);
  const duplicateIds = items.map((item, index) => index === 8 ? { ...item, id: items[0].id } : item);
  assert.throws(() => act(data, 'quote_save', { ...input(data, duplicateIds), id: quote.id }), /unique ID/);
});

test('issued historical quotations still accept and convert without adding or repricing original lines', () => {
  const data = workspace(); const quote = legacy(data); const original = structuredClone(quote);
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Existing customer acceptance' });
  act(data, 'quote_convert', { id: quote.id });
  assert.deepEqual(quote.items, original.items); assert.deepEqual(quote.totals, original.totals);
  assert.equal(quote.itemSchemaVersion, undefined); assert.equal(data.workorders.length, 1);
  assert.deepEqual(data.workorders[0].snapshot!.items, original.items);
  assert.deepEqual(data.workorders[0].snapshot!.totals, original.totals);
});

test('legacy drafts keep all their original lines and need explicit new categories before saving or issuing', () => {
  const data = workspace(); const quote = legacy(data, 'DRAFT');
  quote.items[0].description = 'Panels';
  const originalItems = structuredClone(quote.items);
  assert.deepEqual(getMissingQuoteCategories(quote.items), REQUIRED_QUOTE_CATEGORIES);
  assert.throws(() => act(data, 'quote_issue', { id: quote.id }), /all nine required/);
  const { id, description, quantity, unit, unitPrice, hsnSac, discount, gstRate } = quote.items[0];
  const oldInput = { id, description, quantity, unit, unitPrice, hsnSac, discount, gstRate };
  assert.throws(() => act(data, 'quote_save', { ...input(data, [oldInput]), id: quote.id }), /all nine required/);
  const required = requiredItems().map(item => ({ ...item, unitPrice: '0' }));
  act(data, 'quote_save', { ...input(data, [oldInput, ...required]), id: quote.id });
  assert.deepEqual(quote.items[0], originalItems[0]);
  assert.equal(quote.totals.total, 34567); assert.equal(quote.items.length, 10);
  act(data, 'quote_issue', { id: quote.id });
  assert.equal(quote.status, 'ISSUED'); assert.equal(quote.itemSchemaVersion, 2);
});

test('a historical revision preserves the original scope and cannot issue until its required categories are completed', () => {
  const data = workspace(); const original = legacy(data); const before = structuredClone(original.items);
  act(data, 'quote_revise', { id: original.id });
  const revision = data.quotations[1];
  assert.deepEqual(original.items, before); assert.equal(original.status, 'SUPERSEDED');
  assert.equal(revision.itemSchemaVersion, undefined); assert.equal(revision.items.length, 1);
  assert.equal(revision.items[0].description, before[0].description); assert.equal(revision.items[0].unitPrice, before[0].unitPrice);
  assert.throws(() => act(data, 'quote_issue', { id: revision.id }), /all nine required/);
  const revisedInputs = revision.items.map(({ id, description, quantity, unit, unitPrice, hsnSac, discount, gstRate }) => ({ id, description, quantity, unit, unitPrice, hsnSac, discount, gstRate }));
  act(data, 'quote_save', { ...input(data, [...revisedInputs, ...requiredItems()]), id: revision.id });
  act(data, 'quote_issue', { id: revision.id });
  assert.deepEqual(original.items, before); assert.equal(revision.itemSchemaVersion, 2);
});

test('completed category layouts survive ordinary revision and existing sales/approval roles stay unchanged', () => {
  const data = workspace(); act(data, 'quote_save', input(data)); const quote = data.quotations[0]; act(data, 'quote_issue', { id: quote.id });
  act(data, 'quote_revise', { id: quote.id }); const revision = data.quotations[1];
  assert.equal(revision.itemSchemaVersion, 2); assert.deepEqual(revision.items.map(item => item.category), REQUIRED_QUOTE_CATEGORIES);
  act(data, 'quote_issue', { id: revision.id });
  for (const role of ['OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
    const denied = workspace(); denied.user = { ...denied.user, role };
    assert.throws(() => act(denied, 'quote_save', input(denied)), error => error instanceof CRMError && error.status === 403);
  }
  const sales = workspace(); sales.user = { ...sales.user, role: 'SALES' };
  act(sales, 'quote_save', input(sales));
  assert.throws(() => act(sales, 'quote_issue', { id: sales.quotations[0].id }), error => error instanceof CRMError && error.status === 403);
});

test('all 100 historical lines can be retained with the nine additional required rows, within a bounded total', () => {
  const data = workspace(); const items = [...Array.from({ length: 100 }, (_, index) => line(`old-${index}`)), ...requiredItems()];
  assert.equal(items.length, MAX_QUOTE_ITEMS);
  act(data, 'quote_save', input(data, items));
  assert.equal(data.quotations[0].items.length, 109);
  assert.deepEqual(data.quotations[0].items.slice(0, 100).map(item => item.id), items.slice(0, 100).map(item => item.id));
  assert.throws(() => act(data, 'quote_save', input(data, [...items, line('too-many')])), CRMError);
});
