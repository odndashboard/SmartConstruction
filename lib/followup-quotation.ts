import type { FollowUp, Quotation, WorkspaceData } from './types';

type FollowupReference = Pick<FollowUp, 'leadId' | 'isDemo'> & { quoteId?: string | null };

/** A follow-up never silently switches to a newer quotation or another scope. */
export function getFollowupQuotationContext(data: Pick<WorkspaceData, 'quotations'>, item: FollowupReference): {
  quotation: Quotation | null; quotations: Quotation[];
} {
  const quotations = data.quotations.filter(quote => quote.leadId === item.leadId && quote.isDemo === item.isDemo)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { quotation: quotations.find(quote => quote.id === item.quoteId) ?? null, quotations };
}

export function followupQuotationPayload(item: FollowUp, quoteId: string) {
  return { id: item.id, leadId: item.leadId, title: item.title, dueAt: item.dueAt, channel: item.channel,
    owner: item.owner, notes: item.notes, quoteId };
}

/** Use the returned ID after a save; never locate a quotation by its title. */
export function savedHandoffQuotation(before: WorkspaceData, after: WorkspaceData, leadId: string, id?: string): Quotation | null {
  const prior = new Set(before.quotations.map(quote => quote.id));
  const candidates = after.quotations.filter(quote => quote.leadId === leadId && (id ? quote.id === id : !prior.has(quote.id)));
  return candidates.length === 1 ? candidates[0] : null;
}
