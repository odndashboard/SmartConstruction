import type { AttendanceRecord } from './operations-types';
import type { WorkspaceData } from './types';

export interface ConstructionSite {
  id: string; name: string; address: string; workOrderId: string | null;
  kind: 'STORE' | 'SITE'; active: boolean; system: boolean;
}
export interface SiteAssignment { userId: string; siteId: string; updatedAt: string; }
export interface ShiftRule {
  configured: boolean; startLocal: string | null; endLocal: string | null;
  overnight: boolean; breakMinutes: number; graceMinutes: number; version: number;
}
export interface AttendanceMetrics {
  elapsedMinutes: number | null; workedMinutes: number | null; expectedMinutes: number | null;
  lateMinutes: number | null; eligibleOvertimeMinutes: number | null;
  approvedOvertimeMinutes: number; overtimeReason: string;
  overtimeReviewedBy: string | null; overtimeReviewedAt: string | null;
}
export interface ExtendedAttendanceRecord extends AttendanceRecord {
  siteId: string | null; shiftSnapshot: ShiftRule; metrics: AttendanceMetrics;
}
export interface AttendanceSummary {
  userId: string; memberName: string; recordedDays: number; presentDays: number;
  halfDays: number; absentDays: number; leaveDays: number; openShifts: number;
  workedMinutes: number; lateDays: number; eligibleOvertimeMinutes: number;
  approvedOvertimeMinutes: number;
}
export interface SiteStockBalance { itemId: string; siteId: string; quantityMilli: number; }
export interface StockTransfer {
  id: string; itemId: string; fromSiteId: string; toSiteId: string;
  quantityMilli: number; note: string; reference: string; requestId: string | null;
  actorId: string; actorName: string; createdAt: string;
}
export interface StockReturn {
  id: string; movementId: string; itemId: string; siteId: string; quantityMilli: number;
  reason: string; actorId: string; actorName: string; createdAt: string;
}
export type MaterialRequestStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'FULFILLED' | 'CANCELLED';
export interface MaterialRequest {
  id: string; userId: string; memberName: string; siteId: string; itemId: string;
  quantityMilli: number; fulfilledMilli: number; status: MaterialRequestStatus;
  neededOn: string | null; note: string; reviewNote: string;
  reviewedBy: string | null; reviewedAt: string | null; createdAt: string; updatedAt: string;
}
export interface PurchaseOrderLine {
  id: string; itemId: string; quantityMilli: number; receivedMilli: number;
}
export interface PurchaseOrder {
  id: string; number: string; supplier: string; siteId: string; expectedOn: string | null;
  reference: string; notes: string; status: 'OPEN' | 'PART_RECEIVED' | 'RECEIVED' | 'CANCELLED';
  cancelReason: string; lines: PurchaseOrderLine[]; createdAt: string; updatedAt: string;
}
export type PaymentMethod = 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER';
export interface CustomerPayment {
  id: string; workOrderId: string; paymentDate: string; amountPaise: number;
  method: PaymentMethod; reference: string; notes: string; actorId: string;
  createdAt: string; voidedAt: string | null; voidReason: string;
}
export interface PaymentInstallment {
  id: string; workOrderId: string; title: string; dueDate: string; amountPaise: number;
  paidPaise: string; balancePaise: string; cancelledAt: string | null; cancelReason: string; createdAt: string;
}
export interface PaymentAccount {
  workOrderId: string; number: string; title: string; customerName: string;
  contractPaise: string | null; scheduledPaise: string; receivedPaise: string;
  outstandingPaise: string | null; overduePaise: string; unallocatedPaise: string;
  overpaidPaise?: string;
}
export interface ExpenseReceipt {
  id: string; expenseId: string; fileName: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  sizeBytes: number; uploadedBy: string; createdAt: string;
}
export interface OperationsExtension {
  sites: ConstructionSite[]; assignments: SiteAssignment[]; shiftRule: ShiftRule;
  attendanceCalendar: ExtendedAttendanceRecord[]; attendanceSummary: AttendanceSummary[];
  siteBalances: SiteStockBalance[]; transfers: StockTransfer[]; returns: StockReturn[];
  materialRequests: MaterialRequest[]; purchaseOrders: PurchaseOrder[] | null;
  paymentAccounts: PaymentAccount[] | null; paymentInstallments: PaymentInstallment[] | null;
  customerPayments: CustomerPayment[] | null; expenseReceipts: ExpenseReceipt[];
}
export type ExtensionAction = 'site_save' | 'site_active' | 'site_assign' | 'shift_rule_save'
  | 'attendance_overtime_approve' | 'stock_location_move' | 'stock_transfer' | 'stock_return'
  | 'material_request_create' | 'material_request_cancel' | 'material_request_review' | 'material_request_fulfill'
  | 'purchase_order_create' | 'purchase_order_receive' | 'purchase_order_cancel'
  | 'payment_installment_add' | 'payment_installment_cancel' | 'payment_record' | 'payment_void';

export interface AdvancedPanelProps {
  workspace: WorkspaceData;
  data: import('./operations-types').OperationsData;
  blocked: boolean;
  save: (action: import('./operations-types').OperationsAction, payload: Record<string, unknown>) => Promise<boolean>;
}
