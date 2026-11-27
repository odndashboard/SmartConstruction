import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Role, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-24T06:00:00Z');
function fixture() {
  const members = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER'] as Role[]).map(role => ({
    userId: `test-${role}`, name: role, email: `${role}@example.invalid`, role, active: true,
  }));
  const data: WorkspaceData = {
    revision: 1, company: { ...DEFAULT_COMPANY }, user: { ...members[0] }, members,
    customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {},
  };
  applyAction(data, 'customer_save', { name: 'Synthetic customer' }, now);
  applyAction(data, 'lead_save', { customerId: data.customers[0].id, title: 'Synthetic construction lead' }, now);
  return { data, lead: data.leads[0] };
}
function role(data: WorkspaceData, value: Role) { data.user = { ...data.members.find(row => row.role === value)! }; }
function denied(run: () => unknown) { assert.throws(run, error => error instanceof CRMError && error.status === 403); }

test('Owner and Manager can update status, record a lost reason and reopen as New', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value);
    applyAction(data, 'lead_status', { id: lead.id, status: 'CONTACTED' }, now);
    assert.equal(lead.status, 'CONTACTED');
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status: 'LOST', lostReason: ' ' }, now), CRMError);
    applyAction(data, 'lead_status', { id: lead.id, status: 'LOST', lostReason: 'Project postponed.' }, now);
    assert.equal(lead.status, 'LOST'); assert.equal(lead.lostReason, 'Project postponed.');
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status: 'NEGOTIATION' }, now), CRMError);
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status: 'WON' }, now), CRMError);
    assert.throws(() => applyAction(data, 'lead_save', { id: lead.id, title: lead.title, status: 'WON' }, now), CRMError);
    applyAction(data, 'lead_status', { id: lead.id, status: 'NEW' }, now);
    assert.equal(lead.status, 'NEW'); assert.equal(lead.lostReason, '');
    applyAction(data, 'lead_status', { id: lead.id, status: 'WON' }, now);
    assert.equal(lead.status, 'WON');
  }
});

test('Sales, Operations, Accountant and Viewer cannot use the dedicated lead status action', () => {
  for (const value of ['SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value); const before = structuredClone(lead);
    denied(() => applyAction(data, 'lead_status', { id: lead.id, status: 'CONTACTED' }, now));
    denied(() => applyAction(data, 'lead_status', { id: lead.id, status: 'WON' }, now));
    assert.deepEqual(lead, before);
  }
});

test('Sales lead edits cannot bypass status permission and omitted status keeps the current stage', () => {
  const { data, lead } = fixture();
  applyAction(data, 'lead_status', { id: lead.id, status: 'SITE_VISIT' }, now);
  role(data, 'SALES');
  const input = { id: lead.id, customerId: lead.customerId, title: lead.title };
  for (const status of ['NEW', 'CONTACTED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']) {
    denied(() => applyAction(data, 'lead_save', { ...input, status }, now));
    assert.equal(lead.status, 'SITE_VISIT');
  }
  applyAction(data, 'lead_save', { ...input, title: 'Updated details' }, now);
  assert.equal(lead.title, 'Updated details'); assert.equal(lead.status, 'SITE_VISIT');
  applyAction(data, 'lead_save', { ...input, status: 'SITE_VISIT' }, now);
  assert.equal(lead.status, 'SITE_VISIT');
});

test('Sales can create a New lead but cannot create a lead in another stage', () => {
  const { data, lead } = fixture(); role(data, 'SALES');
  const input = { customerId: lead.customerId, title: 'Another project' };
  denied(() => applyAction(data, 'lead_save', { ...input, status: 'CONTACTED' }, now));
  denied(() => applyAction(data, 'lead_save', { ...input, status: 'WON' }, now));
  applyAction(data, 'lead_save', input, now);
  assert.equal(data.leads.at(-1)!.status, 'NEW');
});

test('Owner and Manager can mark eligible leads Won without quotations through either lead action', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    for (const status of ['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION']) {
      for (const action of ['lead_status', 'lead_save']) {
        const { data, lead } = fixture(); role(data, value);
        applyAction(data, 'lead_status', { id: lead.id, status }, now);
        const customers = structuredClone(data.customers);
        applyAction(data, action, { id: lead.id, ...(action === 'lead_save' ? { title: lead.title } : {}), status: 'WON' }, now);
        assert.equal(lead.status, 'WON'); assert.equal(lead.lostReason, '');
        assert.deepEqual(data.customers, customers);
        assert.deepEqual(data.quotations, []); assert.equal(data.workorders.length, 1);
        assert.equal(data.workorders[0].leadId, lead.id); assert.equal(data.workorders[0].status, 'PLANNED');
        assert.equal(data.workorders[0].snapshot, null); assert.equal(data.workorders[0].quoteId, null);
        assert.deepEqual(data.sequences, { 'WO/2026-27': 1 });
        assert.equal(data.activity[0].action, action);
        assert.equal(data.activity[0].entityId, lead.id);
      }
    }
  }
});

test('Owner and Manager can create Won leads with automatic customer association and optional kW', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    const { data } = fixture(); role(data, value);
    applyAction(data, 'lead_save', { title: 'Already won project', contact: 'Actual contact', phone: '9876543210', status: 'WON', expectedKw: '8.5' }, now);
    const lead = data.leads.at(-1)!;
    assert.equal(lead.status, 'WON'); assert.equal(lead.expectedKw, 8.5); assert.equal(lead.email, '');
    assert.equal(data.customers.find(customer => customer.id === lead.customerId)!.name, 'Actual contact');
    assert.deepEqual(data.quotations, []); assert.equal(data.workorders.length, 1);
    assert.equal(data.workorders[0].leadId, lead.id); assert.equal(data.workorders[0].expectedKw, 8.5);
    assert.equal(data.workorders[0].snapshot, null); assert.equal(data.workorders[0].quoteId, null);
    assert.deepEqual(data.sequences, { 'WO/2026-27': 1 });
  }
});

test('manual Won remains terminal while lead details stay editable', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value);
    applyAction(data, 'lead_status', { id: lead.id, status: 'WON' }, now);
    for (const status of ['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'LOST']) {
      assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status, lostReason: 'Cannot reopen won lead' }, now), /won lead cannot be reopened/i);
      assert.throws(() => applyAction(data, 'lead_save', { id: lead.id, title: lead.title, status }, now), /won lead cannot be reopened/i);
    }
    applyAction(data, 'lead_save', { id: lead.id, title: 'Updated Won project', expectedKw: '11.25' }, now);
    assert.equal(lead.status, 'WON'); assert.equal(lead.title, 'Updated Won project'); assert.equal(lead.expectedKw, 11.25);
  }
});

test('authorized lead detail edits preserve status when the input omits it', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value);
    applyAction(data, 'lead_status', { id: lead.id, status: 'NEGOTIATION' }, now);
    applyAction(data, 'lead_save', { id: lead.id, customerId: lead.customerId, title: 'New project title' }, now);
    assert.equal(lead.status, 'NEGOTIATION'); assert.equal(lead.title, 'New project title');
  }
});

test('Contacted and Site visit change status and active assignee together, including same-stage Dealer assignment', () => {
  for (const roleName of ['OWNER', 'MANAGER'] as Role[]) {
    const { data, lead } = fixture(); role(data, roleName);
    applyAction(data, 'lead_status', { id: lead.id, status: 'CONTACTED', owner: 'test-SALES' }, now);
    assert.equal(lead.status, 'CONTACTED'); assert.equal(lead.owner, 'test-SALES');
    applyAction(data, 'lead_status', { id: lead.id, status: 'SITE_VISIT', owner: 'test-OPERATIONS' }, now);
    assert.equal(lead.status, 'SITE_VISIT'); assert.equal(lead.owner, 'test-OPERATIONS');
    applyAction(data, 'lead_status', { id: lead.id, status: 'SITE_VISIT', owner: 'test-DEALER' }, now);
    assert.equal(lead.owner, 'test-DEALER'); assert.match(data.activity[0].description, /assigned to DEALER/);
    applyAction(data, 'lead_status', { id: lead.id, status: 'SITE_VISIT', owner: '' }, now);
    assert.equal(lead.owner, '');
  }
});

test('omitted assignee preserves historical owners and explicit invalid assignments fail without changing the lead', () => {
  const { data, lead } = fixture(); lead.owner = 'historical-owner';
  applyAction(data, 'lead_status', { id: lead.id, status: 'CONTACTED' }, now); assert.equal(lead.owner, 'historical-owner');
  data.members.find(member => member.role === 'SALES')!.active = false;
  for (const owner of ['test-SALES', 'unknown-person', null, 12]) {
    const before = structuredClone(lead);
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status: 'SITE_VISIT', owner }, now), CRMError);
    assert.deepEqual(lead, before);
  }
  for (const status of ['NEW', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']) {
    const before = structuredClone(lead);
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status, owner: 'test-OPERATIONS', lostReason: 'Actual reason' }, now), CRMError);
    assert.deepEqual(lead, before);
  }
});
