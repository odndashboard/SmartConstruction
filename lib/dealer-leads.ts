import type { LeadStatus, WorkStatus } from './types';

/** The dealer portal never receives a full workspace, customer, team directory,
 * quotation, account balance or another dealer's submission contacts. */
export interface DealerLead {
  id: string; title: string; contact: string; phone: string; siteAddress: string;
  expectedKw: number | null; status: LeadStatus; createdAt: string; updatedAt: string;
  canDelete: boolean; deleteBlockedReason: string | null;
}
/** Explicitly assigned project progress, separately scoped from owned submissions. */
export interface DealerAssignedSite {
  id: string; title: string; siteAddress: string; siteName: string | null; siteId: string | null;
  leadId: string | null; workOrderId: string | null; workOrderNumber: string | null;
  leadStatus: LeadStatus | null; workOrderStatus: WorkStatus | null; expectedKw: number | null;
  completedMilestones: number; totalMilestones: number; assignedVia: ('LEAD' | 'WORK_ORDER' | 'SITE')[];
}
export interface DealerLeadsData {
  revision: number;
  user: { userId: string; name: string; role: 'DEALER' };
  leads: DealerLead[];
  assignedSites: DealerAssignedSite[];
}
export interface DealerLeadInput {
  title: string; contact?: string; phone?: string; siteAddress?: string; expectedKw?: number | null;
}
export interface CreateDealerLeadRequest { requestId: string; payload: DealerLeadInput; }
export interface DeleteDealerLeadRequest { requestId: string; expectedRevision: number; leadId: string; }
export interface DeleteDealerLeadResult { data: DealerLeadsData; message: string; }
