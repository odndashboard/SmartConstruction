import { z } from 'zod';
import { SITE_ALERT_ROLES } from './site-alerts.ts';

const text = (maximum: number) => z.string().trim().max(maximum);
const required = (maximum: number) => text(maximum).min(1, 'This field is required.');
const uuid = z.string().uuid('Choose a valid record.');
const identifier = required(120).regex(/^[A-Za-z0-9_-]+$/, 'Choose a valid work order.');
const decimalQuantity = text(30).regex(/^\d+(?:\.\d{1,3})?$/, 'Enter a positive quantity with up to three decimal places.').refine(value => {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) return true;
  const [whole, fraction = ''] = value.split('.');
  const quantity = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return quantity > 0n && quantity <= 9_000_000_000_000n;
}, 'Enter a positive quantity within the supported limit.');
const page = z.union([z.number().int().min(1).max(10_000), z.string().regex(/^[1-9]\d{0,4}$/).transform(Number).refine(value => value <= 10_000)])
  .default(1);
export const siteAlertsQuerySchema = z.object({
  workOrderId: identifier.optional(), status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
  page, search: text(200).default(''),
}).strict();
export const createSiteAlertSchema = z.object({
  workOrderId: identifier, assigneeId: uuid, itemId: uuid.nullable().default(null), itemName: text(200).default(''),
  note: text(2000).default(''), quantity: decimalQuantity.nullable().default(null), unit: text(24).default(''),
}).strict().superRefine((value, context) => {
  if (value.itemId && value.itemName) context.addIssue({ code: 'custom', path: ['itemName'], message: 'Choose an existing stock item or enter an item name, not both.' });
  if (!value.itemId && !value.itemName) context.addIssue({ code: 'custom', path: ['itemName'], message: 'Choose a stock item or enter its name.' });
  if (!value.itemId && value.quantity !== null && !value.unit) context.addIssue({ code: 'custom', path: ['unit'], message: 'Enter a unit for the requested quantity.' });
});
const envelope = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/), query: siteAlertsQuerySchema.default({ status: 'OPEN', page: 1, search: '' }),
};
export const siteAlertMutationSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('material_alert_create'), payload: createSiteAlertSchema }).strict(),
  z.object({ ...envelope, action: z.literal('material_alert_resolve'), payload: z.object({ id: uuid }).strict() }).strict(),
]);

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true });
const member = z.object({ userId: uuid, name: z.string(), role: z.enum(SITE_ALERT_ROLES) });
// Whitelist every public field, including nested choice lists. Directory email,
// account metadata and stock balances never pass through this response.
export const siteAlertsDataSchema = z.object({
  revision: count, serverTime: timestamp, user: member,
  alerts: z.array(z.object({
    id: uuid, workOrderId: identifier, workOrderNumber: z.string(), workOrderTitle: z.string(), siteAddress: z.string(),
    itemId: uuid.nullable(), itemName: z.string(), quantityMilli: count.max(9_000_000_000_000).nullable(), unit: z.string(), note: z.string(),
    assigneeId: uuid, assigneeName: z.string(), reportedBy: uuid, reportedByName: z.string(),
    status: z.enum(['OPEN', 'RESOLVED']), createdAt: timestamp, resolvedAt: timestamp.nullable(), resolvedBy: uuid.nullable(), resolvedByName: z.string().nullable(),
  })),
  total: count, page: z.number().int().min(1).max(10_000), pageSize: z.literal(50), openCount: count, resolvedCount: count,
  assignees: z.array(member), stockItems: z.array(z.object({ id: uuid, name: z.string(), unit: z.string() })),
  workOrders: z.array(z.object({ id: identifier, number: z.string(), title: z.string(), siteAddress: z.string() })),
});
