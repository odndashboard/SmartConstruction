import { z } from 'zod';
import { EXPENSE_CATEGORIES, TEAM_ACTIVITY_MODULES } from './operations-types.ts';
import { todayIST } from './finance.ts';
import { extensionMutationOptions } from './operations-extensions-validation.ts';

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => text(max).min(1, 'This field is required.');
const optionalText = (max: number) => text(max).default('');
const uuid = z.string().uuid('Choose a valid record.');
const MAX_SCALED = 9_000_000_000_000n;

/** Exact decimal conversion for validation; no floating-point arithmetic. */
export function scaledDecimal(value: string, places: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
}
function decimal(places: number, positive = false) {
  const syntax = new RegExp(`^\\d+(?:\\.\\d{1,${places}})?$`);
  return text(30).refine(value => syntax.test(value), `Enter a number with up to ${places} decimal places.`)
    .refine(value => {
      if (!syntax.test(value)) return true;
      const amount = scaledDecimal(value, places);
      return amount <= MAX_SCALED && (positive ? amount > 0n : amount >= 0n);
    }, positive ? 'Enter a positive amount within the supported limit.' : 'The amount exceeds the supported limit.');
}

export const operationsMonthSchema = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/, 'Choose a valid month.');
const calendarDate = z.string().regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date.');
const timestamp = z.string().datetime({ offset: true, message: 'Enter a valid date and time with its time zone.' });
const quantity = decimal(3);
const itemPayload = z.object({
  id: uuid.optional(), sku: required(64), name: required(200), unit: required(24),
  location: optionalText(200), minQuantity: quantity.default('0'), openingQuantity: quantity.default('0'),
}).strict().superRefine((value, context) => {
  if (value.id && /^\d+(?:\.\d{1,3})?$/.test(value.openingQuantity) && scaledDecimal(value.openingQuantity, 3) !== 0n) {
    context.addIssue({ code: 'custom', path: ['openingQuantity'], message: 'Use a stock movement to change an existing balance.' });
  }
});
const movementPayload = z.object({
  itemId: uuid, type: z.enum(['IN', 'OUT', 'ADJUST']), quantity,
  note: optionalText(2000), reference: optionalText(200),
}).strict().superRefine((value, context) => {
  if (value.type !== 'ADJUST' && /^\d+(?:\.\d{1,3})?$/.test(value.quantity) && scaledDecimal(value.quantity, 3) === 0n) {
    context.addIssue({ code: 'custom', path: ['quantity'], message: 'Stock in or out must be greater than zero.' });
  }
  if (value.type === 'ADJUST' && !value.note) context.addIssue({ code: 'custom', path: ['note'], message: 'Explain why the stock balance needs correction.' });
});
const attendanceCorrectionPayload = z.object({
  userId: uuid, workDate: calendarDate, status: z.enum(['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE']),
  checkIn: timestamp.nullable().default(null), checkOut: timestamp.nullable().default(null),
  site: optionalText(200), notes: optionalText(2000), reason: required(2000),
  siteId: uuid.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (['ABSENT', 'LEAVE'].includes(value.status) && (value.checkIn || value.checkOut)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Absent and leave records cannot have check-in or check-out times.' });
  }
  if (value.checkOut && !value.checkIn) context.addIssue({ code: 'custom', path: ['checkIn'], message: 'Enter a check-in time before a check-out time.' });
  if (value.checkIn && value.checkOut && new Date(value.checkOut).getTime() <= new Date(value.checkIn).getTime()) {
    context.addIssue({ code: 'custom', path: ['checkOut'], message: 'Check-out must be after check-in.' });
  }
  if (value.checkIn && !Number.isNaN(new Date(value.checkIn).getTime()) && todayIST(new Date(value.checkIn)) !== value.workDate) {
    context.addIssue({ code: 'custom', path: ['checkIn'], message: 'Check-in must fall on the attendance date in India time.' });
  }
});
const expensePayload = z.object({
  id: uuid.optional(), expenseDate: calendarDate, title: required(200), category: z.enum(EXPENSE_CATEGORIES),
  amount: decimal(2, true), site: optionalText(200), reference: optionalText(200), notes: optionalText(2000),
}).strict();
const reviewPayload = z.object({
  id: uuid, status: z.enum(['APPROVED', 'REJECTED', 'PAID']), note: optionalText(2000),
}).strict().superRefine((value, context) => {
  if (value.status === 'REJECTED' && !value.note) context.addIssue({ code: 'custom', path: ['note'], message: 'Give the employee a reason for rejecting this expense.' });
});
const common = {
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_-]+$/), month: operationsMonthSchema,
};
export const operationsMutationSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('stock_item_save'), payload: itemPayload }).strict(),
  z.object({ ...common, action: z.literal('stock_item_active'), payload: z.object({ id: uuid, active: z.boolean() }).strict() }).strict(),
  z.object({ ...common, action: z.literal('stock_move'), payload: movementPayload }).strict(),
  z.object({ ...common, action: z.literal('attendance_check_in'), payload: z.object({ site: optionalText(200), siteId: uuid.nullable().optional(), notes: optionalText(2000) }).strict() }).strict(),
  z.object({ ...common, action: z.literal('attendance_check_out'), payload: z.object({}).strict() }).strict(),
  z.object({ ...common, action: z.literal('attendance_correct'), payload: attendanceCorrectionPayload }).strict(),
  z.object({ ...common, action: z.literal('expense_save'), payload: expensePayload }).strict(),
  z.object({ ...common, action: z.literal('expense_withdraw'), payload: z.object({ id: uuid }).strict() }).strict(),
  z.object({ ...common, action: z.literal('expense_review'), payload: reviewPayload }).strict(),
  ...extensionMutationOptions,
]);
export type ValidatedOperationsMutation = z.infer<typeof operationsMutationSchema>;

export const teamActivityQuerySchema = z.object({
  month: operationsMonthSchema,
  employeeId: uuid.optional(),
  module: z.enum(TEAM_ACTIVITY_MODULES).default('all'),
  page: z.string().regex(/^[1-9]\d{0,4}$/, 'Choose a valid activity page.')
    .transform(Number).refine(value => value <= 10_000, 'The activity page is outside the supported range.').default(1),
}).strict();
