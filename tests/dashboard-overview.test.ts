import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDashboardOverview } from '../lib/dashboard-overview.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Customer, FollowUp, Lead, Member, Quotation, Role, WorkOrder, WorkspaceData } from '../lib/types';
import type { Expense, ExpenseTotals, OperationsData, StockItem } from '../lib/operations-types';
import type { AttendanceSummary, ExtendedAttendanceRecord, MaterialRequest, PaymentAccount, PurchaseOrder } from '../lib/operations-extensions';

const now = new Date('2026-11-24T04:30:00Z'); // 10:00 IST
const owner: Member = { userId: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'OWNER', active: true };
const employee: Member = { userId: 'employee', name: 'Employee', email: 'employee@example.invalid', role: 'OPERATIONS', active: true };
const removed: Member = { userId: 'removed', name: 'Former employee', email: 'former@example.invalid', role: 'SALES', active: false };
const emptyTotals: ExpenseTotals = { count: 0, submittedPaise: '0', approvedPaise: '0', paidPaise: '0', rejectedPaise: '0', withdrawnPaise: '0' };
const shift = { configured: false, startLocal: null, endLocal: null, overnight: false, breakMinutes: 0, graceMinutes: 0, version: 0 };

function workspace(user = owner): WorkspaceData {
  return { revision: 0, company: { ...DEFAULT_COMPANY }, user: { ...user }, members: [{ ...owner }, { ...employee }, { ...removed }],
    customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {} };
}
function operations(user = owner): OperationsData {
  return { revision: 0, month: '2026-11', today: '2026-11-24', serverTime: now.toISOString(), user: { ...user },
    permissions: { admin: user.role === 'OWNER', canWrite: user.role !== 'VIEWER' }, stockItems: [], stockMovements: [], attendance: [],
    myTodayAttendance: null, myOpenAttendance: null, expenses: [],
    expenseSummary: user.role === 'OWNER' ? { month: { ...emptyTotals }, allTime: { ...emptyTotals } } : null,
    counts: { stockMovements: 0, attendance: 0, expenses: 0 }, historyLimit: 500,
    extension: { sites: [], assignments: [], shiftRule: { ...shift }, attendanceCalendar: [], attendanceSummary: [],
      siteBalances: [], transfers: [], returns: [], materialRequests: [], expenseReceipts: [],
      purchaseOrders: user.role === 'OWNER' ? [] : null, paymentAccounts: user.role === 'OWNER' ? [] : null,
      paymentInstallments: user.role === 'OWNER' ? [] : null, customerPayments: user.role === 'OWNER' ? [] : null } };
}
function lead(id: string, status: Lead['status'] = 'NEW', value = 12345): Lead {
  return { id, status, value, customerId: 'customer', title: id, contact: '', phone: '', email: '', location: '', siteAddress: '', stateCode: '',
    source: '', owner: owner.userId, priority: 'Medium', notes: '', lostReason: '', isDemo: false, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function followup(id: string, dueAt: string, status: FollowUp['status'] = 'OPEN'): FollowUp {
  return { id, leadId: 'lead', title: id, dueAt, status, channel: 'Call', owner: owner.userId, notes: '', outcome: '', isDemo: false,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function quote(id: string, status: Quotation['status'] = 'ISSUED', validUntil = '2026-11-24', total = 98765): Quotation {
  return { id, status, validUntil, leadId: 'lead', number: id, title: id, placeOfSupply: '', siteAddress: '', terms: '', items: [],
    totals: { subtotal: total, discount: 0, taxable: total, cgst: 0, sgst: 0, utgst: 0, igst: 0, total, mode: 'IGST', needsConfig: false },
    revision: 1, acceptanceNote: '', isDemo: false, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function workOrder(id: string, status: WorkOrder['status']): WorkOrder {
  return { id, status, quoteId: 'quote', number: id, title: id, customerName: '', siteAddress: '', owner: owner.userId, startDate: '', endDate: '',
    snapshot: quote('quote'), milestones: [], isDemo: false, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function attendance(userId: string, patch: Partial<ExtendedAttendanceRecord> = {}): ExtendedAttendanceRecord {
  return { id: userId, userId, memberName: userId, workDate: '2026-11-24', status: 'PRESENT', checkIn: '2026-11-24T03:30:00Z', checkOut: null,
    site: 'Site A', siteId: 'site-a', shiftSnapshot: { ...shift }, notes: '', source: 'SELF', updatedAt: now.toISOString(),
    metrics: { elapsedMinutes: null, workedMinutes: null, expectedMinutes: null, lateMinutes: null, eligibleOvertimeMinutes: null,
      approvedOvertimeMinutes: 0, overtimeReason: '', overtimeReviewedBy: null, overtimeReviewedAt: null }, ...patch };
}
function summary(userId: string, workedMinutes = 480): AttendanceSummary {
  return { userId, memberName: userId, recordedDays: 1, presentDays: 1, halfDays: 0, absentDays: 0, leaveDays: 0, openShifts: 0,
    workedMinutes, lateDays: 0, eligibleOvertimeMinutes: 60, approvedOvertimeMinutes: 30 };
}
function expense(userId: string): Expense {
  return { id: `expense-${userId}`, userId, memberName: userId, expenseDate: '2026-11-24', title: 'Receipt', category: 'Materials',
    amountPaise: 100, site: '', reference: '', notes: '', status: 'SUBMITTED', reviewNote: '', reviewedBy: null, reviewedAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function stock(id: string, quantityMilli: number, minQuantityMilli: number, unit: string, active = true): StockItem {
  return { id, sku: id, name: id, quantityMilli, minQuantityMilli, unit, active, location: '', receivedMilli: '10000', usedMilli: '0',
    adjustedMilli: '0', returnedMilli: '0', createdBy: owner.userId, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function request(id: string, userId: string, status: MaterialRequest['status']): MaterialRequest {
  return { id, userId, memberName: userId, status, siteId: 'site-a', itemId: 'material', quantityMilli: 10000, fulfilledMilli: 0, neededOn: null,
    note: '', reviewNote: '', reviewedBy: null, reviewedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
function purchase(id: string, status: PurchaseOrder['status'], expectedOn: string | null): PurchaseOrder {
  return { id, status, expectedOn, number: id, supplier: 'Supplier', siteId: 'site-a', reference: '', notes: '', cancelReason: '', lines: [],
    createdAt: now.toISOString(), updatedAt: now.toISOString() };
}

test('overview includes every core module with actionable state and India-day boundaries', () => {
  const data = workspace();
  data.leads = [lead('open'), lead('won', 'WON'), lead('lost', 'LOST'), lead('negotiating', 'NEGOTIATION', 50)];
  data.followups = [followup('midnight', '2026-11-23T18:30:00Z'), followup('last-minute-yesterday', '2026-11-23T18:29:59Z'),
    followup('later-today', '2026-11-24T18:29:59Z'), followup('tomorrow', '2026-11-24T18:30:00Z'),
    followup('done', '2026-11-24T03:00:00Z', 'DONE'), followup('cancelled', '2026-11-24T03:00:00Z', 'CANCELLED')];
  data.quotations = [quote('today'), quote('future', 'ISSUED', '2026-12-01'), quote('expired', 'ISSUED', '2026-11-23'), quote('draft', 'DRAFT')];
  data.workorders = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'].map((status, i) => workOrder(String(i), status as WorkOrder['status']));
  data.customers = [{ id: 'customer' } as Customer];
  const result = buildDashboardOverview(data, null, now);
  assert.equal(result.today, '2026-11-24');
  assert.deepEqual(result.core, { openLeads: 2, pipelinePaise: '12395', followupsToday: 2, overdueFollowups: 2,
    pendingQuotations: 2, pendingQuotationPaise: '197530', activeWorkOrders: 3, completedWorkOrders: 1, customers: 1 });
  assert.equal(result.operations, null);
});

test('financial overview preserves totals larger than the JavaScript safe integer range', () => {
  const data = workspace(), ops = operations();
  data.leads = Array.from({ length: 1100 }, (_, i) => lead(String(i), 'NEW', 9_000_000_000_000));
  data.quotations = Array.from({ length: 1100 }, (_, i) => quote(String(i), 'ISSUED', '2026-12-01', 9_000_000_000_000));
  const account: PaymentAccount = { workOrderId: 'work', number: 'WO-1', title: 'Work', customerName: 'Customer', contractPaise: '9007199254740993',
    scheduledPaise: '9007199254740993', receivedPaise: '8000000000000000', outstandingPaise: '1007199254740993', overduePaise: '91', unallocatedPaise: '55' };
  ops.extension.paymentAccounts = [account, { ...account, workOrderId: 'work-2' }];
  const totals = { ...emptyTotals, count: 1100, submittedPaise: '9900000000000001' };
  ops.expenseSummary = { month: totals, allTime: { ...totals, paidPaise: '19800000000000001' } };
  const result = buildDashboardOverview(data, ops, now);
  assert.equal(result.core.pipelinePaise, '9900000000000000');
  assert.equal(result.core.pendingQuotationPaise, '9900000000000000');
  assert.deepEqual(result.operations?.payments, { workOrders: 2, contractPaise: '18014398509481986', receivedPaise: '16000000000000000',
    outstandingPaise: '2014398509481986', overduePaise: '182', unallocatedPaise: '110' });
  assert.equal(result.operations?.expenses.monthTotals?.submittedPaise, '9900000000000001');
  assert.equal(result.operations?.expenses.allTimeTotals?.paidPaise, '19800000000000001');
});

test('employee and Manager summaries do not expose elevated financial, team or attendance aggregates', () => {
  for (const role of ['MANAGER', 'SALES', 'OPERATIONS', 'VIEWER'] as Role[]) {
    const person = { ...employee, role }, data = workspace(person), ops = operations(person);
    ops.extension.attendanceCalendar = [attendance(person.userId), attendance(owner.userId)];
    ops.extension.attendanceSummary = [summary(person.userId, 100), summary(owner.userId, 9000)];
    ops.myTodayAttendance = attendance(person.userId);
    ops.expenseSummary = { month: { ...emptyTotals, paidPaise: '900000' }, allTime: { ...emptyTotals, submittedPaise: '888888' } };
    ops.extension.paymentAccounts = [{ contractPaise: '777777' } as PaymentAccount];
    ops.extension.purchaseOrders = [purchase('other', 'OPEN', '2026-11-01')];
    ops.extension.materialRequests = [request('mine', person.userId, 'SUBMITTED'), request('other', owner.userId, 'APPROVED')];
    const result = buildDashboardOverview(data, ops, now).operations!;
    assert.equal(result.owner, false);
    assert.equal(result.attendance.scope, 'SELF'); assert.equal(result.attendance.todayRecorded, 1); assert.equal(result.attendance.workedMinutes, 100);
    assert.equal(result.expenses.monthTotals, null); assert.equal(result.expenses.allTimeTotals, null);
    assert.equal(result.payments, null); assert.equal(result.purchaseOrders, null); assert.equal(result.activeTeamMembers, null);
    assert.equal(result.sites.assignedMembers, null); assert.deepEqual(result.materialRequests, { submitted: 1, approved: 0, open: 1 });
    assert.ok(!JSON.stringify(result).includes('777777')); assert.ok(!JSON.stringify(result).includes('888888'));
  }
});

test('missing, cross-account, inactive, stale-role and unscoped responses remain unavailable, never zero-filled', () => {
  const data = workspace(employee);
  assert.equal(buildDashboardOverview(data, null, now).operations, null);
  const others = operations(owner); assert.equal(buildDashboardOverview(data, others, now).operations, null);
  const elevated = operations({ ...employee, role: 'OWNER' }); assert.equal(buildDashboardOverview(data, elevated, now).operations, null);
  const badPermission = operations(employee); badPermission.permissions.admin = true;
  assert.equal(buildDashboardOverview(data, badPermission, now).operations, null);
  const inactive = operations(employee); inactive.user.active = false;
  assert.equal(buildDashboardOverview(data, inactive, now).operations, null);
  const unscoped = operations(employee); unscoped.expenses = [expense(owner.userId)]; unscoped.counts.expenses = 900;
  assert.equal(buildDashboardOverview(data, unscoped, now).operations, null);
  const same = operations(employee); data.user.active = false;
  assert.equal(buildDashboardOverview(data, same, now).operations, null);
  assert.equal(buildDashboardOverview(workspace(), operations(), now).operations?.stock.activeItems, 0);
});

test('current attendance excludes removed members without rewriting historical month totals or inventing absence', () => {
  const data = workspace(), ops = operations();
  ops.extension.attendanceCalendar = [attendance(owner.userId, { checkIn: null, source: 'ADMIN' }), attendance(employee.userId), attendance(removed.userId)];
  ops.extension.attendanceSummary = [summary(owner.userId, 100), summary(employee.userId, 200), summary(removed.userId, 300)];
  const result = buildDashboardOverview(data, ops, now).operations!;
  assert.equal(result.activeTeamMembers, 2);
  assert.equal(result.attendance.todayRecorded, 2); assert.equal(result.attendance.todayPresent, 2);
  assert.equal(result.attendance.todayCheckedIn, 1); assert.equal(result.attendance.todayAbsent, 0);
  assert.equal(result.attendance.workedMinutes, 600); assert.equal(result.attendance.recordedDays, 3);
  assert.equal(result.attendance.eligibleOvertimeMinutes, 180); assert.equal(result.attendance.approvedOvertimeMinutes, 90);
  const empty = buildDashboardOverview(data, operations(), now).operations!;
  assert.equal(empty.attendance.todayAbsent, 0); assert.equal(empty.attendance.todayRecorded, 0);
});

test('an employee open shift from the previous month remains visible beside the complete current-month summary', () => {
  const data = workspace(employee), ops = operations(employee);
  ops.myOpenAttendance = attendance(employee.userId, { workDate: '2026-10-31', checkIn: '2026-10-31T18:00:00Z' });
  ops.counts.expenses = 751;
  ops.expenses = Array.from({ length: 500 }, () => expense(employee.userId));
  const result = buildDashboardOverview(data, ops, now).operations!;
  assert.equal(result.attendance.ownOpenShift, true); assert.equal(result.attendance.ownStatus, null);
  assert.equal(result.attendance.todayRecorded, 0); assert.equal(result.expenses.monthCount, 751);
  assert.equal(result.expenses.monthTotals, null);
});

test('site and stock summaries retain per-material units and omit archived locations, stock and assignments', () => {
  const data = workspace(), ops = operations();
  ops.stockItems = [stock('Cement', 1000, 2000, 'bag'), stock('Steel', 2500, 3000, 'kg'), stock('Sand', 4000, 1000, 'tonne'),
    stock('Archived', 0, 1000, 'piece', false)];
  ops.counts.stockMovements = 900;
  ops.extension.sites = [{ id: 'main', name: 'Main store', kind: 'STORE', system: true, active: true, address: '', workOrderId: null },
    { id: 'site-a', name: 'Site A', kind: 'SITE', system: false, active: true, address: '', workOrderId: null },
    { id: 'old-site', name: 'Old site', kind: 'SITE', system: false, active: false, address: '', workOrderId: null }];
  ops.extension.assignments = [{ userId: owner.userId, siteId: 'site-a', updatedAt: now.toISOString() },
    { userId: employee.userId, siteId: 'old-site', updatedAt: now.toISOString() }, { userId: removed.userId, siteId: 'site-a', updatedAt: now.toISOString() }];
  const result = buildDashboardOverview(data, ops, now).operations!;
  assert.equal(result.stock.activeItems, 3); assert.equal(result.stock.movementCount, 900);
  assert.deepEqual(result.stock.lowItems.map(row => [row.name, row.quantityMilli, row.unit]), [['Cement', 1000, 'bag'], ['Steel', 2500, 'kg']]);
  assert.ok(!Object.hasOwn(result.stock, 'totalQuantity'));
  assert.deepEqual(result.sites, { activeSites: 1, ownSite: { id: 'site-a', name: 'Site A' }, shiftConfigured: false, assignedMembers: 1 });
});

test('material requests and procurement show only still-actionable records with date-aware overdue deliveries', () => {
  const data = workspace(), ops = operations();
  ops.extension.materialRequests = [request('new', owner.userId, 'SUBMITTED'), request('approved', employee.userId, 'APPROVED'),
    request('fulfilled', employee.userId, 'FULFILLED'), request('rejected', employee.userId, 'REJECTED'), request('cancelled', owner.userId, 'CANCELLED')];
  ops.extension.purchaseOrders = [purchase('late', 'PART_RECEIVED', '2026-11-23'), purchase('today', 'OPEN', '2026-11-24'),
    purchase('unscheduled', 'OPEN', null), purchase('closed', 'RECEIVED', '2026-11-01'), purchase('cancelled', 'CANCELLED', '2026-11-01')];
  const result = buildDashboardOverview(data, ops, now).operations!;
  assert.deepEqual(result.materialRequests, { submitted: 1, approved: 1, open: 2 });
  assert.deepEqual(result.purchaseOrders, { open: 3, overdue: 1 });
});

test('snapshot time determines India labels and stale month/day snapshots are not relabeled as current data', () => {
  const data = workspace(), ops = operations();
  const midnight = new Date('2026-11-30T18:30:00Z');
  assert.equal(buildDashboardOverview(data, ops, midnight).operations, null);
  ops.serverTime = midnight.toISOString(); ops.today = '2026-12-01';
  const staleMonth = buildDashboardOverview(data, ops);
  assert.equal(staleMonth.today, '2026-12-01'); assert.equal(staleMonth.month, '2026-12'); assert.equal(staleMonth.operations, null);
  ops.month = '2026-12';
  const refreshed = buildDashboardOverview(data, ops);
  assert.equal(refreshed.operations?.month, '2026-12'); assert.equal(refreshed.asOf, midnight.toISOString());
});

test('building a summary never modifies source records or substitutes missing Owner private data with zero', () => {
  const data = workspace(), ops = operations();
  ops.stockItems = [stock('B', 0, 0, 'bag'), stock('A', 0, 0, 'kg')];
  ops.extension.paymentAccounts = null; ops.extension.purchaseOrders = null; ops.expenseSummary = null;
  const before = JSON.stringify({ data, ops });
  const result = buildDashboardOverview(data, ops, now);
  assert.equal(JSON.stringify({ data, ops }), before);
  assert.equal(result.operations?.payments, null); assert.equal(result.operations?.purchaseOrders, null); assert.equal(result.operations?.expenses.monthTotals, null);
  assert.deepEqual(result.operations?.stock.lowItems.map(row => row.name), ['A', 'B']);
});
