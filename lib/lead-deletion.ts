import type { Lead, WorkspaceData } from './types';

export function leadDeletionBlockReason(
  data: Pick<WorkspaceData, 'followups' | 'quotations' | 'workorders'>,
  lead: Pick<Lead, 'id' | 'status' | 'isDemo'>,
): string | null {
  if (lead.isDemo) return 'Use Clear example records in Settings to remove examples.';
  if (lead.status === 'WON') return 'Won leads are kept with their project history.';
  if (data.workorders.some(order => order.leadId === lead.id || order.snapshot?.leadId === lead.id)) {
    return 'This lead is linked to a work order.';
  }
  if (data.quotations.some(quote => quote.leadId === lead.id)) return 'This lead is linked to a quotation.';
  if (data.followups.some(item => item.leadId === lead.id)) return 'This lead is linked to a follow-up.';
  return null;
}
