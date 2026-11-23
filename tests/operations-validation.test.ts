import assert from 'node:assert/strict';
import test from 'node:test';
import { operationsMonthSchema, operationsMutationSchema, scaledDecimal, teamActivityQuerySchema } from '../lib/operations-validation.ts';
import { TEAM_ACTIVITY_MODULES, type OperationsAction } from '../lib/operations-types.ts';

const RECORD = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const item = { sku: 'CEM-001', name: 'Cement', unit: 'bags' };
const expense = { expenseDate: '2026-11-23', title: 'Site transport', category: 'Travel', amount: '1250.50' };
const correction = { userId: OTHER, workDate: '2026-11-23', status: 'PRESENT', reason: 'Confirmed attendance with supervisor.' };

function request(action: OperationsAction, payload: unknown, extras: Record<string, unknown> = {}) {
  return { action, payload, expectedRevision: 3, requestId: 'ops-test-request-001', month: '2026-11', ...extras };
}
function valid(action: OperationsAction, payload: unknown) {
  const parsed = operationsMutationSchema.safeParse(request(action, payload));
  assert.equal(parsed.success, true, parsed.success ? undefined : JSON.stringify(parsed.error.issues));
  return operationsMutationSchema.parse(request(action, payload));
}
function invalid(action: OperationsAction, payload: unknown, description: string) {
  assert.equal(operationsMutationSchema.safeParse(request(action, payload)).success, false, description);
}

test('all operations actions accept valid inputs and normalize optional text without inventing identity', () => {
  const examples: [OperationsAction, Record<string, unknown>][] = [
    ['stock_item_save', item], ['stock_item_active', { id: RECORD, active: false }],
    ['stock_move', { itemId: RECORD, type: 'IN', quantity: '2.500' }],
    ['attendance_check_in', {}], ['attendance_check_out', {}],
    ['attendance_correct', correction], ['expense_save', expense],
    ['expense_withdraw', { id: RECORD }], ['expense_review', { id: RECORD, status: 'APPROVED' }],
  ];
  for (const [action, payload] of examples) valid(action, payload);
  const parsedItem = valid('stock_item_save', { ...item, sku: ' CEM-001 ', name: ' Cement ', unit: ' bags ' });
  assert.equal(parsedItem.action, 'stock_item_save');
  if (parsedItem.action === 'stock_item_save') {
    assert.deepEqual(parsedItem.payload, { ...item, location: '', minQuantity: '0', openingQuantity: '0' });
  }
  assert.deepEqual(valid('attendance_check_in', {}).payload, { site: '', notes: '' });
  assert.deepEqual(valid('attendance_check_out', {}).payload, {});
});

test('mutation envelope rejects untrusted authority, invalid revisions, unsafe request IDs and unknown actions', () => {
  const base = request('expense_save', expense);
  for (const [key, value] of Object.entries({ actorId: OTHER, userId: OTHER, role: 'OWNER', admin: true, permissions: { admin: true } })) {
    assert.equal(operationsMutationSchema.safeParse({ ...base, [key]: value }).success, false, `forged ${key}`);
  }
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '3', null]) {
    assert.equal(operationsMutationSchema.safeParse({ ...base, expectedRevision }).success, false, `revision ${String(expectedRevision)}`);
  }
  for (const requestId of ['', 'short', 'has space here', 'slash/path', 'request\nnewline', 'x'.repeat(121), 123456789]) {
    assert.equal(operationsMutationSchema.safeParse({ ...base, requestId }).success, false, `requestId ${String(requestId)}`);
  }
  for (const invalidRequest of [{ ...base, action: 'expense_delete' }, { ...base, payload: null }, { ...base, payload: [] }, { ...base, month: '2026-13' }]) {
    assert.equal(operationsMutationSchema.safeParse(invalidRequest).success, false);
  }
  for (const key of ['action', 'payload', 'expectedRevision', 'requestId', 'month']) {
    const missing: Record<string, unknown> = { ...base }; delete missing[key];
    assert.equal(operationsMutationSchema.safeParse(missing).success, false, `missing ${key}`);
  }
  assert.equal(operationsMutationSchema.safeParse({ ...base, expectedRevision: 0, requestId: 'a'.repeat(120) }).success, true);
});

test('every mutation payload rejects fields that could forge ownership, stock balances or expense approval', () => {
  const forbidden: [OperationsAction, Record<string, unknown>, Record<string, unknown>][] = [
    ['stock_item_save', item, { createdBy: OTHER }],
    ['stock_item_save', item, { quantityMilli: 100000 }],
    ['stock_item_active', { id: RECORD, active: true }, { role: 'OWNER' }],
    ['stock_move', { itemId: RECORD, type: 'IN', quantity: '1' }, { actorId: OTHER }],
    ['stock_move', { itemId: RECORD, type: 'IN', quantity: '1' }, { balanceAfterMilli: 100000 }],
    ['attendance_check_in', {}, { userId: OTHER }],
    ['attendance_check_in', {}, { checkIn: '2026-11-23T09:00:00+05:30' }],
    ['attendance_check_in', {}, { workDate: '2026-11-22' }],
    ['attendance_check_out', {}, { id: RECORD }],
    ['attendance_check_out', {}, { checkOut: '2026-11-23T18:00:00+05:30' }],
    ['attendance_correct', correction, { source: 'SELF' }],
    ['expense_save', expense, { userId: OTHER }],
    ['expense_save', expense, { status: 'APPROVED' }],
    ['expense_save', expense, { amountPaise: 1 }],
    ['expense_save', expense, { reviewedBy: OTHER }],
    ['expense_save', expense, { expenseSummary: { paidPaise: '100' } }],
    ['expense_withdraw', { id: RECORD }, { userId: OTHER }],
    ['expense_review', { id: RECORD, status: 'APPROVED' }, { reviewedBy: OTHER }],
    ['expense_review', { id: RECORD, status: 'APPROVED' }, { amount: '0.01' }],
  ];
  for (const [action, payload, extra] of forbidden) invalid(action, { ...payload, ...extra }, `${action}: ${Object.keys(extra)[0]}`);
});

test('decimal validation preserves exact paise and thousandths at the supported limits', () => {
  assert.equal(scaledDecimal('0.001', 3), 1n);
  assert.equal(scaledDecimal('1.010', 3), 1010n);
  assert.equal(scaledDecimal('0.01', 2), 1n);
  assert.equal(scaledDecimal('1.10', 2), 110n);
  assert.equal(scaledDecimal('9000000000', 3), 9_000_000_000_000n);
  assert.equal(scaledDecimal('90000000000', 2), 9_000_000_000_000n);
  for (const quantity of ['0.001', '1.010', '9000000000.000']) valid('stock_move', { itemId: RECORD, type: 'IN', quantity });
  for (const amount of ['0.01', '1.10', '90000000000.00']) valid('expense_save', { ...expense, amount });
  invalid('stock_move', { itemId: RECORD, type: 'IN', quantity: '9000000000.001' }, 'one thousandth over stock limit');
  invalid('expense_save', { ...expense, amount: '90000000000.01' }, 'one paise over expense limit');
});

test('numbers, exponential notation, currency formatting, signed and over-precision decimals are rejected', () => {
  const values: unknown[] = [1, null, true, '', '-1', '+1', '1e3', 'Infinity', 'NaN', '1,000', '₹10', '.5', '1.', '1 2', '1\n2', '9'.repeat(31)];
  for (const value of values) {
    invalid('stock_move', { itemId: RECORD, type: 'IN', quantity: value }, `quantity ${String(value)}`);
    invalid('expense_save', { ...expense, amount: value }, `amount ${String(value)}`);
  }
  invalid('stock_move', { itemId: RECORD, type: 'IN', quantity: '1.0001' }, 'four decimal stock places');
  invalid('expense_save', { ...expense, amount: '1.001' }, 'three decimal money places');
  invalid('expense_save', { ...expense, amount: '0' }, 'zero expense');
  valid('stock_move', { itemId: RECORD, type: 'IN', quantity: ' 1.125 ' });
});

test('stock corrections require a reason and only corrections may set a balance to zero', () => {
  for (const type of ['IN', 'OUT']) {
    for (const quantity of ['0', '0.000']) invalid('stock_move', { itemId: RECORD, type, quantity }, `${type} zero`);
  }
  valid('stock_move', { itemId: RECORD, type: 'ADJUST', quantity: '0', note: 'Confirmed empty during site count.' });
  for (const note of [undefined, '', '   ']) invalid('stock_move', { itemId: RECORD, type: 'ADJUST', quantity: '2', note }, 'adjustment without a reason');
  invalid('stock_move', { itemId: RECORD, type: 'TRANSFER', quantity: '1' }, 'unknown movement type');
});

test('existing stock items cannot smuggle an opening balance and required fields have bounded lengths', () => {
  valid('stock_item_save', { ...item, id: RECORD, openingQuantity: '0.000', minQuantity: '0' });
  invalid('stock_item_save', { ...item, id: RECORD, openingQuantity: '0.001' }, 'opening quantity on edit');
  for (const field of ['sku', 'name', 'unit']) invalid('stock_item_save', { ...item, [field]: '   ' }, `empty ${field}`);
  for (const [field, maximum] of [['sku', 64], ['name', 200], ['unit', 24], ['location', 200]] as const) {
    valid('stock_item_save', { ...item, [field]: 'x'.repeat(maximum) });
    invalid('stock_item_save', { ...item, [field]: 'x'.repeat(maximum + 1) }, `oversized ${field}`);
  }
  invalid('stock_item_save', { ...item, minQuantity: '-0.001' }, 'negative minimum');
  invalid('stock_item_save', { ...item, openingQuantity: '9000000000.001' }, 'opening limit');
  invalid('stock_item_active', { id: RECORD, active: 'false' }, 'string boolean');
  invalid('stock_item_active', { id: 'not-a-uuid', active: false }, 'invalid UUID');
});

test('months and expense dates require real unambiguous calendar values', () => {
  for (const month of ['0001-01', '2024-02', '2026-11', '9999-12']) assert.equal(operationsMonthSchema.safeParse(month).success, true, month);
  for (const month of ['0000-01', '2026-00', '2026-13', '2026-1', '26-11', '2026-11-01', ' 2026-11', '2026-11\n', 202611]) {
    assert.equal(operationsMonthSchema.safeParse(month).success, false, String(month));
  }
  for (const expenseDate of ['2024-02-29', '2026-11-30', '2026-12-31']) valid('expense_save', { ...expense, expenseDate });
  for (const expenseDate of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-11-00', '0000-01-01', '2026-1-01', '2026-11-23T00:00:00Z', '2026-11-23 ', '2026-11-23\n']) {
    invalid('expense_save', { ...expense, expenseDate }, `invalid date ${expenseDate}`);
    invalid('attendance_correct', { ...correction, workDate: expenseDate }, `invalid attendance date ${expenseDate}`);
  }
  // Whether a real date is future-dated is decided from the database's IST clock.
});

test('attendance correction requires explicit reasons and rejects impossible status/time combinations', () => {
  for (const status of ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE']) valid('attendance_correct', { ...correction, status });
  for (const reason of [undefined, '', '   ', 'x'.repeat(2001)]) invalid('attendance_correct', { ...correction, reason }, 'missing or oversized correction reason');
  for (const status of ['ABSENT', 'LEAVE']) {
    invalid('attendance_correct', { ...correction, status, checkIn: '2026-11-23T09:00:00+05:30' }, 'absent/leave with check-in');
    invalid('attendance_correct', { ...correction, status, checkOut: '2026-11-23T18:00:00+05:30' }, 'absent/leave with check-out');
  }
  invalid('attendance_correct', { ...correction, checkOut: '2026-11-23T18:00:00+05:30' }, 'checkout without checkin');
  for (const checkOut of ['2026-11-23T09:00:00+05:30', '2026-11-23T08:59:59+05:30']) {
    invalid('attendance_correct', { ...correction, checkIn: '2026-11-23T09:00:00+05:30', checkOut }, 'checkout must be later than checkin');
  }
  invalid('attendance_correct', { ...correction, status: 'HOLIDAY' }, 'unknown attendance status');
});

test('attendance uses the check-in date in India time and permits a later overnight checkout', () => {
  valid('attendance_correct', { ...correction, checkIn: '2026-11-22T18:30:00Z', checkOut: '2026-11-23T03:30:00Z' });
  valid('attendance_correct', { ...correction, checkIn: '2026-11-23T22:00:00+05:30', checkOut: '2026-11-24T06:00:00+05:30' });
  invalid('attendance_correct', { ...correction, checkIn: '2026-11-22T18:29:59Z' }, 'one second before IST work date');
  invalid('attendance_correct', { ...correction, checkIn: '2026-11-23T18:30:00Z' }, 'next date in IST');
  valid('attendance_correct', { ...correction, checkIn: null, checkOut: null });
});

test('attendance timestamps must be actual ISO instants with an explicit time zone', () => {
  for (const checkIn of [
    '2026-11-23T09:00:00', '2026-11-23', 'not-a-date', '2026-02-30T09:00:00Z',
    '2026-11-23T25:00:00Z', '2026-11-23T09:60:00Z', '2026-11-23T09:00:00+24:00',
    '2026-11-23T09:00:00+05:99', 1795424400000,
  ]) invalid('attendance_correct', { ...correction, checkIn }, `invalid timestamp ${String(checkIn)}`);
});

test('expense entry cannot supply a review status and review actions accept only deliberate transitions', () => {
  for (const category of ['Materials', 'Travel', 'Labour', 'Equipment', 'Food', 'Other']) valid('expense_save', { ...expense, category });
  invalid('expense_save', { ...expense, category: 'Payroll' }, 'unknown category');
  invalid('expense_save', { ...expense, title: '   ' }, 'blank expense title');
  invalid('expense_save', { ...expense, notes: 'x'.repeat(2001) }, 'oversized expense note');
  for (const status of ['APPROVED', 'PAID']) valid('expense_review', { id: RECORD, status });
  valid('expense_review', { id: RECORD, status: 'REJECTED', note: 'Please include the bill reference.' });
  for (const note of [undefined, '', '  ']) invalid('expense_review', { id: RECORD, status: 'REJECTED', note }, 'rejection without a reason');
  for (const status of ['SUBMITTED', 'WITHDRAWN', 'DELETED', 'approved']) invalid('expense_review', { id: RECORD, status }, `invalid review status ${status}`);
  // Current role, ownership and legal persisted-state transitions are enforced by
  // the SQL RPC, not by a role or status asserted in the request body.
});

test('team activity filters default to all employees, all modules and page one without selecting the actor', () => {
  assert.deepEqual(teamActivityQuerySchema.parse({ month: '2026-11' }), { month: '2026-11', module: 'all', page: 1 });
  for (const activityModule of TEAM_ACTIVITY_MODULES) {
    assert.deepEqual(teamActivityQuerySchema.parse({ month: '2026-11', employeeId: OTHER, module: activityModule, page: '2' }),
      { month: '2026-11', employeeId: OTHER, module: activityModule, page: 2 });
  }
});

test('team activity queries reject caller identity, role, raw offset and unrecognized filter fields', () => {
  const base = { month: '2026-11', employeeId: OTHER, module: 'expenses', page: '1' };
  for (const [field, value] of Object.entries({ actorId: OTHER, userId: OTHER, p_actor_id: OTHER, role: 'OWNER', admin: true, offset: '100', pageSize: '5000', fullAudit: 'true' })) {
    assert.equal(teamActivityQuerySchema.safeParse({ ...base, [field]: value }).success, false, `forged query field ${field}`);
  }
  for (const activityModule of ['audit', 'all,expenses', 'EXPENSES', ' expenses ', '', null, ['stock', 'expenses']]) {
    assert.equal(teamActivityQuerySchema.safeParse({ ...base, module: activityModule }).success, false, `module ${String(activityModule)}`);
  }
});

test('team activity employee/month filters are explicit UUIDs and calendar months', () => {
  const base = { month: '2026-11' };
  for (const employeeId of ['', 'all', 'another@example.invalid', '../owner', `${OTHER} `, 'not-a-uuid', null, [OTHER]]) {
    assert.equal(teamActivityQuerySchema.safeParse({ ...base, employeeId }).success, false, `employee ${String(employeeId)}`);
  }
  for (const month of ['2026-00', '2026-13', '0000-01', '2026-1', '2026-11-23', '2026-11 ', null]) {
    assert.equal(teamActivityQuerySchema.safeParse({ month }).success, false, `month ${String(month)}`);
  }
  assert.equal(teamActivityQuerySchema.safeParse({}).success, false, 'server must supply its default IST month before validation');
});

test('team activity pagination accepts bounded canonical positive integers and rejects coercion tricks', () => {
  for (const [page, expected] of [['1', 1], ['9999', 9999], ['10000', 10000]] as const) {
    assert.equal(teamActivityQuerySchema.parse({ month: '2026-11', page }).page, expected);
  }
  for (const page of ['', '0', '-1', '+1', '01', '1.0', '1.5', '1e3', ' 1', '1 ', '1\n', '10001', '99999', '100000', 'Infinity', 1, null, ['1']]) {
    assert.equal(teamActivityQuerySchema.safeParse({ month: '2026-11', page }).success, false, `page ${String(page)}`);
  }
});
