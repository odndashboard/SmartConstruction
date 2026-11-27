import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { canRecordWorkOrderPayment, MAX_PAYMENT_PAISE, paymentReceiptMaximum, paymentScheduleMaximum } from '../lib/work-order-payments.ts';

const sourceBytes = readFileSync(new URL('../components/PaymentsPanel.tsx', import.meta.url));
const source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
const ast = ts.createSourceFile('PaymentsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['money', 'date', 'field', 'required', 'paymentAmount', 'send', 'canRecord', 'title', 'editorKey', 'PaymentsPanel', 'AdministratorPayments', 'Stat', 'Empty', 'Field', 'Footer', 'AccountContext', 'PaymentEditor', 'InstallmentForm', 'ReceiptForm'];
const declarations = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join('\n');
const compiled = ts.transpileModule(`${declarations}\nexport { ${names.join(',')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const blank = () => null;
const methods = { BANK: 'Bank transfer', CASH: 'Cash', UPI: 'UPI' };
function load(state = React.useState) {
  const helpers = { useState: state, useRef: React.useRef, useEffect: React.useEffect, useCallback: React.useCallback,
    canRecordWorkOrderPayment, MAX_PAYMENT_PAISE, paymentReceiptMaximum, paymentScheduleMaximum,
    styles: new Proxy({}, { get: (_, key) => String(key) }), METHOD_LABELS: methods,
    ArrowDownLeft: blank, ArrowRight: blank, CalendarDays: blank, Check: blank, ChevronDown: blank, CircleAlert: blank, Clock3: blank, FileText: blank, IndianRupee: blank, LoaderCircle: blank, Plus: blank, ReceiptText: blank, ShieldCheck: blank, Wallet: blank, X: blank,
    // The browser builds FormData from a form; Node uses the same submitted fields.
    FormData: class extends FormData {
      constructor(submitted) { super(); for (const [key, value] of submitted) this.append(key, value); }
    },
  };
  const result = {};
  new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), result, ...Object.values(helpers));
  return result;
}
const lead = { id: 'won-lead', status: 'WON', isDemo: false };
const order = { id: 'manual-work', leadId: lead.id, quoteId: null, snapshot: null, status: 'PLANNED', isDemo: false };
const account = { workOrderId: order.id, number: 'WO/1', title: 'Manual Won project', customerName: 'Actual contact', contractPaise: null, outstandingPaise: null, receivedPaise: '25000', scheduledPaise: '0', overduePaise: '0', unallocatedPaise: '25000', overpaidPaise: '0' };
function props(accounts = [account]) { return { workspace: { workorders: [order], leads: [lead], members: [] }, data: { user: { userId: 'owner', role: 'OWNER', active: true }, permissions: { admin: true, canWrite: true }, today: '2026-11-27', extension: { paymentAccounts: accounts, paymentInstallments: [], customerPayments: [] } }, blocked: false, save: async () => true }; }
function fields(element) { return !React.isValidElement(element) ? [] : [element, ...React.Children.toArray(element.props.children).flatMap(fields)]; }
function submit(form, values) {
  let prevented = false;
  form.props.onSubmit({ currentTarget: values, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
}

test('Owner ledger opens the exact requested advance account and explains its unknown approved balance', () => {
  const views = load();
  const html = renderToStaticMarkup(React.createElement(views.PaymentsPanel, { ...props(), initialWorkOrderId: order.id }));
  assert.match(html, /Record a customer payment/); assert.match(html, /Manual Won project/);
  assert.match(html, /Not agreed/); assert.match(html, /Pending quotation/);
  assert.match(html, /Before quotation acceptance it remains an advance/);
  assert.match(html, /value="manual-work" selected/);
  assert.match(html, /₹250\.00/);
  assert.equal(sourceBytes.includes(Buffer.from([0xef, 0xbf, 0xbd])), false);
  assert.doesNotMatch(html, /\uFFFD/);
  assert.match(html, /Amount received \(₹\)/);
  const restricted = props(); restricted.data.user.role = 'ACCOUNTANT'; restricted.data.permissions.admin = false;
  const denied = renderToStaticMarkup(React.createElement(views.PaymentsPanel, { ...restricted, initialWorkOrderId: order.id }));
  assert.match(denied, /Administrator access required/); assert.doesNotMatch(denied, /Manual Won project|₹250/);
});

test('targeted payment forms never fall back to another account when the requested order disappears or becomes paid', () => {
  const views = load(initial => [initial, () => {}]);
  const other = { ...account, workOrderId: 'other-work', title: 'Different project' };
  for (const requested of [undefined, { ...account, contractPaise: '25000', outstandingPaise: '0' }]) {
    const input = props(requested ? [requested, other] : [other]); input.workspace.workorders.push({ ...order, id: 'other-work' });
    const committed = []; const errors = [];
    const form = views.ReceiptForm({ ...input, initialWorkOrder: order.id, disabled: false, commit: (...args) => committed.push(args), close() {}, report: value => errors.push(value) });
    const select = fields(form).find(node => node.type === 'select' && 'value' in node.props);
    assert.equal(select.props.value, order.id);
    const html = renderToStaticMarkup(form); assert.match(html, /Requested work order unavailable/);
    const submitted = new FormData(); submitted.set('amount', '10.00'); submitted.set('paymentDate', '2026-11-27'); submitted.set('method', 'BANK');
    submit(form, submitted);
    assert.equal(committed.length, 0); assert.match(errors[0], /unavailable/);
  }
});

test('advance form submits only its chosen work order and validates exact received amount', () => {
  const views = load(initial => [initial, () => {}]); const committed = []; const errors = [];
  const form = views.ReceiptForm({ ...props(), initialWorkOrder: order.id, disabled: false, commit: (...args) => committed.push(args), close() {}, report: value => errors.push(value) });
  const input = new FormData(); input.set('amount', '123.45'); input.set('paymentDate', '2026-11-27'); input.set('method', 'UPI'); input.set('reference', 'Actual receipt');
  submit(form, input);
  assert.deepEqual(committed[0], ['payment_record', { workOrderId: order.id, paymentDate: '2026-11-27', amount: '123.45', method: 'UPI', reference: 'Actual receipt', notes: '' }]);
  for (const amount of ['0', '-1', '1e3', '2.001', '90000000000.01']) { input.set('amount', amount); submit(form, input); }
  assert.equal(committed.length, 1); assert.equal(errors.length, 5);
});

test('agreed accounts cap new receipts and expose excess already received without fabricating outstanding debt', () => {
  const views = load(); const input = props([{ ...account, contractPaise: '10000', outstandingPaise: '0', overpaidPaise: '15000' }]);
  input.workspace.workorders = [{ ...order, quoteId: 'quote', snapshot: { id: 'quote', status: 'ACCEPTED' } }];
  const html = renderToStaticMarkup(React.createElement(views.PaymentsPanel, input));
  assert.match(html, /Excess received/); assert.match(html, /₹150\.00/); assert.match(html, /₹100\.00/);
  assert.doesNotMatch(html, /Pending quotation|Not agreed/);
  assert.throws(() => views.paymentAmount('100.01', 10000n), /cannot exceed/);
});
