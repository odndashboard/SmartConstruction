import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyAction, CRMError } from '../lib/server-actions.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Member, Role, WorkspaceData } from '../lib/types.ts';

const NOW = new Date('2026-11-27T06:00:00Z');
function workspace(role: Role = 'OWNER'): WorkspaceData {
  const members: Member[] = (['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]).map(value => ({
    userId: `test-${value.toLowerCase()}`, name: `Test ${value}`, email: `${value.toLowerCase()}@example.invalid`, role: value, active: true,
  }));
  return {
    revision: 1, company: { ...DEFAULT_COMPANY, legalName: 'Test Supplier', address: 'Test supplier address', gstin: '06ABCDE1234F1Z5', stateCode: '06' },
    user: { ...members.find(member => member.role === role)! }, members,
    customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {},
  };
}
function act(data: WorkspaceData, action: string, payload: unknown): string {
  return applyAction(data, action, payload, NOW);
}

describe('lead enquiry entry without customer selection', () => {
  test('creates an associated customer from the supplied contact and phone without requiring email', () => {
    const data = workspace();
    act(data, 'lead_save', { title: 'Rooftop installation', contact: '  Test Contact  ', phone: '  9876543210  ', expectedKw: '10.5', stateCode: '06' });
    const lead = data.leads[0]; const customer = data.customers[0];
    assert.equal(data.leads.length, 1); assert.equal(data.customers.length, 1);
    assert.equal(lead.customerId, customer.id);
    assert.equal(lead.expectedKw, 10.5);
    assert.equal(lead.email, ''); assert.equal(customer.email, '');
    assert.equal(customer.name, 'Test Contact'); assert.equal(customer.contact, 'Test Contact');
    assert.equal(customer.phone, '9876543210'); assert.equal(customer.stateCode, '06');
    assert.equal(customer.address, ''); assert.equal(customer.gstin, '');
    assert.equal(customer.isDemo, false); assert.equal(lead.isDemo, false);
  });

  test('uses the actual project title when contact is blank and leaves unknown contact details blank', () => {
    const data = workspace();
    act(data, 'lead_save', { title: 'Warehouse rooftop' });
    assert.equal(data.customers[0].name, 'Warehouse rooftop');
    assert.equal(data.customers[0].contact, ''); assert.equal(data.customers[0].phone, '');
    assert.equal(data.customers[0].email, ''); assert.equal(data.leads[0].expectedKw, null);
  });

  test('preserves explicit existing associations and historical email during edits with hidden fields omitted', () => {
    const data = workspace();
    act(data, 'customer_save', { name: 'Existing customer', email: 'billing@example.invalid', address: 'Existing billing address', phone: '9876543210' });
    const customer = structuredClone(data.customers[0]);
    act(data, 'lead_save', { customerId: customer.id, title: 'Original project', email: 'historical@example.invalid', expectedKw: 8.75 });
    const id = data.leads[0].id;
    act(data, 'lead_save', { id, title: 'Updated project', expectedKw: '12.25' });
    assert.equal(data.leads[0].customerId, customer.id);
    assert.equal(data.leads[0].email, 'historical@example.invalid');
    assert.equal(data.leads[0].expectedKw, 12.25);
    assert.deepEqual(data.customers, [customer]);
    const reloaded: WorkspaceData = JSON.parse(JSON.stringify(data));
    act(reloaded, 'lead_save', { id, title: 'Later edit without kW' });
    assert.equal(reloaded.leads[0].expectedKw, 12.25);
    assert.equal(reloaded.leads[0].email, 'historical@example.invalid');
    assert.equal(reloaded.leads[0].customerId, customer.id);
    act(reloaded, 'lead_save', { id, title: 'Cleared optional kW', expectedKw: '' });
    assert.equal(reloaded.leads[0].expectedKw, null);
    assert.equal(reloaded.leads[0].email, 'historical@example.invalid');
    assert.equal(reloaded.customers.length, 1);
  });

  test('preserves historical leads without a kW property and never creates another customer on edit', () => {
    const data = workspace();
    act(data, 'lead_save', { title: 'Historical project', email: 'saved@example.invalid' });
    delete data.leads[0].expectedKw;
    const customerId = data.leads[0].customerId;
    act(data, 'lead_save', { id: data.leads[0].id, title: 'Historical project edited', expectedKw: 0 });
    assert.equal(data.leads[0].expectedKw, 0); assert.equal(data.leads[0].email, 'saved@example.invalid');
    assert.equal(data.leads[0].customerId, customerId); assert.equal(data.customers.length, 1);
  });

  test('allows optional, zero and decimal kW and stores only numbers or null', () => {
    for (const [input, expected] of [[undefined, null], [null, null], ['', null], ['  ', null], [0, 0], ['0', 0], [2.125, 2.125], [' 10.5 ', 10.5], ['.25', 0.25]] as const) {
      const data = workspace();
      act(data, 'lead_save', { title: 'Numeric input', expectedKw: input });
      assert.equal(data.leads[0].expectedKw, expected);
      assert.equal(JSON.parse(JSON.stringify(data)).leads[0].expectedKw, expected);
    }
  });

  test('rejects negative, nonnumeric, coerced and nonfinite kW without creating records', () => {
    for (const input of [-1, '-0.1', 'ten', '10 kW', '1e3', '0x10', '1,000', '+5', '--1', '.', 'NaN', NaN, Infinity, -Infinity, true, false, [], {}, '9'.repeat(400)]) {
      const data = workspace(); const before = structuredClone(data);
      assert.throws(() => act(data, 'lead_save', { title: 'Invalid input', expectedKw: input }), CRMError, String(input));
      assert.deepEqual(data, before);
    }
  });

  test('failed lead validation leaves no orphan customer and preserves role restrictions', () => {
    for (const payload of [{ title: 'Bad amount', value: '-1' }, { title: 'Unknown owner', owner: 'missing' }, { title: 'Invalid stage', status: 'LOST' }]) {
      const data = workspace(); const before = structuredClone(data);
      assert.throws(() => act(data, 'lead_save', payload), CRMError);
      assert.deepEqual(data, before);
    }
    for (const role of ['OWNER', 'MANAGER', 'SALES'] as Role[]) {
      const data = workspace(role); act(data, 'lead_save', { title: `${role} enquiry`, expectedKw: 5.5 });
      assert.equal(data.leads[0].expectedKw, 5.5); assert.equal(data.leads[0].status, 'NEW');
    }
    for (const role of ['OPERATIONS', 'ACCOUNTANT', 'VIEWER'] as Role[]) {
      const data = workspace(role); const before = structuredClone(data);
      assert.throws(() => act(data, 'lead_save', { title: 'Not permitted', expectedKw: 5 }), error => error instanceof CRMError && error.status === 403);
      assert.deepEqual(data, before);
    }
    const sales = workspace('SALES');
    assert.throws(() => act(sales, 'lead_save', { title: 'Status bypass', status: 'CONTACTED' }), error => error instanceof CRMError && error.status === 403);
    assert.equal(sales.customers.length, 0);
  });

  test('new enquiries retain the quotation and work-order workflow without an email', () => {
    const data = workspace();
    act(data, 'lead_save', { title: 'Solar project', contact: 'Site contact', phone: '9876543210', expectedKw: '10.5', siteAddress: 'Project site', stateCode: '06' });
    const lead = data.leads[0]; const customer = data.customers[0];
    act(data, 'quote_save', { leadId: lead.id, title: 'Installation scope', validUntil: '2026-12-27', placeOfSupply: '06', siteAddress: 'Project site', items: [
      { id: 'item', description: 'Installation', hsnSac: '9954', quantity: '1', unit: 'job', unitPrice: '1000', gstRate: '18' },
    ] });
    const quote = data.quotations[0];
    assert.throws(() => act(data, 'quote_issue', { id: quote.id }), /billing address/i);
    act(data, 'customer_save', { id: customer.id, name: customer.name, contact: customer.contact, phone: customer.phone, address: 'Confirmed billing address', stateCode: '06' });
    act(data, 'quote_issue', { id: quote.id });
    assert.equal(quote.customer!.id, lead.customerId); assert.equal(quote.customer!.email, '');
    assert.equal(quote.totals.total, 118000);
    act(data, 'quote_accept', { id: quote.id, acceptanceNote: 'Customer approved the written quotation.' });
    act(data, 'quote_convert', { id: quote.id });
    assert.equal(lead.status, 'WON'); assert.equal(lead.expectedKw, 10.5);
    assert.equal(data.workorders.length, 1); assert.deepEqual(data.workorders[0].snapshot, quote);
    const frozen = structuredClone(data.workorders[0]);
    act(data, 'lead_save', { id: lead.id, title: 'Updated project details', expectedKw: '12.75' });
    assert.equal(lead.expectedKw, 12.75); assert.equal(lead.customerId, customer.id);
    assert.deepEqual(data.workorders[0], frozen); assert.equal(data.customers.length, 1);
    act(data, 'customer_save', { name: 'Other customer', address: 'Other address' });
    assert.throws(() => act(data, 'lead_save', { id: lead.id, title: lead.title, customerId: data.customers.at(-1)!.id }), /issued quotations/);
  });
});
