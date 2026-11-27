import type { SiteAlertsData } from '../../lib/site-alerts.ts';
export function alertData(): SiteAlertsData {
  const user = { userId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Reporter', role: 'OPERATIONS' as const };
  return { revision: 4, serverTime: '2026-11-27T06:00:00Z', user, alerts: [], total: 0, page: 1, pageSize: 50,
    openCount: 0, resolvedCount: 0, assignees: [user], stockItems: [{ id: '20000000-0000-4000-8000-000000000002', name: 'Synthetic Panel', unit: 'nos' }],
    workOrders: [{ id: 'work-active', number: 'SC/WO/2026-27/1', title: 'Synthetic job', siteAddress: 'Synthetic roof' }] };
}
