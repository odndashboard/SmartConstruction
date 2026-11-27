import type { PaymentAccount } from './operations-extensions';
import type { WorkspaceData } from './types';

export const MAX_PAYMENT_PAISE = 9_000_000_000_000n;

/** UI eligibility only; SQL independently checks identity, role and current data. */
export function canRecordWorkOrderPayment(workspace: Pick<WorkspaceData, 'workorders' | 'leads'>, workOrderId: string): boolean {
  const order = workspace.workorders.find(row => row.id === workOrderId);
  if (!order || order.isDemo || order.status === 'CANCELLED') return false;
  if (order.quoteId && order.snapshot) return order.snapshot.id === order.quoteId && order.snapshot.status === 'ACCEPTED';
  return order.quoteId === null && order.snapshot === null && !!order.leadId
    && workspace.leads.some(lead => lead.id === order.leadId && lead.status === 'WON' && !lead.isDemo);
}

export function paymentReceiptMaximum(account: PaymentAccount): bigint {
  if (account.contractPaise === null) return MAX_PAYMENT_PAISE;
  const outstanding = BigInt(account.outstandingPaise ?? '0');
  return outstanding > 0n ? outstanding : 0n;
}

export function paymentScheduleMaximum(account: PaymentAccount): bigint {
  if (account.contractPaise === null) return 0n;
  const available = BigInt(account.contractPaise) - BigInt(account.scheduledPaise);
  return available > 0n ? available : 0n;
}
