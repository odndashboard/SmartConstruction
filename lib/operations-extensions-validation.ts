import { z } from 'zod';
import { REQUIRED_QUOTE_CATEGORIES } from './quotation-categories.ts';

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1, 'This field is required.');
const optional = (max: number) => text(max).default('');
const uuid = z.string().uuid('Choose a valid record.');
const identifier = required(120).regex(/^[A-Za-z0-9_-]+$/, 'Choose a valid work order.');
const date = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date.');
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a valid 24-hour time.');
function decimal(places: number, positive = true) {
  const syntax = new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`);
  return text(30).refine(value => syntax.test(value), `Enter up to ${places} decimal places.`).refine(value => {
    if (!syntax.test(value)) return true;
    const [whole, fraction = ''] = value.split('.');
    const scaled = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
    return scaled <= 9_000_000_000_000n && (positive ? scaled > 0n : scaled >= 0n);
  }, 'Enter an amount within the supported limit.');
}
const common = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
  month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
};
const reason = required(2000);
const shift = z.object({
  configured: z.boolean(), startLocal: clock.nullable().default(null), endLocal: clock.nullable().default(null),
  overnight: z.boolean().default(false), breakMinutes: z.number().int().min(0).max(1439).default(0),
  graceMinutes: z.number().int().min(0).max(120).default(0),
}).strict().superRefine((value, context) => {
  if (!value.configured) return;
  if (!value.startLocal || !value.endLocal) {
    context.addIssue({ code: 'custom', message: 'Set shift start and finish times.' }); return;
  }
  const minute = (input: string) => Number(input.slice(0, 2)) * 60 + Number(input.slice(3));
  const duration = minute(value.endLocal) - minute(value.startLocal) + (value.overnight ? 1440 : 0);
  if (duration <= 0 || duration > 1440) context.addIssue({ code: 'custom', message: 'Check the shift times and overnight setting.' });
  if (value.breakMinutes >= duration) context.addIssue({ code: 'custom', path: ['breakMinutes'], message: 'The break must be shorter than the shift.' });
});
function unique<T extends Record<string, unknown>>(rows: T[], key: keyof T) { return new Set(rows.map(row => row[key])).size === rows.length; }
const orderLines = z.array(z.object({ itemId: uuid, quantity: decimal(3) }).strict()).min(1).max(25)
  .refine(rows => unique(rows, 'itemId'), 'Use one line for each stock item.');
const receiveLines = z.array(z.object({ lineId: uuid, quantity: decimal(3) }).strict()).min(1).max(25)
  .refine(rows => unique(rows, 'lineId'), 'Each order line can appear only once.');
const jobMaterialCategory = z.enum(REQUIRED_QUOTE_CATEGORIES);

export const extensionMutationOptions = [
  z.object({ ...common, action: z.literal('site_save'), payload: z.object({ id: uuid.optional(), name: required(200), address: optional(1000), workOrderId: identifier.nullable().default(null) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('site_active'), payload: z.object({ id: uuid, active: z.boolean() }).strict() }).strict(),
  z.object({ ...common, action: z.literal('site_assign'), payload: z.object({ userId: uuid, siteId: uuid.nullable() }).strict() }).strict(),
  z.object({ ...common, action: z.literal('shift_rule_save'), payload: shift }).strict(),
  z.object({ ...common, action: z.literal('attendance_overtime_approve'), payload: z.object({ id: uuid, minutes: z.number().int().min(0).max(525_600), reason }).strict() }).strict(),
  z.object({ ...common, action: z.literal('stock_location_move'), payload: z.object({ itemId: uuid, siteId: uuid, type: z.enum(['IN', 'OUT', 'ADJUST']), quantity: decimal(3, false), note: optional(2000), reference: optional(200) }).strict().superRefine((value, context) => {
    if (value.type === 'ADJUST' && !value.note) context.addIssue({ code: 'custom', path: ['note'], message: 'Give a reason for the balance correction.' });
    if (value.type !== 'ADJUST' && /^0+(?:\.0+)?$/.test(value.quantity)) context.addIssue({ code: 'custom', path: ['quantity'], message: 'Quantity must be greater than zero.' });
  }) }).strict(),
  z.object({ ...common, action: z.literal('stock_transfer'), payload: z.object({ itemId: uuid, fromSiteId: uuid, toSiteId: uuid, quantity: decimal(3), note: optional(2000), reference: optional(200) }).strict().refine(value => value.fromSiteId !== value.toSiteId, 'Choose different source and destination sites.') }).strict(),
  z.object({ ...common, action: z.literal('stock_return'), payload: z.object({ movementId: uuid, quantity: decimal(3), siteId: uuid.optional(), reason }).strict() }).strict(),
  z.object({ ...common, action: z.literal('job_material_issue'), payload: z.object({ workOrderId: identifier, category: jobMaterialCategory, itemId: uuid, siteId: uuid, quantity: decimal(3) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('job_filing_complete'), payload: z.object({ workOrderId: identifier }).strict() }).strict(),
  z.object({ ...common, action: z.literal('material_request_create'), payload: z.object({ siteId: uuid, itemId: uuid, quantity: decimal(3), neededOn: date.nullable().default(null), note: optional(2000) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('material_request_cancel'), payload: z.object({ id: uuid, reason }).strict() }).strict(),
  z.object({ ...common, action: z.literal('material_request_review'), payload: z.object({ id: uuid, status: z.enum(['APPROVED', 'REJECTED']), note: optional(2000) }).strict().refine(value => value.status !== 'REJECTED' || !!value.note, 'Give a reason for rejecting the request.') }).strict(),
  z.object({ ...common, action: z.literal('material_request_fulfill'), payload: z.object({ id: uuid, fromSiteId: uuid, quantity: decimal(3), reference: optional(200) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('purchase_order_create'), payload: z.object({ supplier: required(200), siteId: uuid, expectedOn: date.nullable().default(null), reference: optional(200), notes: optional(2000), lines: orderLines }).strict() }).strict(),
  z.object({ ...common, action: z.literal('purchase_order_receive'), payload: z.object({ id: uuid, lines: receiveLines, reference: optional(200) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('purchase_order_cancel'), payload: z.object({ id: uuid, reason }).strict() }).strict(),
  z.object({ ...common, action: z.literal('payment_installment_add'), payload: z.object({ workOrderId: identifier, title: required(200), dueDate: date, amount: decimal(2) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('payment_installment_cancel'), payload: z.object({ id: uuid, reason }).strict() }).strict(),
  z.object({ ...common, action: z.literal('payment_record'), payload: z.object({ workOrderId: identifier, paymentDate: date, amount: decimal(2), method: z.enum(['CASH', 'BANK', 'UPI', 'CHEQUE', 'OTHER']), reference: optional(200), notes: optional(2000) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('payment_void'), payload: z.object({ id: uuid, reason }).strict() }).strict(),
] as const;

export const receiptIdentitySchema = z.object({
  expenseId: uuid, requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export const receiptIdSchema = uuid;
