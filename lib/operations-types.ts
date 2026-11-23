import type { Member } from './types';

export type OperationsSection = 'stock' | 'attendance' | 'expenses';
export type StockMovementType = 'IN' | 'OUT' | 'ADJUST';
export type AttendanceStatus = 'PRESENT' | 'HALF_DAY' | 'ABSENT' | 'LEAVE';
export type ExpenseStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'PAID' | 'WITHDRAWN';
export const EXPENSE_CATEGORIES = ['Materials', 'Travel', 'Labour', 'Equipment', 'Food', 'Other'] as const;
export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

/** Quantities use integer thousandths; money uses integer paise. */
export interface StockItem {
  id: string; sku: string; name: string; unit: string; location: string;
  quantityMilli: number; minQuantityMilli: number; active: boolean;
  receivedMilli: string; usedMilli: string; adjustedMilli: string;
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface StockMovement {
  id: string; itemId: string; type: StockMovementType; quantityMilli: number;
  deltaMilli: number; balanceAfterMilli: number; note: string; reference: string;
  actorId: string; actorName: string; createdAt: string;
}
export interface AttendanceRecord {
  id: string; userId: string; memberName: string; workDate: string; status: AttendanceStatus;
  checkIn: string | null; checkOut: string | null; site: string; notes: string;
  source: 'SELF' | 'ADMIN'; updatedAt: string;
}
export interface Expense {
  id: string; userId: string; memberName: string; expenseDate: string; title: string;
  category: ExpenseCategory; amountPaise: number; site: string; reference: string; notes: string;
  status: ExpenseStatus; reviewNote: string; reviewedBy: string | null; reviewedAt: string | null;
  createdAt: string; updatedAt: string;
}
/** Aggregate money is returned as exact integer strings to avoid JS sum overflow. */
export interface ExpenseTotals {
  count: number; submittedPaise: string; approvedPaise: string; paidPaise: string;
  rejectedPaise: string; withdrawnPaise: string;
}
export interface OperationsData {
  revision: number; month: string; today: string; serverTime: string;
  user: Member; permissions: { admin: boolean; canWrite: boolean };
  stockItems: StockItem[]; stockMovements: StockMovement[]; attendance: AttendanceRecord[];
  myTodayAttendance: AttendanceRecord | null; myOpenAttendance: AttendanceRecord | null;
  expenses: Expense[];
  /** Company totals are absent for every non-Owner role, including Manager. */
  expenseSummary: { month: ExpenseTotals; allTime: ExpenseTotals } | null;
  counts: { stockMovements: number; attendance: number; expenses: number };
  historyLimit: number;
}
export type OperationsAction = 'stock_item_save' | 'stock_item_active' | 'stock_move'
  | 'attendance_check_in' | 'attendance_check_out' | 'attendance_correct'
  | 'expense_save' | 'expense_withdraw' | 'expense_review';

export interface OperationsMutation {
  action: OperationsAction; payload: Record<string, unknown>;
  expectedRevision: number; requestId: string; month: string;
}

export const TEAM_ACTIVITY_MODULES = ['all', 'leads', 'followups', 'quotations', 'workorders', 'customers', 'team', 'settings', 'stock', 'attendance', 'expenses'] as const;
export type TeamActivityModule = typeof TEAM_ACTIVITY_MODULES[number];
export interface TeamActivityEntry {
  id: string; actorId: string | null; actorName: string; action: string;
  module: Exclude<TeamActivityModule, 'all'>; entityType: string; entityId: string;
  description: string; createdAt: string; source: 'CRM' | 'OPERATIONS';
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string;
}
export interface TeamActivityData {
  month: string; employeeId: string | null; module: TeamActivityModule;
  page: number; pageSize: number; total: number; serverTime: string; entries: TeamActivityEntry[];
}
