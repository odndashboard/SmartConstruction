import type { LeadStatus } from './types';

/** The dealer portal never receives a full workspace, customer, team directory,
 * quotation, account balance or another dealer's submission. */
export interface DealerLead {
  id: string; title: string; contact: string; phone: string; siteAddress: string;
  expectedKw: number | null; status: LeadStatus; createdAt: string; updatedAt: string;
}
export interface DealerLeadsData {
  user: { userId: string; name: string; role: 'DEALER' };
  leads: DealerLead[];
}
export interface DealerLeadInput {
  title: string; contact?: string; phone?: string; siteAddress?: string; expectedKw?: number | null;
}
export interface CreateDealerLeadRequest { requestId: string; payload: DealerLeadInput; }
