import assert from 'node:assert/strict';
import test from 'node:test';
import { operationsMutationSchema } from '../lib/operations-validation.ts';
import { REQUIRED_QUOTE_CATEGORIES } from '../lib/quotation-categories.ts';

const envelope = { expectedRevision: 12, requestId: 'confirmed-job-material-use', month: '2026-11' };
const payload = {
  workOrderId: 'work-order-123', category: 'Panels',
  itemId: '10000000-0000-4000-8000-000000000001', siteId: '20000000-0000-4000-8000-000000000002', quantity: '1.250',
};
function parse(input: unknown = payload) { return operationsMutationSchema.safeParse({ ...envelope, action: 'job_material_issue', payload: input }); }

test('job material requests accept every category, including optional Filing usage, with precise stock quantities', () => {
  for (const category of REQUIRED_QUOTE_CATEGORIES) {
    const result = parse({ ...payload, category, quantity: ' 1.250 ' });
    assert.ok(result.success);
    assert.equal(result.data.action, 'job_material_issue');
    if (result.data.action === 'job_material_issue') assert.deepEqual(result.data.payload, { ...payload, category });
  }
  for (const quantity of ['0.001', '1', '9000000000.000']) assert.ok(parse({ ...payload, quantity }).success);
});

test('job material quantities reject zero, negatives, imprecise values and overflow', () => {
  for (const quantity of ['0', '0.000', '-1', '+1', '.5', '1.0001', '1e3', '1,000', 'NaN', 'Infinity', '9000000000.001', 1, null, true, '']) {
    assert.equal(parse({ ...payload, quantity }).success, false, String(quantity));
  }
});

test('job material requests cannot choose arbitrary categories or inject stock, completion or actor fields', () => {
  for (const category of ['AC Wire', 'Lighting Rod', 'Other', '', null, 1]) assert.equal(parse({ ...payload, category }).success, false);
  for (const extra of [
    { actorId: payload.itemId }, { actorName: 'Administrator' }, { role: 'OWNER' }, { movementId: payload.itemId },
    { quantityMilli: 1250 }, { returnedMilli: '0' }, { balanceAfterMilli: 99 }, { completed: true }, { status: 'DONE' },
    { confirmed: true }, { reference: 'Forged stock document' },
  ]) assert.equal(parse({ ...payload, ...extra }).success, false);
  for (const key of ['workOrderId', 'category', 'itemId', 'siteId', 'quantity']) {
    const missing: Record<string, unknown> = { ...payload }; delete missing[key];
    assert.equal(parse(missing).success, false, key);
  }
  for (const change of [{ itemId: 'bad' }, { siteId: 'bad' }, { workOrderId: '../other' }, { workOrderId: '' }]) assert.equal(parse({ ...payload, ...change }).success, false);
});

test('Filing completion accepts only a work-order identity and cannot manufacture a stock issue', () => {
  const complete = (value: unknown) => operationsMutationSchema.safeParse({ ...envelope, action: 'job_filing_complete', payload: value });
  assert.ok(complete({ workOrderId: payload.workOrderId }).success);
  for (const extra of [{ category: 'Filing' }, { itemId: payload.itemId }, { siteId: payload.siteId }, { quantity: '1' }, { movementId: payload.itemId }, { completedAt: '2026-11-27' }, { actorId: payload.itemId }]) {
    assert.equal(complete({ workOrderId: payload.workOrderId, ...extra }).success, false);
  }
  assert.equal(complete({}).success, false);
  assert.equal(complete({ workOrderId: null }).success, false);
});
