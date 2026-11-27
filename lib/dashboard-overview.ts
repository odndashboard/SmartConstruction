import type { WorkspaceData } from './types';
import type { AttendanceStatus, ExpenseTotals, OperationsData } from './operations-types';
import { todayIST } from './finance.ts';
import { effectiveQuoteStatus } from './quotation-status.ts';

export interface DashboardCoreSummary {
  openLeads: number; pipelinePaise: string;
  followupsToday: number; overdueFollowups: number;
  pendingQuotations: number; pendingQuotationPaise: string;
  activeWorkOrders: number; completedWorkOrders: number; customers: number;
}

export interface DashboardOperationsSummary {
  owner: boolean; month: string;
  stock: {
    activeItems: number;
    lowItems: { id: string; name: string; sku: string; unit: string; quantityMilli: number; minQuantityMilli: number }[];
    movementCount: number; transfers: number; returns: number;
  };
  sites: {
    activeSites: number; ownSite: { id: string; name: string } | null;
    shiftConfigured: boolean; assignedMembers: number | null;
  };
  attendance: {
    scope: 'TEAM' | 'SELF'; todayRecorded: number; todayPresent: number;
    todayHalfDay: number; todayAbsent: number; todayLeave: number; todayCheckedIn: number;
    ownStatus: AttendanceStatus | null; ownOpenShift: boolean;
    recordedDays: number; workedMinutes: number;
    eligibleOvertimeMinutes: number; approvedOvertimeMinutes: number;
  };
  expenses: {
    scope: 'COMPANY' | 'SELF'; monthCount: number;
    monthTotals: ExpenseTotals | null; allTimeTotals: ExpenseTotals | null;
  };
  payments: {
    workOrders: number; unpricedWorkOrders: number; contractPaise: string; receivedPaise: string;
    outstandingPaise: string; overduePaise: string; unallocatedPaise: string; overpaidPaise: string;
  } | null;
  materialRequests: { submitted: number; approved: number; open: number };
  purchaseOrders: { open: number; overdue: number } | null;
  activeTeamMembers: number | null;
}

export interface DashboardOverviewSummary {
  today: string; month: string; asOf: string;
  core: DashboardCoreSummary; operations: DashboardOperationsSummary | null;
}

function validInstant(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function sumPaise<T>(rows: T[], value: (row: T) => string | number): string {
  return rows.reduce((total, row) => total + BigInt(value(row)), 0n).toString();
}

/** Read-only presentation totals. SQL remains the authority for access: these
 * guards additionally discard stale identities/roles and never mix private
 * Owner summaries into an employee's overview. Money stays exact in paise. */
export function buildDashboardOverview(workspace: WorkspaceData, operations: OperationsData | null, now?: Date): DashboardOverviewSummary {
  const snapshotTime = operations ? validInstant(operations.serverTime) : null;
  const instant = now ?? snapshotTime ?? new Date();
  const today = todayIST(instant), month = today.slice(0, 7);
  const openLeads = workspace.leads.filter(row => row.status !== 'WON' && row.status !== 'LOST');
  const pendingQuotes = workspace.quotations.filter(row => effectiveQuoteStatus(row, today) === 'ISSUED');
  let followupsToday = 0, overdueFollowups = 0;
  const instantTime = instant.getTime();
  for (const row of workspace.followups) {
    if (row.status !== 'OPEN') continue;
    const due = validInstant(row.dueAt);
    if (!due) continue;
    if (todayIST(due) === today) followupsToday++;
    if (due.getTime() < instantTime) overdueFollowups++;
  }
  const overview: DashboardOverviewSummary = {
    today, month, asOf: instant.toISOString(),
    core: {
      openLeads: openLeads.length, pipelinePaise: sumPaise(openLeads, row => row.value),
      followupsToday, overdueFollowups,
      pendingQuotations: pendingQuotes.length, pendingQuotationPaise: sumPaise(pendingQuotes, row => row.totals.total),
      activeWorkOrders: workspace.workorders.filter(row => row.status !== 'COMPLETED' && row.status !== 'CANCELLED').length,
      completedWorkOrders: workspace.workorders.filter(row => row.status === 'COMPLETED').length,
      customers: workspace.customers.length,
    },
    operations: null,
  };
  if (!operations || !workspace.user.active || !operations.user.active || !snapshotTime
    || operations.user.userId !== workspace.user.userId || operations.user.role !== workspace.user.role
    || operations.permissions.admin !== (operations.user.role === 'OWNER')
    || operations.month !== month || operations.today !== today) return overview;

  const owner = workspace.user.role === 'OWNER' && operations.user.role === 'OWNER' && operations.permissions.admin;
  const userId = workspace.user.userId;
  // The exact employee expense count is supplied by scoped SQL, independently
  // of the 500-row history. Reject a structurally unscoped response instead of
  // attaching its count to an employee label or inventing a partial total.
  if (!owner && operations.expenses.some(row => row.userId !== userId)) return overview;

  const activeMembers = new Set(workspace.members.filter(row => row.active).map(row => row.userId));
  const activeSites = operations.extension.sites.filter(row => row.active && row.kind === 'SITE');
  const activeSiteIds = new Set(activeSites.map(row => row.id));
  const ownAssignment = operations.extension.assignments.find(row => row.userId === userId);
  const ownSite = activeSites.find(row => row.id === ownAssignment?.siteId);
  const attendance = operations.extension.attendanceCalendar.filter(row => row.workDate === today
    && (owner ? activeMembers.has(row.userId) : row.userId === userId));
  const summaries = operations.extension.attendanceSummary.filter(row => owner || row.userId === userId);
  const ownToday = operations.myTodayAttendance?.userId === userId && operations.myTodayAttendance.workDate === today
    ? operations.myTodayAttendance : null;
  const ownOpen = operations.myOpenAttendance?.userId === userId
    && !!operations.myOpenAttendance.checkIn && !operations.myOpenAttendance.checkOut;
  const stock = operations.stockItems.filter(row => row.active);
  const requests = operations.extension.materialRequests.filter(row => owner || row.userId === userId);
  const openOrders = owner && operations.extension.purchaseOrders !== null
    ? operations.extension.purchaseOrders.filter(row => row.status === 'OPEN' || row.status === 'PART_RECEIVED') : null;
  const paymentAccounts = owner ? operations.extension.paymentAccounts : null;
  const monthly = (value: string) => { const date = validInstant(value); return date !== null && todayIST(date).slice(0, 7) === month; };

  overview.operations = {
    owner, month,
    stock: {
      activeItems: stock.length,
      lowItems: stock.filter(row => row.quantityMilli <= row.minQuantityMilli)
        .sort((a, b) => Number(a.quantityMilli > 0) - Number(b.quantityMilli > 0) || a.name.localeCompare(b.name))
        .map(({ id, name, sku, unit, quantityMilli, minQuantityMilli }) => ({ id, name, sku, unit, quantityMilli, minQuantityMilli })),
      movementCount: operations.counts.stockMovements,
      transfers: operations.extension.transfers.filter(row => monthly(row.createdAt)).length,
      returns: operations.extension.returns.filter(row => monthly(row.createdAt)).length,
    },
    sites: {
      activeSites: activeSites.length, ownSite: ownSite ? { id: ownSite.id, name: ownSite.name } : null,
      shiftConfigured: operations.extension.shiftRule.configured,
      assignedMembers: owner ? new Set(operations.extension.assignments.filter(row => activeMembers.has(row.userId)
        && activeSiteIds.has(row.siteId)).map(row => row.userId)).size : null,
    },
    attendance: {
      scope: owner ? 'TEAM' : 'SELF', todayRecorded: attendance.length,
      todayPresent: attendance.filter(row => row.status === 'PRESENT').length,
      todayHalfDay: attendance.filter(row => row.status === 'HALF_DAY').length,
      todayAbsent: attendance.filter(row => row.status === 'ABSENT').length,
      todayLeave: attendance.filter(row => row.status === 'LEAVE').length,
      todayCheckedIn: attendance.filter(row => row.checkIn !== null && row.checkOut === null).length,
      ownStatus: ownToday?.status ?? null, ownOpenShift: !!ownOpen,
      recordedDays: summaries.reduce((total, row) => total + row.recordedDays, 0),
      workedMinutes: summaries.reduce((total, row) => total + row.workedMinutes, 0),
      eligibleOvertimeMinutes: summaries.reduce((total, row) => total + row.eligibleOvertimeMinutes, 0),
      approvedOvertimeMinutes: summaries.reduce((total, row) => total + row.approvedOvertimeMinutes, 0),
    },
    expenses: {
      scope: owner ? 'COMPANY' : 'SELF', monthCount: operations.counts.expenses,
      monthTotals: owner && operations.expenseSummary ? { ...operations.expenseSummary.month } : null,
      allTimeTotals: owner && operations.expenseSummary ? { ...operations.expenseSummary.allTime } : null,
    },
    payments: paymentAccounts === null ? null : {
      workOrders: paymentAccounts.length,
      unpricedWorkOrders: paymentAccounts.filter(row => row.contractPaise === null).length,
      contractPaise: sumPaise(paymentAccounts, row => row.contractPaise ?? '0'),
      receivedPaise: sumPaise(paymentAccounts, row => row.receivedPaise),
      outstandingPaise: sumPaise(paymentAccounts, row => row.outstandingPaise ?? '0'),
      overduePaise: sumPaise(paymentAccounts, row => row.overduePaise),
      unallocatedPaise: sumPaise(paymentAccounts, row => row.unallocatedPaise),
      overpaidPaise: sumPaise(paymentAccounts, row => row.overpaidPaise ?? '0'),
    },
    materialRequests: {
      submitted: requests.filter(row => row.status === 'SUBMITTED').length,
      approved: requests.filter(row => row.status === 'APPROVED').length,
      open: requests.filter(row => row.status === 'SUBMITTED' || row.status === 'APPROVED').length,
    },
    purchaseOrders: openOrders === null ? null : { open: openOrders.length, overdue: openOrders.filter(row => row.expectedOn !== null && row.expectedOn < today).length },
    activeTeamMembers: owner ? activeMembers.size : null,
  };
  return overview;
}
