import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Role, WorkspaceData } from '../lib/types.ts';

const now = new Date('2026-11-24T06:00:00Z');
function fixture() {
  const members = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'VIEWER'] as Role[]).map(role => ({
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
    applyAction(data, 'lead_status', { id: lead.id, status: 'NEW' }, now);
    assert.equal(lead.status, 'NEW'); assert.equal(lead.lostReason, '');
    assert.throws(() => applyAction(data, 'lead_status', { id: lead.id, status: 'WON' }, now), CRMError);
  }
});

test('Sales, Operations and Viewer cannot use the dedicated lead status action', () => {
  for (const value of ['SALES', 'OPERATIONS', 'VIEWER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value); const before = structuredClone(lead);
    denied(() => applyAction(data, 'lead_status', { id: lead.id, status: 'CONTACTED' }, now));
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
  applyAction(data, 'lead_save', input, now);
  assert.equal(data.leads.at(-1)!.status, 'NEW');
});

test('authorized lead detail edits preserve status when the input omits it', () => {
  for (const value of ['OWNER', 'MANAGER'] as Role[]) {
    const { data, lead } = fixture(); role(data, value);
    applyAction(data, 'lead_status', { id: lead.id, status: 'NEGOTIATION' }, now);
    applyAction(data, 'lead_save', { id: lead.id, customerId: lead.customerId, title: 'New project title' }, now);
    assert.equal(lead.status, 'NEGOTIATION'); assert.equal(lead.title, 'New project title');
  }
});
