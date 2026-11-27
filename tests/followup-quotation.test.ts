import assert from 'node:assert/strict';
import test from 'node:test';
import { followupQuotationPayload, getFollowupQuotationContext, savedHandoffQuotation } from '../lib/followup-quotation.ts';
import type { FollowUp, Quotation, WorkspaceData } from '../lib/types';

const task: FollowUp = { id: 'task', leadId: 'lead', title: 'Discuss scope', dueAt: '2026-11-27T06:00:00Z', channel: 'Call',
  owner: 'sales', notes: 'Keep genuine preparation', status: 'OPEN', outcome: '', isDemo: false, createdAt: '', updatedAt: '' };
function quote(id: string, overrides: Partial<Quotation> = {}): Quotation {
  return { id, leadId: 'lead', title: 'Same title', status: 'DRAFT', isDemo: false, createdAt: '2026-11-27T00:00:00Z', ...overrides } as Quotation;
}
function workspace(quotations: Quotation[]): WorkspaceData { return { quotations } as WorkspaceData; }

test('follow-up quotation references stay on the exact lead, scope and real/example boundary', () => {
  const original = quote('original', { status: 'ISSUED' }), newer = quote('newer', { createdAt: '2026-11-28T00:00:00Z' });
  const data = workspace([original, newer, quote('other', { leadId: 'other-lead' }), quote('example', { isDemo: true })]);
  const before = structuredClone(data);
  const context = getFollowupQuotationContext(data, { ...task, quoteId: 'original' });
  assert.equal(context.quotation, original); assert.deepEqual(context.quotations.map(row => row.id), ['newer', 'original']);
  for (const quoteId of [undefined, null, 'missing', 'other', 'example']) assert.equal(getFollowupQuotationContext(data, { ...task, quoteId }).quotation, null);
  assert.deepEqual(data, before);
});

test('saved quotations are located by exact returned identity and lead rather than reused titles', () => {
  const existing = quote('existing'), created = quote('created');
  const before = workspace([existing]), after = workspace([quote('foreign', { leadId: 'other-lead' }), created, existing]);
  assert.equal(savedHandoffQuotation(before, after, 'lead'), created);
  assert.equal(savedHandoffQuotation(before, after, 'lead', 'existing'), existing);
  assert.equal(savedHandoffQuotation(before, after, 'other-lead', 'existing'), null);
  assert.equal(savedHandoffQuotation(before, workspace([existing]), 'lead'), null);
  assert.equal(savedHandoffQuotation(before, workspace([created, quote('ambiguous')]), 'lead'), null);
});

test('linking a quotation preserves the saved follow-up details without changing its status or adding client authority', () => {
  assert.deepEqual(followupQuotationPayload(task, 'quote'), { id: 'task', leadId: 'lead', title: 'Discuss scope', dueAt: '2026-11-27T06:00:00Z',
    channel: 'Call', owner: 'sales', notes: 'Keep genuine preparation', quoteId: 'quote' });
});
