import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Company, Member, Role, WorkspaceData, QuoteItemInput } from '../lib/types.ts';

const NOW = new Date('2026-11-23T06:00:00Z');

function workspace(configured = true): WorkspaceData {
  const members: Member[] = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]).map(role => ({
    userId: `test-${role.toLowerCase()}`, name: `Test ${role}`, email: `${role.toLowerCase()}@example.invalid`, role, active: true,
  }));
  return {
    revision: 1, company: configured ? {
      ...DEFAULT_COMPANY, legalName: 'Synthetic Test Company', address: 'Synthetic supplier address',
      gstin: '06ABCDE1234F1Z5', stateCode: '06',
    } : { ...DEFAULT_COMPANY },
    user: { ...members[0] }, members, customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {},
  };
}
function act(data: WorkspaceData, action: string, payload: unknown, now = NOW): string {
  return applyAction(data, action, payload, now);
}
function setRole(data: WorkspaceData, role: Role): void {
  data.user = { ...data.members.find(member => member.role === role)! };
}
function expectDenied(run: () => unknown): void {
  assert.throws(run, error => error instanceof CRMError && error.status === 403);
}
function companyInput(company: Company) {
  return {
    name: company.name, legalName: company.legalName, address: company.address,
    gstin: company.gstin, stateCode: company.stateCode, phone: company.phone,
    email: company.email, website: company.website, terms: company.terms,
  };
}
function addLead(data: WorkspaceData) {
  act(data, 'customer_save', { name: 'Synthetic Customer', address: 'Synthetic customer billing address', stateCode: '06' });
  const customer = data.customers.at(-1)!;
  act(data, 'lead_save', {
    customerId: customer.id, title: 'Synthetic site renovation', siteAddress: 'Synthetic project address',
    stateCode: '06', owner: 'test-sales', value: '250000', status: 'NEW',
  });
  return data.leads.at(-1)!;
}
function quoteInput(leadId: string) {
  const items: QuoteItemInput[] = [{
    id: 'test-item', description: 'Synthetic civil works', hsnSac: '9954', quantity: '2',
    unit: 'job', unitPrice: '500', discount: '100', gstRate: '18',
  }];
  return { leadId, title: 'Synthetic renovation quotation', validUntil: '2026-12-23',
    placeOfSupply: '06', siteAddress: 'Synthetic project address', terms: 'Synthetic agreed terms.', items };
}
function addQuote(data: WorkspaceData) {
  const lead = addLead(data);
  act(data, 'quote_save', quoteInput(lead.id));
  return data.quotations.at(-1)!;
}
function issuedQuote(data: WorkspaceData) {
  const quote = addQuote(data);
  act(data, 'quote_issue', { id: quote.id });
  return quote;
}
function acceptedQuote(data: WorkspaceData) {
  const quote = issuedQuote(data);
  act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Synthetic customer approval recorded in writing.' });
  return quote;
}

describe('server-side authorization and input boundaries', () => {
  test('viewers cannot mutate records or settings', () => {
    const data = workspace(); setRole(data, 'VIEWER');
    for (const action of ['customer_save', 'lead_save', 'followup_save', 'quote_save', 'quote_issue', 'workorder_save', 'company_save', 'member_role', 'load_demo', 'clear_demo']) {
      expectDenied(() => act(data, action, {}));
    }
  });

  test('sales cannot approve contracts and operations cannot change commercial records', () => {
    const data = workspace(); setRole(data, 'SALES');
    for (const action of ['quote_issue', 'quote_accept', 'quote_convert', 'workorder_save', 'company_save']) {
      expectDenied(() => act(data, action, {}));
    }
    setRole(data, 'OPERATIONS');
    for (const action of ['customer_save', 'lead_save', 'quote_save', 'quote_accept']) {
      expectDenied(() => act(data, action, {}));
    }
    setRole(data, 'MANAGER');
    expectDenied(() => act(data, 'member_role', { userId: 'test-sales', role: 'OWNER' }));
  });

  test('inactive owners are denied and injected control fields are rejected', () => {
    const data = workspace(); data.user.active = false;
    expectDenied(() => act(data, 'customer_save', { name: 'Forbidden' }));
    data.user.active = true;
    assert.throws(() => act(data, 'customer_save', { name: 'Forbidden', isDemo: false, role: 'OWNER' }), CRMError);
    const quote = addQuote(data);
    assert.throws(() => act(data, 'quote_save', { ...quoteInput(quote.leadId), id: quote.id, totals: { total: 1 } }), CRMError);
  });

  test('unknown assignments are rejected and lost leads require a reason and reopening as New', () => {
    const data = workspace(); const lead = addLead(data);
    assert.throws(() => act(data, 'lead_save', {
      customerId: lead.customerId, title: 'Invalid owner', owner: 'not-a-member', value: '0',
    }), CRMError);
    assert.throws(() => act(data, 'lead_status', { id: lead.id, status: 'LOST', lostReason: ' ' }), CRMError);
    act(data, 'lead_status', { id: lead.id, status: 'LOST', lostReason: 'Customer postponed the job.' });
    assert.equal(lead.status, 'LOST');
    assert.throws(() => act(data, 'lead_status', { id: lead.id, status: 'NEGOTIATION' }), CRMError);
    assert.throws(() => act(data, 'lead_status', { id: lead.id, status: 'WON' }), CRMError);
    act(data, 'lead_status', { id: lead.id, status: 'NEW' });
    assert.equal(lead.lostReason, '');
  });

  test('team changes retain an active owner and cannot demote the acting owner', () => {
    const data = workspace();
    assert.throws(() => act(data, 'member_role', { userId: data.user.userId, role: 'VIEWER' }), CRMError);
    act(data, 'member_role', { userId: 'test-viewer', role: 'SALES' });
    assert.equal(data.members.find(member => member.userId === 'test-viewer')!.role, 'SALES');
    assert.equal(data.members.filter(member => member.role === 'OWNER' && member.active).length, 1);
  });

  test('owners can assign Accountant and accountants cannot mutate core CRM or team records', () => {
    const data = workspace();
    act(data, 'member_role', { userId: 'test-viewer', role: 'ACCOUNTANT' });
    assert.equal(data.members.find(member => member.userId === 'test-viewer')!.role, 'ACCOUNTANT');
    setRole(data, 'ACCOUNTANT');
    for (const action of [
      'customer_save', 'lead_save', 'lead_status', 'followup_save', 'followup_complete', 'followup_cancel',
      'quote_save', 'quote_revise', 'quote_issue', 'quote_accept', 'quote_decline', 'quote_convert',
      'workorder_save', 'milestone_add', 'milestone_complete', 'company_save', 'member_role', 'member_active',
      'load_demo', 'clear_demo',
    ]) expectDenied(() => act(data, action, {}));
    for (const role of ['MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
      const restricted = workspace(); setRole(restricted, role);
      expectDenied(() => act(restricted, 'member_role', { userId: 'test-sales', role: 'ACCOUNTANT' }));
    }
  });

  test('only owners and managers can move a lead through authorized status transitions', () => {
    for (const role of ['OWNER', 'MANAGER'] as Role[]) {
      const data = workspace(); const lead = addLead(data);
      setRole(data, role);
      act(data, 'lead_status', { id: lead.id, status: 'CONTACTED' });
      assert.equal(lead.status, 'CONTACTED');
      act(data, 'lead_status', { id: lead.id, status: 'LOST', lostReason: 'Customer deferred the site project.' });
      assert.equal(lead.status, 'LOST');
      assert.equal(lead.lostReason, 'Customer deferred the site project.');
      assert.throws(() => act(data, 'lead_status', { id: lead.id, status: 'NEGOTIATION' }), CRMError);
      act(data, 'lead_status', { id: lead.id, status: 'NEW' });
      assert.equal(lead.status, 'NEW');
      assert.equal(lead.lostReason, '');
      act(data, 'lead_status', { id: lead.id, status: 'WON' });
      assert.equal(lead.status, 'WON');
    }
    for (const role of ['SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
      const data = workspace(); const lead = addLead(data); const before = structuredClone(lead);
      setRole(data, role);
      expectDenied(() => act(data, 'lead_status', { id: lead.id, status: 'CONTACTED' }));
      assert.deepEqual(lead, before);
    }
  });

  test('sales can edit lead details but cannot forge status changes through lead_save', () => {
    const data = workspace(); const lead = addLead(data);
    act(data, 'lead_status', { id: lead.id, status: 'CONTACTED' });
    setRole(data, 'SALES');
    const input = { id: lead.id, customerId: lead.customerId, title: lead.title, value: '250000' };
    for (const status of ['NEW', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'LOST', 'WON']) {
      expectDenied(() => act(data, 'lead_save', { ...input, status }));
      assert.equal(lead.status, 'CONTACTED');
    }
    act(data, 'lead_save', { ...input, title: 'Updated project details', status: 'CONTACTED' });
    assert.equal(lead.title, 'Updated project details');
    assert.equal(lead.status, 'CONTACTED');
    act(data, 'lead_save', { ...input, title: 'Updated with status omitted' });
    assert.equal(lead.title, 'Updated with status omitted');
    assert.equal(lead.status, 'CONTACTED');
    const create = { customerId: lead.customerId, title: 'New enquiry' };
    expectDenied(() => act(data, 'lead_save', { ...create, status: 'CONTACTED' }));
    act(data, 'lead_save', create);
    assert.equal(data.leads.at(-1)!.status, 'NEW');
  });

  test('authorized lead edits preserve status when omitted and cannot bypass won or lost rules', () => {
    const data = workspace(); const quote = acceptedQuote(data);
    const lead = data.leads.find(record => record.id === quote.leadId)!;
    setRole(data, 'MANAGER');
    const input = { id: lead.id, customerId: lead.customerId, title: lead.title };
    act(data, 'lead_save', { ...input, title: 'Updated won project details' });
    assert.equal(lead.status, 'WON');
    assert.throws(() => act(data, 'lead_save', { ...input, status: 'NEW' }), CRMError);
    const openLead = addLead(data);
    const openInput = { id: openLead.id, customerId: openLead.customerId, title: openLead.title };
    assert.throws(() => act(data, 'lead_save', { ...openInput, status: 'LOST' }), CRMError);
    act(data, 'lead_save', { ...openInput, status: 'SITE_VISIT' });
    assert.equal(openLead.status, 'SITE_VISIT');
  });
});

describe('commercial document workflow', () => {
  test('manually marking a lead Won preserves quotations and still requires acceptance before work-order conversion', () => {
    for (const role of ['OWNER', 'MANAGER'] as Role[]) {
      for (const action of ['lead_status', 'lead_save']) {
        const data = workspace(); const quote = issuedQuote(data);
        const lead = data.leads.find(row => row.id === quote.leadId)!;
        const documents = structuredClone({ quotations: data.quotations, workorders: data.workorders, sequences: data.sequences });
        setRole(data, role);
        act(data, action, { id: lead.id, ...(action === 'lead_save' ? { title: lead.title } : {}), status: 'WON' });
        assert.equal(lead.status, 'WON');
        assert.deepEqual({ quotations: data.quotations, workorders: data.workorders, sequences: data.sequences }, documents);
        assert.throws(() => act(data, 'quote_convert', { id: quote.id }), /Accept the quotation/);
        assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: '' }), CRMError);
        act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Written confirmation of the quotation.' });
        act(data, 'quote_convert', { id: quote.id });
        assert.equal(quote.status, 'ACCEPTED'); assert.equal(lead.status, 'WON');
        assert.deepEqual(data.workorders[0].snapshot, quote);
      }
    }
  });

  test('issuing a quotation for a manually won lead retains Won and does not infer acceptance', () => {
    const data = workspace(); const quote = addQuote(data);
    const lead = data.leads.find(row => row.id === quote.leadId)!;
    act(data, 'lead_status', { id: lead.id, status: 'WON' });
    act(data, 'quote_issue', { id: quote.id });
    assert.equal(lead.status, 'WON'); assert.equal(quote.status, 'ISSUED');
    assert.equal(quote.acceptanceNote, ''); assert.equal(quote.acceptedAt, undefined);
    assert.deepEqual(data.workorders, []);
  });

  test('incomplete registration allows an explicitly unpriced draft but prevents issue', () => {
    const data = workspace(false); const quote = addQuote(data);
    assert.equal(quote.status, 'DRAFT');
    assert.equal(quote.totals.needsConfig, true);
    assert.equal(quote.totals.total, 90000);
    assert.throws(() => act(data, 'quote_issue', { id: quote.id }), CRMError);
    assert.equal(quote.number, null);
    assert.deepEqual(data.sequences, {});
  });

  test('issue requires customer address, reviewed classification and at least one item', () => {
    const data = workspace(); const quote = addQuote(data);
    const customer = data.customers.find(row => row.id === data.leads.find(row => row.id === quote.leadId)!.customerId)!;
    customer.address = '';
    assert.throws(() => act(data, 'quote_issue', { id: quote.id }), CRMError);
    customer.address = 'Synthetic address';
    quote.items[0].hsnSac = '';
    assert.throws(() => act(data, 'quote_issue', { id: quote.id }), CRMError);
    quote.items = [];
    assert.throws(() => act(data, 'quote_issue', { id: quote.id }), CRMError);
    assert.equal(quote.status, 'DRAFT');
    assert.equal(quote.number, null);
  });

  test('project state controls tax and issue freezes commercial snapshots', () => {
    const data = workspace(); const quote = addQuote(data);
    act(data, 'quote_save', { ...quoteInput(quote.leadId), id: quote.id, placeOfSupply: '07' });
    act(data, 'quote_issue', { id: quote.id });
    assert.equal(quote.totals.mode, 'IGST');
    assert.equal(quote.totals.igst, 16200);
    assert.equal(quote.totals.cgst + quote.totals.sgst, 0);
    const frozen = structuredClone(quote);
    act(data, 'customer_save', { id: quote.customer!.id, name: 'Changed customer name', address: 'Changed billing address', stateCode: '06' });
    act(data, 'company_save', { ...companyInput(data.company), legalName: 'Changed supplier name' });
    assert.deepEqual(quote, frozen);
    assert.throws(() => act(data, 'quote_save', { ...quoteInput(quote.leadId), id: quote.id, title: 'Tampered title' }), CRMError);
    assert.equal(quote.title, frozen.title);
  });

  test('expired acceptance fails and valid acceptance requires evidence then marks lead won', () => {
    const data = workspace(); const quote = issuedQuote(data);
    assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Late approval' }, new Date('2026-12-24T06:00:00Z')), CRMError);
    assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: ' ' }), CRMError);
    act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Customer confirmed the scope and price.' });
    assert.equal(quote.status, 'ACCEPTED');
    assert.equal(data.leads.find(lead => lead.id === quote.leadId)!.status, 'WON');
    assert.equal(quote.acceptedAt, NOW.toISOString());
    assert.throws(() => act(data, 'quote_decline', { id: quote.id }), CRMError);
    assert.throws(() => act(data, 'quote_revise', { id: quote.id }), CRMError);
  });

  test('revision creates an editable copy and makes the original ineligible for acceptance', () => {
    const data = workspace(); const original = issuedQuote(data);
    const originalNumber = original.number; const originalItems = structuredClone(original.items);
    act(data, 'quote_revise', { id: original.id });
    const revised = data.quotations.find(quote => quote.revisionOf === original.id)!;
    assert.equal(original.status, 'SUPERSEDED');
    assert.equal(original.number, originalNumber);
    assert.deepEqual(original.items, originalItems);
    assert.equal(revised.status, 'DRAFT'); assert.equal(revised.number, null);
    assert.equal(revised.revision, 2);
    assert.equal(revised.supplier, undefined);
    act(data, 'quote_save', { ...quoteInput(revised.leadId), id: revised.id, title: 'Revised commercial scope' });
    assert.equal(revised.title, 'Revised commercial scope');
    assert.notEqual(original.title, revised.title);
    assert.throws(() => act(data, 'quote_accept', { id: original.id, acceptanceNote: 'Old quote' }), CRMError);
    assert.throws(() => act(data, 'quote_revise', { id: original.id }), CRMError);
  });

  test('accepted quote converts once and preserves scope independently of master records', () => {
    const data = workspace(); const quote = acceptedQuote(data);
    act(data, 'quote_convert', { id: quote.id });
    const order = data.workorders[0]; const auditCount = data.activity.length;
    const counters = structuredClone(data.sequences);
    act(data, 'quote_convert', { id: quote.id });
    assert.equal(data.workorders.length, 1);
    assert.equal(data.activity.length, auditCount);
    assert.deepEqual(data.sequences, counters);
    assert.deepEqual(order.snapshot, quote);
    assert.notEqual(order.snapshot, quote);
    assert.notEqual(order.snapshot.items, quote.items);
    act(data, 'customer_save', { id: quote.customer!.id, name: 'Later master edit', address: 'New address' });
    assert.equal(order.customerName, 'Synthetic Customer');
    assert.equal(order.snapshot.totals.total, 106200);
    assert.equal(order.number, 'SC/WO/2026-27/000001');
  });

  test('draft quotes cannot be accepted or converted', () => {
    const data = workspace(); const quote = addQuote(data);
    assert.throws(() => act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Skipped issue' }), CRMError);
    assert.throws(() => act(data, 'quote_convert', { id: quote.id }), CRMError);
    assert.equal(data.workorders.length, 0);
  });
});

describe('follow-ups, delivery and example records', () => {
  test('follow-ups reschedule and complete with outcomes; terminal records stay closed', () => {
    const data = workspace(); const lead = addLead(data); setRole(data, 'OPERATIONS');
    const input = { leadId: lead.id, title: 'Measure the site', dueAt: '2026-11-24T09:30:00+05:30', channel: 'Site visit', owner: 'test-operations' };
    act(data, 'followup_save', input); const row = data.followups[0];
    act(data, 'followup_save', { ...input, id: row.id, dueAt: '2026-11-25T09:30:00+05:30' });
    assert.equal(row.dueAt, '2026-11-25T04:00:00.000Z');
    assert.throws(() => act(data, 'followup_complete', { id: row.id, outcome: ' ' }), CRMError);
    act(data, 'followup_complete', { id: row.id, outcome: 'Site measurements recorded.' });
    assert.equal(row.status, 'DONE'); assert.equal(row.completedAt, NOW.toISOString());
    assert.throws(() => act(data, 'followup_save', { ...input, id: row.id }), CRMError);
    assert.throws(() => act(data, 'followup_cancel', { id: row.id }), CRMError);
    act(data, 'followup_save', input); const cancelled = data.followups.at(-1)!;
    act(data, 'followup_cancel', { id: cancelled.id });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.throws(() => act(data, 'followup_complete', { id: cancelled.id, outcome: 'Cannot complete cancellation' }), CRMError);
  });

  test('work orders enforce dates, stages and milestone completion before closure', () => {
    const data = workspace(); const quote = acceptedQuote(data); act(data, 'quote_convert', { id: quote.id });
    const order = data.workorders[0]; setRole(data, 'OPERATIONS');
    const update = { id: order.id, owner: 'test-operations', startDate: '2026-11-24', endDate: '2026-12-10' };
    assert.throws(() => act(data, 'workorder_save', { ...update, status: 'COMPLETED' }), CRMError);
    assert.throws(() => act(data, 'workorder_save', { ...update, status: 'ACTIVE', endDate: '2026-11-20' }), CRMError);
    act(data, 'workorder_save', { ...update, status: 'ACTIVE' });
    act(data, 'milestone_add', { workorderId: order.id, title: 'Site preparation', dueDate: '2026-11-25' });
    assert.throws(() => act(data, 'workorder_save', { ...update, status: 'COMPLETED' }), CRMError);
    act(data, 'milestone_complete', { workorderId: order.id, milestoneId: order.milestones[0].id });
    act(data, 'workorder_save', { ...update, status: 'ON_HOLD' });
    act(data, 'workorder_save', { ...update, status: 'ACTIVE' });
    act(data, 'workorder_save', { ...update, status: 'COMPLETED' });
    assert.equal(order.status, 'COMPLETED');
    assert.throws(() => act(data, 'workorder_save', { ...update, status: 'ACTIVE' }), CRMError);
    assert.throws(() => act(data, 'milestone_add', { workorderId: order.id, title: 'Late scope addition' }), CRMError);
  });

  test('loading examples is explicit/idempotent and does not replace company settings', () => {
    const data = workspace(false); const company = structuredClone(data.company);
    assert.equal(data.customers.length, 0);
    act(data, 'load_demo', {});
    assert.ok(data.customers.length > 0);
    assert.ok(data.customers.every(row => row.isDemo));
    const counts = [data.customers.length, data.leads.length, data.quotations.length, data.workorders.length];
    act(data, 'load_demo', {});
    assert.deepEqual([data.customers.length, data.leads.length, data.quotations.length, data.workorders.length], counts);
    assert.deepEqual(data.company, company);
  });

  test('clearing examples preserves actual records and their accepted snapshots', () => {
    const data = workspace(); const quote = acceptedQuote(data); act(data, 'quote_convert', { id: quote.id });
    const orderBefore = structuredClone(data.workorders[0]); const leadId = quote.leadId;
    act(data, 'load_demo', {});
    assert.ok(data.workorders.some(order => order.isDemo));
    act(data, 'clear_demo', {});
    assert.deepEqual(data.workorders, [orderBefore]);
    assert.equal(data.quotations.length, 1); assert.equal(data.quotations[0].id, quote.id);
    assert.equal(data.leads.length, 1); assert.equal(data.leads[0].id, leadId);
    assert.equal(data.customers.length, 1);
    assert.ok(data.activity.some(event => event.action === 'clear_demo'));
    assert.ok(data.activity.every(event => !event.id.startsWith('demo_')));
  });

  test('clearing examples conservatively preserves ancestors referenced by a real record', () => {
    const data = workspace(); act(data, 'load_demo', {});
    const order = data.workorders.find(row => row.isDemo)!;
    order.isDemo = false; // Simulate mixed flags in historical/imported data.
    const quote = data.quotations.find(row => row.id === order.quoteId)!;
    const lead = data.leads.find(row => row.id === quote.leadId)!;
    act(data, 'clear_demo', {});
    assert.ok(data.workorders.some(row => row.id === order.id));
    assert.ok(data.quotations.some(row => row.id === quote.id));
    assert.ok(data.leads.some(row => row.id === lead.id));
    assert.ok(data.customers.some(row => row.id === lead.customerId));
  });
});

describe('employee activation controls', () => {
  test('only owners can disable or enable employees', () => {
    const data = workspace();
    for (const role of ['MANAGER', 'SALES', 'OPERATIONS', 'VIEWER'] as Role[]) {
      setRole(data, role);
      expectDenied(() => act(data, 'member_active', { userId: 'test-sales', active: false }));
    }
  });

  test('owner disables and re-enables a member without rewriting their role', () => {
    const data = workspace();
    act(data, 'member_active', { userId: 'test-sales', active: false });
    const employee = data.members.find(member => member.userId === 'test-sales')!;
    assert.equal(employee.active, false); assert.equal(employee.role, 'SALES');
    assert.equal(data.activity[0].action, 'member_active');
    data.user = { ...employee };
    expectDenied(() => act(data, 'customer_save', { name: 'Blocked after disable' }));
    setRole(data, 'OWNER');
    act(data, 'member_active', { userId: employee.userId, active: true });
    assert.equal(employee.active, true); assert.equal(employee.role, 'SALES');
  });

  test('self-disable is blocked even when another owner exists', () => {
    const data = workspace();
    data.members.push({ userId: 'second-owner', name: 'Second Owner', email: 'second@example.invalid', role: 'OWNER', active: true });
    assert.throws(() => act(data, 'member_active', { userId: data.user.userId, active: false }), /cannot disable your own/i);
    assert.equal(data.members[0].active, true);
  });

  test('repeating the current activation state is a no-op with no extra audit', () => {
    const data = workspace(); const events = data.activity.length;
    assert.match(act(data, 'member_active', { userId: 'test-sales', active: true }), /already active/);
    assert.equal(data.activity.length, events);
    assert.throws(() => act(data, 'member_active', { userId: 'test-sales', active: false, role: 'OWNER' }), CRMError);
  });
});
