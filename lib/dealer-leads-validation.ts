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
export const dealerLeadsDataSchema = z.object({
  user: z.object({ userId: z.string().uuid(), name: z.string(), role: z.literal('DEALER') }),
  leads: z.array(z.object({
    id: z.string().min(1).max(120), title: z.string(), contact: z.string(), phone: z.string(), siteAddress: z.string(), expectedKw,
    status: z.enum(['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']),
    createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
  })),
});
