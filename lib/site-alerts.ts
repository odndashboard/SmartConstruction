export const SITE_ALERT_ROLES = ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT'] as const;
export type SiteAlertRole = typeof SITE_ALERT_ROLES[number];
export type SiteAlertStatus = 'OPEN' | 'RESOLVED';
export interface SiteAlert {
  id: string; workOrderId: string; workOrderNumber: string; workOrderTitle: string; siteAddress: string;
  itemId: string | null; itemName: string; quantityMilli: number | null; unit: string; note: string;
  assigneeId: string; assigneeName: string; reportedBy: string; reportedByName: string;
  status: SiteAlertStatus; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; resolvedByName: string | null;
}
export interface SiteAlertMember { userId: string; name: string; role: SiteAlertRole; }
export interface SiteAlertsData {
  revision: number; serverTime: string; user: SiteAlertMember;
  alerts: SiteAlert[]; total: number; page: number; pageSize: 50; openCount: number; resolvedCount: number;
  assignees: SiteAlertMember[];
  stockItems: { id: string; name: string; unit: string }[];
  workOrders: { id: string; number: string; title: string; siteAddress: string }[];
}
export interface SiteAlertsQuery { workOrderId?: string; status?: SiteAlertStatus | 'ALL'; page?: number; search?: string; }
export interface CreateSiteAlertPayload {
  workOrderId: string; assigneeId: string; itemId?: string | null; itemName?: string;
  note?: string; quantity?: string | null; unit?: string;
}
export type SiteAlertMutation = {
  expectedRevision: number; requestId: string; query?: SiteAlertsQuery;
} & (
  | { action: 'material_alert_create'; payload: CreateSiteAlertPayload }
  | { action: 'material_alert_resolve'; payload: { id: string } }
);
export interface SiteAlertMutationResult { data: SiteAlertsData; message: string; }

export function canResolveSiteAlert(user: SiteAlertMember, alert: SiteAlert): boolean {
  return (SITE_ALERT_ROLES as readonly string[]).includes(user.role) && alert.status === 'OPEN' && (alert.assigneeId === user.userId || user.role === 'OWNER' || user.role === 'MANAGER');
}
