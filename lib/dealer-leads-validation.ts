import { z } from 'zod';

const text = (maximum: number) => z.string().trim().max(maximum);
const expectedKw = z.number().finite().nonnegative().nullable();
export const dealerLeadInputSchema = z.object({
  title: text(200).min(1, 'Enter the project title.'), contact: text(200).optional(), phone: text(40).optional(),
  siteAddress: text(2000).optional(), expectedKw: expectedKw.optional(),
}).strict();
export const createDealerLeadSchema = z.object({
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/), payload: dealerLeadInputSchema,
}).strict();
export const deleteDealerLeadSchema = z.object({
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: z.number().int().nonnegative().safe(), leadId: z.string().min(1).max(120),
}).strict();
export const dealerLeadsDataSchema = z.object({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  user: z.object({ userId: z.string().uuid(), name: z.string(), role: z.literal('DEALER') }),
  leads: z.array(z.object({
    id: z.string().min(1).max(120), title: z.string(), contact: z.string(), phone: z.string(), siteAddress: z.string(), expectedKw,
    status: z.enum(['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']),
    createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
    canDelete: z.boolean(), deleteBlockedReason: z.string().nullable(),
  })),
  assignedSites: z.array(z.object({
    id: z.string().min(1).max(140), title: z.string(), siteAddress: z.string(), siteName: z.string().nullable(), siteId: z.string().uuid().nullable(),
    leadId: z.string().min(1).max(120).nullable(), workOrderId: z.string().min(1).max(120).nullable(), workOrderNumber: z.string().nullable(),
    leadStatus: z.enum(['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']).nullable(),
    workOrderStatus: z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']).nullable(), expectedKw,
    completedMilestones: z.number().int().nonnegative(), totalMilestones: z.number().int().nonnegative(),
    assignedVia: z.array(z.enum(['LEAD', 'WORK_ORDER', 'SITE'])).min(1),
  }).refine(row => row.completedMilestones <= row.totalMilestones)),
});
