import assert from 'node:assert/strict';
import test from 'node:test';
import { canRecordWorkOrderPayment, MAX_PAYMENT_PAISE, paymentReceiptMaximum, paymentScheduleMaximum } from '../lib/work-order-payments.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import { operationsMutationSchema } from '../lib/operations-validation.ts';
import type { PaymentAccount } from '../lib/operations-extensions.ts';
import type { Lead, Quotation, WorkspaceData, WorkOrder } from '../lib/types.ts';

const lead = { id: 'lead', status: 'WON', isDemo: false } as Lead;
const provisional = { id: 'manual-work', leadId: lead.id, quoteId: null, snapshot: null, status: 'PLANNED', isDemo: false } as WorkOrder;
const quote = { id: 'accepted', leadId: lead.id, status: 'ACCEPTED' } as Quotation;
const approved = { ...provisional, id: 'approved-work', quoteId: quote.id, snapshot: quote };
const workspace = (orders = [provisional]): WorkspaceData => ({ revision: 1, company: { ...DEFAULT_COMPANY }, user: { userId: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'OWNER', active: true }, members: [], customers: [], leads: [lead], quotations: [quote], followups: [], workorders: orders, activity: [], sequences: {} });
const account: PaymentAccount = { workOrderId: provisional.id, number: 'WO/1', title: 'Manual Won project', customerName: 'Actual contact', contractPaise: null, outstandingPaise: null,
  receivedPaise: '25000', scheduledPaise: '0', overduePaise: '0', unallocatedPaise: '25000', overpaidPaise: '0' };

test('legitimate real Won work orders support advances without a fabricated approved quote', () => {
  assert.equal(canRecordWorkOrderPayment(workspace(), provisional.id), true);
  assert.equal(canRecordWorkOrderPayment(workspace([approved]), approved.id), true);
  assert.equal(canRecordWorkOrderPayment(workspace([{ ...provisional, status: 'COMPLETED' }]), provisional.id), true);
  for (const order of [{ ...provisional, status: 'CANCELLED' as const }, { ...provisional, isDemo: true }, { ...provisional, leadId: undefined }, { ...approved, snapshot: { ...quote, status: 'DRAFT' as const } }, { ...approved, quoteId: 'different' }]) {
    assert.equal(canRecordWorkOrderPayment(workspace([order]), order.id), false);
  }
  assert.equal(canRecordWorkOrderPayment({ ...workspace(), leads: [{ ...lead, status: 'NEW' }] }, provisional.id), false);
  assert.equal(canRecordWorkOrderPayment({ ...workspace(), leads: [{ ...lead, isDemo: true }] }, provisional.id), false);
  assert.equal(canRecordWorkOrderPayment(workspace(), 'missing'), false);
});

test('advances retain exact receipt limits while instalments require an agreed amount', () => {
  assert.equal(paymentReceiptMaximum(account), MAX_PAYMENT_PAISE);
  assert.equal(paymentScheduleMaximum(account), 0n);
  const agreed = { ...account, contractPaise: '100000', outstandingPaise: '75000', scheduledPaise: '30000' };
  assert.equal(paymentReceiptMaximum(agreed), 75000n); assert.equal(paymentScheduleMaximum(agreed), 70000n);
  assert.equal(paymentReceiptMaximum({ ...agreed, outstandingPaise: '0', overpaidPaise: '25000' }), 0n);
  assert.equal(paymentScheduleMaximum({ ...agreed, scheduledPaise: '100000' }), 0n);
});

test('advance payment requests keep the existing positive decimal, calendar and method validation', () => {
  const input = { action: 'payment_record', expectedRevision: 1, requestId: 'advance-0001', month: '2026-11', payload: { workOrderId: provisional.id, paymentDate: '2026-11-27', amount: '250.50', method: 'UPI' } };
  assert.equal(operationsMutationSchema.safeParse(input).success, true);
  for (const amount of ['0', '-1', '2.001', '1e3', 'NaN', 'Infinity', 10, true, null, '90000000000.01']) assert.equal(operationsMutationSchema.safeParse({ ...input, payload: { ...input.payload, amount } }).success, false);
  for (const extra of [{ contractPaise: '999999' }, { outstandingPaise: '999999' }, { approved: true }, { quoteId: 'accepted' }]) assert.equal(operationsMutationSchema.safeParse({ ...input, payload: { ...input.payload, ...extra } }).success, false);
  assert.equal(operationsMutationSchema.safeParse({ ...input, payload: { ...input.payload, paymentDate: '2026-02-30' } }).success, false);
});
