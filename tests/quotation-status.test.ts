import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { effectiveQuoteStatus } from '../lib/quotation-status.ts';
import { buildDashboardOverview } from '../lib/dashboard-overview.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Quotation, Role, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-27T06:00:00Z');
function workspace(): WorkspaceData {
  const members = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]).map(role => ({
    userId: `test-${role}`, name: role, email: `${role}@example.invalid`, role, active: true,
  }));
  return { revision: 1, company: { ...DEFAULT_COMPANY, legalName: 'Test supplier', address: 'Supplier address', gstin: '06ABCDE1234F1Z5', stateCode: '06' },
    user: { ...members[0] }, members, customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {} };
}
function act(data: WorkspaceData, action: string, payload: unknown, instant = now) { return applyAction(data, action, payload, instant); }
function issued(data: WorkspaceData, validUntil = '2026-12-27') {
  act(data, 'customer_save', { name: 'Actual customer', address: 'Confirmed billing address', stateCode: '06' });
  act(data, 'lead_save', { title: 'Solar project', customerId: data.customers.at(-1)!.id, expectedKw: '10.5', siteAddress: 'Project site', stateCode: '06' });
  act(data, 'quote_save', { leadId: data.leads.at(-1)!.id, title: 'Installation scope', validUntil, placeOfSupply: '06', siteAddress: 'Approved project site', terms: 'Written scope', items: [
    { id: crypto.randomUUID(), description: 'Installation', hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '1000', gstRate: '18' },
  ] });
  const quote = data.quotations.at(-1)!; act(data, 'quote_issue', { id: quote.id }); return quote;
}
function frozenCommercial(quote: Quotation) {
  return Object.fromEntries(Object.entries(quote).filter(([key]) => key !== 'status' && key !== 'updatedAt'));
}

test('Owner and Manager can expire early and reopen without changing commercial details or linked records', () => {
  for (const role of ['OWNER', 'MANAGER'] as Role[]) {
    const data = workspace(); const quote = issued(data);
    act(data, 'lead_status', { id: quote.leadId, status: 'WON' });
    const details = structuredClone(frozenCommercial(quote));
    const untouched = structuredClone({ company: data.company, customers: data.customers, leads: data.leads, workorders: data.workorders, sequences: data.sequences });
    data.user = { ...data.members.find(member => member.role === role)! };
    act(data, 'quote_expire', { id: quote.id }, new Date('2026-11-27T07:00:00Z'));
    assert.equal(quote.status, 'EXPIRED'); assert.equal(quote.updatedAt, '2026-11-27T07:00:00.000Z');
    assert.equal(data.activity[0].action, 'quote_expire'); assert.equal(data.activity[0].entityId, quote.id);
    assert.deepEqual(frozenCommercial(quote), details);
    assert.deepEqual({ company: data.company, customers: data.customers, leads: data.leads, workorders: data.workorders, sequences: data.sequences }, untouched);
    act(data, 'quote_reopen', { id: quote.id }, new Date('2026-11-27T08:00:00Z'));
    assert.equal(quote.status, 'ISSUED'); assert.equal(quote.updatedAt, '2026-11-27T08:00:00.000Z');
    assert.equal(data.activity[0].action, 'quote_reopen'); assert.deepEqual(frozenCommercial(quote), details);
    assert.deepEqual({ company: data.company, customers: data.customers, leads: data.leads, workorders: data.workorders, sequences: data.sequences }, untouched);
  }
});

test('Sales, Operations, Accountant, Viewer and inactive admins cannot expire or reopen', () => {
  for (const role of ['SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
    const data = workspace(); const quote = issued(data);
    data.user = { ...data.members.find(member => member.role === role)! };
    for (const action of ['quote_expire', 'quote_reopen']) {
      const before = structuredClone(data);
      assert.throws(() => act(data, action, { id: quote.id }), error => error instanceof CRMError && error.status === 403);
      assert.deepEqual(data, before);
    }
  }
  const data = workspace(); const quote = issued(data); data.user.active = false;
  assert.throws(() => act(data, 'quote_expire', { id: quote.id }), error => error instanceof CRMError && error.status === 403);
});

test('reopening honors the original date through the last second of the India day', () => {
  const data = workspace(); const quote = issued(data, '2026-11-27');
  act(data, 'quote_expire', { id: quote.id });
  act(data, 'quote_reopen', { id: quote.id }, new Date('2026-11-27T18:29:59Z'));
  assert.equal(quote.status, 'ISSUED');
  act(data, 'quote_expire', { id: quote.id }, new Date('2026-11-27T18:30:00Z'));
  const before = structuredClone(data);
  assert.throws(() => act(data, 'quote_reopen', { id: quote.id }, new Date('2026-11-27T18:30:00Z')), /validity date has passed.*revision/i);
  assert.deepEqual(data, before); assert.equal(quote.validUntil, '2026-11-27');
  act(data, 'quote_revise', { id: quote.id }, new Date('2026-11-27T18:30:00Z'));
  const revision = data.quotations.at(-1)!;
  assert.equal(quote.status, 'SUPERSEDED'); assert.equal(revision.status, 'DRAFT');
  assert.equal(revision.revisionOf, quote.id); assert.ok(revision.validUntil > quote.validUntil);
});

test('status actions cannot alter accepted quotations or work orders, or bypass immutable prices', () => {
  const data = workspace(); const quote = issued(data);
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Customer written approval.' });
  const before = structuredClone(data);
  for (const action of ['quote_expire', 'quote_reopen']) {
    assert.throws(() => act(data, action, { id: quote.id }), CRMError);
    assert.deepEqual(data, before);
  }
  const second = issued(data);
  for (const action of ['quote_expire', 'quote_reopen']) {
    assert.throws(() => act(data, action, { id: second.id, validUntil: '2099-12-31' }), CRMError);
    assert.throws(() => act(data, action, { id: second.id, status: 'ACCEPTED' }), CRMError);
  }
});

test('expire/reopen only allow their exact source states', () => {
  for (const status of ['DRAFT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED'] as const) {
    const data = workspace(); const quote = issued(data); quote.status = status;
    for (const action of ['quote_expire', 'quote_reopen']) assert.throws(() => act(data, action, { id: quote.id }), CRMError);
  }
  const data = workspace(); const quote = issued(data);
  assert.throws(() => act(data, 'quote_reopen', { id: quote.id }), /Only an expired/);
  act(data, 'quote_expire', { id: quote.id });
  assert.throws(() => act(data, 'quote_expire', { id: quote.id }), /Only an issued/);
  assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Cannot skip reopen' }), /Only a current issued/);
});

test('reopened quotations retain the real acceptance and automatic work-order path', () => {
  const data = workspace(); const quote = issued(data);
  act(data, 'quote_expire', { id: quote.id }); act(data, 'quote_reopen', { id: quote.id });
  assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: '' }), CRMError);
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Customer approved after reopening.' });
  assert.equal(data.leads[0].status, 'WON'); assert.equal(data.workorders.length, 1);
  assert.deepEqual(data.workorders[0].snapshot, quote); assert.equal(data.workorders[0].quoteId, quote.id);
});

test('effective status and dashboard totals consistently omit manual and calendar-expired quotations', () => {
  const data = workspace(); const today = issued(data, '2026-11-27');
  const manuallyExpired = issued(data); act(data, 'quote_expire', { id: manuallyExpired.id });
  const past = issued(data); past.validUntil = '2026-11-26';
  const accepted = issued(data); act(data, 'quote_accept', { id: accepted.id, acceptanceNote: 'Approved.' });
  accepted.validUntil = '2026-11-26';
  assert.equal(effectiveQuoteStatus(today, '2026-11-27'), 'ISSUED');
  assert.equal(effectiveQuoteStatus(manuallyExpired, '2026-11-27'), 'EXPIRED');
  assert.equal(effectiveQuoteStatus(past, '2026-11-27'), 'EXPIRED');
  assert.equal(effectiveQuoteStatus(accepted, '2026-11-27'), 'ACCEPTED');
  const summary = buildDashboardOverview(data, null, now);
  assert.equal(summary.core.pendingQuotations, 1);
  assert.equal(summary.core.pendingQuotationPaise, String(today.totals.total));
  assert.equal(past.status, 'ISSUED'); // Display expiry does not rewrite stored history.
});
