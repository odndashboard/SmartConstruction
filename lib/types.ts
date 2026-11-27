export type Role = 'OWNER' | 'MANAGER' | 'SALES' | 'OPERATIONS' | 'ACCOUNTANT' | 'VIEWER';
export type LeadStatus = 'NEW' | 'CONTACTED' | 'SITE_VISIT' | 'QUOTED' | 'NEGOTIATION' | 'WON' | 'LOST';
export type QuoteStatus = 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'SUPERSEDED';
export type WorkStatus = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type TaxMode = 'CGST_SGST' | 'CGST_UTGST' | 'IGST' | 'UNCONFIGURED';

export interface Company {
  name: string; legalName: string; address: string; gstin: string; stateCode: string;
  phone: string; email: string; website: string; currency: 'INR'; timeZone: 'Asia/Kolkata'; terms: string;
}
export interface Member { userId: string; name: string; email: string; role: Role; active: boolean; }
export interface Customer {
  id: string; name: string; contact: string; phone: string; email: string;
  address: string; stateCode: string; gstin: string; isDemo: boolean; createdAt: string;
}
export interface Lead {
  id: string; customerId: string; title: string; contact: string; phone: string; email: string;
  expectedKw?: number | null;
  location: string; siteAddress: string; stateCode: string; value: number; status: LeadStatus;
  source: string; owner: string; priority: 'High' | 'Medium' | 'Low'; notes: string;
  lostReason: string; isDemo: boolean; createdAt: string; updatedAt: string;
}
export interface FollowUp {
  id: string; leadId: string; title: string; dueAt: string; channel: 'Call'|'WhatsApp'|'Email'|'Site visit'|'Other';
  owner: string; notes: string; status: 'OPEN'|'DONE'|'CANCELLED'; outcome: string;
  completedAt?: string; isDemo: boolean; createdAt: string; updatedAt: string;
}
export interface QuoteItemInput {
  id: string; description: string; hsnSac: string; quantity: string; unit: string;
  unitPrice: string; discount: string; gstRate: string;
}
export interface QuoteItem extends QuoteItemInput {
  gross: number; taxable: number; cgst: number; sgst: number; utgst: number; igst: number; total: number;
}
export interface QuoteTotals {
  subtotal: number; discount: number; taxable: number; cgst: number; sgst: number;
  utgst: number; igst: number; total: number; mode: TaxMode; needsConfig: boolean;
}
export interface Quotation {
  id: string; leadId: string; number: string|null; title: string; validUntil: string;
  placeOfSupply: string; siteAddress: string; terms: string; items: QuoteItem[]; totals: QuoteTotals;
  status: QuoteStatus; revision: number; revisionOf?: string; supplier?: Company; customer?: Customer;
  issuedAt?: string; acceptedAt?: string; acceptanceNote: string; isDemo: boolean; createdAt: string; updatedAt: string;
}
export interface Milestone { id: string; title: string; dueDate: string; status: 'PENDING'|'DONE'; completedAt?: string; }
export interface WorkOrder {
  id: string; leadId?: string; quoteId: string | null; number: string; title: string; customerName: string; siteAddress: string;
  owner: string; startDate: string; endDate: string; status: WorkStatus; snapshot: Quotation | null;
  expectedKw?: number | null; automaticForLead?: boolean;
  milestones: Milestone[]; isDemo: boolean; createdAt: string; updatedAt: string;
}
export interface AuditEvent {
  id: string; actor: string; action: string; entityType: string; entityId: string; description: string; createdAt: string;
}
export interface WorkspaceData {
  revision: number; company: Company; user: Member; members: Member[];
  customers: Customer[]; leads: Lead[]; followups: FollowUp[]; quotations: Quotation[];
  workorders: WorkOrder[]; activity: AuditEvent[]; sequences: Record<string, number>;
}
export const DEFAULT_COMPANY: Company = {
  name: 'smart construction', legalName: '', address: '', gstin: '', stateCode: '', phone: '', email: '', website: '',
  currency: 'INR', timeZone: 'Asia/Kolkata', terms: 'Scope and payment milestones are subject to written agreement. Any additional work requires approval.',
};
export const LEAD_STAGES: {value:LeadStatus;label:string}[] = [
  {value:'NEW',label:'New enquiry'}, {value:'CONTACTED',label:'Contacted'}, {value:'SITE_VISIT',label:'Site visit'},
  {value:'QUOTED',label:'Quoted'}, {value:'NEGOTIATION',label:'Negotiation'}, {value:'WON',label:'Won'}, {value:'LOST',label:'Lost'},
];
export const ROLE_LABELS: Record<Role,string> = {OWNER:'Owner',MANAGER:'Manager',SALES:'Sales',OPERATIONS:'Operations',ACCOUNTANT:'Accountant',VIEWER:'Viewer'};
