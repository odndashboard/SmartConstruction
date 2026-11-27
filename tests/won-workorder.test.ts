import { completeQuoteItems } from './fixtures/quotation-items.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Role, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-27T06:00:00Z');
function workspace(): WorkspaceData {
  const members = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER'] as Role[]).map(role => ({
    userId: `test-${role}`, name: role, email: `${role}@example.invalid`, role, active: true,
  }));
  return { revision: 1, company: { ...DEFAULT_COMPANY, legalName: 'Test supplier', address: 'Supplier address', gstin: '06ABCDE1234F1Z5', stateCode: '06' },
    user: { ...members[0] }, members, customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {} };
}
function act(data: WorkspaceData, action: string, payload: unknown) { return applyAction(data, action, payload, now); }
function addLead(data: WorkspaceData, won = false) {
  act(data, 'lead_save', { title: 'Solar project', contact: 'Actual contact', phone: '9876543210', expectedKw: '10.5', siteAddress: 'Project site', stateCode: '06', owner: 'test-SALES', status: won ? 'WON' : 'NEW' });
  return data.leads.at(-1)!;
}
function issue(data: WorkspaceData, leadId: string, title = 'Installation scope') {
  const lead = data.leads.find(row => row.id === leadId)!;
  const customer = data.customers.find(row => row.id === lead.customerId)!;
  act(data, 'customer_save', { id: customer.id, name: customer.name, contact: customer.contact, phone: customer.phone, address: 'Confirmed billing address', stateCode: '06' });
  act(data, 'quote_save', { leadId, title, validUntil: '2026-12-27', placeOfSupply: '06', siteAddress: 'Approved project site', items: completeQuoteItems([
    { id: crypto.randomUUID(), description: title, hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '1000', gstRate: '18' },
  ]) });
  const quote = data.quotations.at(-1)!;
  act(data, 'quote_issue', { id: quote.id });
  return quote;
}
function accept(data: WorkspaceData, quoteId: string) { return act(data, 'quote_accept', { id: quoteId, acceptanceNote: 'Written customer approval.' }); }

test('Won creation creates one unpriced Planned order with real lead details and repeated edits never duplicate it', () => {
  const data = workspace(); const lead = addLead(data, true); const order = data.workorders[0];
  assert.equal(order.leadId, lead.id); assert.equal(order.automaticForLead, true);
  assert.equal(order.title, lead.title); assert.equal(order.customerName, 'Actual contact');
  assert.equal(order.siteAddress, lead.siteAddress); assert.equal(order.owner, lead.owner); assert.equal(order.expectedKw, 10.5);
  assert.equal(order.status, 'PLANNED'); assert.equal(order.quoteId, null); assert.equal(order.snapshot, null);
  assert.deepEqual(order.milestones, []); assert.deepEqual(data.quotations, []);
  const original = structuredClone(order); const sequences = structuredClone(data.sequences);
  act(data, 'lead_status', { id: lead.id, status: 'WON' });
  act(data, 'lead_save', { id: lead.id, title: 'Edited enquiry', status: 'WON', expectedKw: '12.75' });
  assert.deepEqual(data.workorders, [original]); assert.deepEqual(data.sequences, sequences);
});

test('acceptance automatically creates a genuine quote-backed order and explicit conversion is idempotent', () => {
  const data = workspace(); const lead = addLead(data); const quote = issue(data, lead.id);
  assert.equal(data.workorders.length, 0);
  accept(data, quote.id);
  const original = structuredClone(data.workorders[0]); const sequences = structuredClone(data.sequences); const audits = data.activity.length;
  assert.equal(original.quoteId, quote.id); assert.equal(original.leadId, lead.id); assert.equal(original.automaticForLead, true);
  assert.deepEqual(original.snapshot, quote);
  assert.match(act(data, 'quote_convert', { id: quote.id }), /already exists/);
  act(data, 'quote_convert', { id: quote.id });
  assert.deepEqual(data.workorders, [original]); assert.deepEqual(data.sequences, sequences); assert.equal(data.activity.length, audits);
});

test('acceptance attaches to the same provisional order without losing delivery progress', () => {
  const data = workspace(); const lead = addLead(data, true); const order = data.workorders[0];
  act(data, 'workorder_save', { id: order.id, owner: 'test-OPERATIONS', startDate: '2026-11-27', endDate: '2026-12-10', status: 'ACTIVE' });
  act(data, 'milestone_add', { workorderId: order.id, title: 'Site survey', dueDate: '2026-11-28' });
  act(data, 'milestone_complete', { workorderId: order.id, milestoneId: order.milestones[0].id });
  const preserved = structuredClone(order);
  const quote = issue(data, lead.id); accept(data, quote.id);
  assert.equal(data.workorders.length, 1); assert.equal(order.quoteId, quote.id); assert.deepEqual(order.snapshot, quote);
  for (const key of ['id', 'number', 'leadId', 'automaticForLead', 'expectedKw', 'status', 'owner', 'startDate', 'endDate', 'milestones', 'createdAt'] as const) assert.deepEqual(order[key], preserved[key]);
  assert.equal(order.title, quote.title); assert.equal(order.siteAddress, quote.siteAddress);
  const attached = structuredClone(order); act(data, 'lead_status', { id: lead.id, status: 'WON' });
  act(data, 'quote_convert', { id: quote.id }); assert.deepEqual(order, attached);
});

test('late acceptance attaches approved scope without reopening Completed or Cancelled provisional orders', () => {
  for (const status of ['COMPLETED', 'CANCELLED'] as const) {
    const data = workspace(); const lead = addLead(data, true); const order = data.workorders[0];
    if (status === 'COMPLETED') act(data, 'workorder_save', { id: order.id, owner: '', startDate: '', endDate: '', status: 'ACTIVE' });
    act(data, 'workorder_save', { id: order.id, owner: '', startDate: '', endDate: '', status });
    const quote = issue(data, lead.id); accept(data, quote.id);
    assert.equal(data.workorders.length, 1); assert.equal(order.status, status); assert.equal(order.quoteId, quote.id);
    assert.deepEqual(order.snapshot, quote);
    assert.throws(() => act(data, 'workorder_save', { id: order.id, owner: '', startDate: '', endDate: '', status: 'ACTIVE' }), /Closed work orders/);
  }
});

test('delivery roles can reopen Completed using only its status and preserve the original order', () => {
  for (const role of ['OWNER', 'MANAGER', 'OPERATIONS'] as const) {
    const data = workspace(); const lead = addLead(data, true); const order = data.workorders[0];
    accept(data, issue(data, lead.id).id);
    act(data, 'workorder_save', { id: order.id, status: 'ACTIVE', owner: 'test-SALES', startDate: '2026-11-27', endDate: '2026-12-15' });
    act(data, 'milestone_add', { workorderId: order.id, title: 'Delivery check' });
    assert.throws(() => act(data, 'workorder_save', { id: order.id, status: 'COMPLETED' }), /milestones/);
    act(data, 'milestone_complete', { workorderId: order.id, milestoneId: order.milestones[0].id });
    act(data, 'workorder_save', { id: order.id, status: 'COMPLETED' });
    const previous = structuredClone(order);
    data.members.find(member => member.role === 'SALES')!.active = false;
    data.user = data.members.find(member => member.role === role)!;
    act(data, 'workorder_save', { id: order.id, status: 'ACTIVE' });
    assert.deepEqual(order, { ...previous, status: 'ACTIVE', updatedAt: order.updatedAt });
    assert.match(data.activity[0].description, /Completed → In progress/);
    assert.equal(data.leads[0].status, 'WON');
    for (const restrictedRole of ['ACCOUNTANT', 'SALES', 'DEALER']) {
      data.user = { ...data.members.find(member => member.role === restrictedRole)!, active: true };
      assert.throws(() => act(data, 'workorder_save', { id: order.id, status: 'ON_HOLD' }), (error: unknown) => error instanceof CRMError && error.status === 403);
    }
    data.user = data.members[0];
    act(data, 'workorder_save', { id: order.id, status: 'CANCELLED' });
    assert.throws(() => act(data, 'workorder_save', { id: order.id, status: 'ACTIVE' }), /Closed work orders/);
  }
});

test('every accepted scope automatically gets its own work order without duplicating its lead or rewriting previous approved scope', () => {
  const data = workspace(); const lead = addLead(data); const first = issue(data, lead.id); accept(data, first.id);
  const original = structuredClone(data.workorders[0]);
  const second = issue(data, lead.id, 'Additional roof scope');
  assert.match(accept(data, second.id), /work order.*ready/i);
  assert.equal(data.workorders.length, 2); assert.deepEqual(data.workorders[0], original);
  assert.equal(data.leads.length, 1); assert.equal(data.leads[0].status, 'WON');
  assert.equal(data.workorders[1].automaticForLead, false); assert.equal(data.workorders[1].leadId, lead.id);
  assert.deepEqual(data.workorders[1].snapshot, second); assert.equal(data.sequences['WO/2026-27'], 2);
  act(data, 'quote_convert', { id: second.id }); act(data, 'lead_status', { id: lead.id, status: 'WON' });
  assert.equal(data.workorders.length, 2); assert.equal(data.sequences['WO/2026-27'], 2);
});

test('legacy quotation-backed orders without leadId are reused through their frozen snapshot', () => {
  const data = workspace(); const lead = addLead(data); const quote = issue(data, lead.id); accept(data, quote.id);
  delete data.workorders[0].leadId; delete data.workorders[0].automaticForLead;
  const original = structuredClone(data.workorders[0]); const sequences = structuredClone(data.sequences);
  act(data, 'lead_status', { id: lead.id, status: 'WON' }); act(data, 'lead_save', { id: lead.id, title: lead.title, status: 'WON' });
  act(data, 'quote_convert', { id: quote.id });
  assert.deepEqual(data.workorders, [original]); assert.deepEqual(data.sequences, sequences);
});

test('Sales cannot create Won orders or backfill an order through an existing Won detail edit', () => {
  const data = workspace(); const lead = addLead(data);
  lead.status = 'WON'; // Historical state before the rollout backfill.
  data.user = { ...data.members.find(member => member.role === 'SALES')! };
  act(data, 'lead_save', { id: lead.id, title: 'Updated historical enquiry' });
  assert.equal(data.workorders.length, 0); assert.deepEqual(data.sequences, {});
  assert.throws(() => act(data, 'lead_save', { title: 'Unauthorized won enquiry', status: 'WON' }), error => error instanceof CRMError && error.status === 403);
  assert.throws(() => act(data, 'lead_status', { id: lead.id, status: 'WON' }), error => error instanceof CRMError && error.status === 403);
  assert.equal(data.workorders.length, 0);
});

test('clear examples retains lead/customer ancestors of a real lead-only work order', () => {
  const data = workspace(); const lead = addLead(data, true); const customer = data.customers[0];
  lead.isDemo = true; customer.isDemo = true; // Simulate historical mixed classifications.
  act(data, 'clear_demo', {});
  assert.equal(data.workorders.length, 1); assert.equal(data.leads[0].id, lead.id); assert.equal(data.customers[0].id, customer.id);
});
