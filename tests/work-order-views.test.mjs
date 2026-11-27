import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { WORK_LABELS, WORK_TRANSITIONS } from '../lib/work-order-status.ts';
import { canRecordWorkOrderPayment } from '../lib/work-order-payments.ts';

// Exercise the real work-order views without starting the dashboard or network clients.
function loadFunctions(path, names, helpers = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declarations = names.map(name => {
    const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `Missing function ${name}`);
    return node.getText(ast);
  }).join('\n');
  const compiled = ts.transpileModule(`${declarations}\nexport { ${names.join(',')} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), exports, ...Object.values(helpers));
  return exports;
}
const blank = () => null;
const wrapper = ({ children }) => React.createElement('span', null, children);
const helpers = {
  Badge: wrapper, DemoTag: blank, IconButton: wrapper, Avatar: blank, Notes: wrapper, FollowupRow: blank,
  Plus: blank, MoreHorizontal: blank, CalendarDays: blank, HardHat: () => null, ArrowUpRight: blank,
  Pencil: blank, Check: blank, CircleAlert: blank, FileText: blank, ChevronRight: blank,
  RefreshCw: blank, ArrowRight: blank, Printer: blank, CheckCircle2: blank, ChevronDown: blank,
  WORK_LABELS, WORK_TRANSITIONS, canRecordWorkOrderPayment, IndianRupee: blank,
  QUOTE_LABELS: { ACCEPTED: 'Accepted' },
  ownerName: () => 'Project owner', displayDate: value => value || 'Not scheduled',
  formatINR: value => `₹${(value / 100).toFixed(2)}`, leadLabel: value => value, stateLabel: value => value,
  effectiveQuoteStatus: quote => quote.status,
  customerForLead: () => ({ name: 'Customer from lead' }),
  Totals: ({ totals }) => React.createElement('span', null, `Approved quote ${totals.total}`),
};
const views = loadFunctions('../components/CRMApp.tsx', ['WorkCard', 'WorkActions', 'WorkDetail', 'LeadDetail', 'QuoteDetail', 'workOrderLeadId', 'DetailField'], helpers);
const canRecord = canRecordWorkOrderPayment;
const lead = {
  id: 'lead-test', customerId: 'customer-test', title: 'Solar installation', status: 'WON',
  contact: 'Project contact', phone: '1234567890', email: '', expectedKw: 10.5, value: 99999,
  owner: 'owner-test', siteAddress: 'Project site', notes: 'Roof assessment and installation',
};
const unquoted = {
  id: 'work-test', leadId: lead.id, automaticForLead: true, quoteId: null, snapshot: null,
  number: 'WO/2026/001', title: lead.title, customerName: 'Project contact', siteAddress: lead.siteAddress,
  expectedKw: 0, owner: lead.owner, startDate: '', endDate: '', status: 'PLANNED', milestones: [], isDemo: false,
};
const quote = {
  id: 'quote-test', leadId: lead.id, number: 'Q/2026/001', title: lead.title, revision: 1, status: 'ACCEPTED',
  customer: { name: 'Approved customer' }, validUntil: '2026-12-31', placeOfSupply: '06',
  siteAddress: lead.siteAddress, terms: 'Approved payment terms', acceptanceNote: 'Customer approval recorded',
  items: [{ id: 'item-test', description: 'Approved solar scope', quantity: '1', unit: 'job', hsnSac: '9954', unitPrice: '123.45', gstRate: '0', total: 12345 }],
  totals: { total: 12345, mode: 'CGST_SGST', needsConfig: false },
};
const quoted = { ...unquoted, quoteId: quote.id, snapshot: quote };
function workspace(workorders = [unquoted]) {
  return { user: { role: 'OWNER' }, members: [], customers: [], leads: [lead], quotations: [quote], followups: [], workorders };
}
function render(name, props) { return renderToStaticMarkup(React.createElement(views[name], props)); }
function children(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(children)];
}

test('lead-only work orders show project details and planning without an approved amount or quotation link', () => {
  const data = workspace();
  const card = render('WorkCard', { item: unquoted, data, open() {} });
  assert.match(card, /Planned/);
  assert.match(card, /Awaiting quotation/);
  assert.doesNotMatch(card, /₹/);
  const opened = [];
  const detail = views.WorkDetail({ item: unquoted, data, delivery: true, busy: false, open: target => opened.push(target), mutate() {} });
  const html = renderToStaticMarkup(detail);
  for (const value of ['Awaiting accepted quotation', '0 kW', lead.contact, lead.phone, lead.siteAddress, lead.notes, 'Add milestone', 'Update progress', 'View lead']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /Agreed total|Agreed scope|View quotation|₹/);
  const link = children(detail).find(item => item.type === 'button' && React.Children.toArray(item.props.children).includes('View lead '));
  assert.ok(link);
  link.props.onClick();
  assert.deepEqual(opened, [{ type: 'lead_detail', id: lead.id }]);
});

test('existing quotation-backed work orders retain approved scope, pricing and document links', () => {
  // Historic work orders may not have the newer leadId field.
  const historical = { ...quoted, leadId: undefined, expectedKw: undefined };
  const data = workspace([historical]);
  const card = render('WorkCard', { item: historical, data, open() {} });
  assert.match(card, /₹123.45/);
  const html = render('WorkDetail', { item: historical, data, delivery: true, busy: false, open() {}, mutate() {} });
  for (const value of ['Agreed total incl. GST', '₹123.45', quote.items[0].description, quote.terms, 'View quotation', 'View lead', '10.5 kW']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /Awaiting accepted quotation/);
});

test('No GST work orders label the agreed total without claiming included tax', () => {
  const snapshot = { ...quote, gstEnabled: false, totals: { ...quote.totals, mode: 'NO_GST' } };
  const item = { ...quoted, snapshot };
  const html = render('WorkDetail', { item, data: workspace([item]), delivery: false, busy: false, open() {}, mutate() {} });
  assert.match(html, /Agreed total/);
  assert.match(html, /₹123.45/);
  assert.doesNotMatch(html, /incl\. GST/);
});

test('lead details open each associated work order', () => {
  const extra = { ...quoted, id: 'work-extra', number: 'WO/2026/002' };
  const data = workspace([unquoted, extra]);
  const opened = [];
  const detail = views.LeadDetail({ lead, data, permissions: {}, busy: false, open: target => opened.push(target) });
  const html = renderToStaticMarkup(detail);
  assert.ok(html.includes(unquoted.number));
  assert.ok(html.includes(extra.number));
  const links = children(detail).filter(item => item.type === 'button' && item.props.className === 'document-link' && React.Children.toArray(item.props.children).some(child => React.isValidElement(child) && child.type === helpers.HardHat));
  assert.equal(links.length, 2);
  links.forEach(link => link.props.onClick());
  assert.deepEqual(opened, [{ type: 'work_detail', id: unquoted.id }, { type: 'work_detail', id: extra.id }]);
});

test('completed orders show payment and status actions on the card and details, with role-specific access', () => {
  const order = { ...quoted, status: 'COMPLETED' };
  const data = workspace([order]);
  for (const view of ['WorkCard', 'WorkDetail']) {
    const html = render(view, { item: order, data, delivery: true, busy: false, open() {}, mutate() {} });
    assert.match(html, /Record payment/);
    assert.match(html, /Change status/);
  }
  for (const role of ['OWNER', 'MANAGER', 'OPERATIONS', 'ACCOUNTANT', 'SALES', 'VIEWER']) {
    const opened = [];
    const picker = views.WorkActions({ item: order, data: { ...data, user: { role } }, open: target => opened.push(target) });
    for (const button of children(picker).filter(element => element.type === 'button')) button.props.onClick();
    const expected = [];
    if (role === 'OWNER') expected.push({ type: 'work_payment', id: order.id });
    if (['OWNER', 'MANAGER', 'OPERATIONS'].includes(role)) expected.push({ type: 'work_status', id: order.id });
    assert.deepEqual(opened, expected);
  }
  const cancelled = { ...order, status: 'CANCELLED' };
  assert.equal(views.WorkActions({ item: cancelled, data: workspace([cancelled]), open() {} }), null);
});

test('changing the completed order in the status form saves only its ID and new status', async () => {
  const order = { ...quoted, status: 'COMPLETED' };
  const calls = [];
  let selected = order.status;
  let closed = false;
  const { WorkStatusForm } = loadFunctions('../components/CRMApp.tsx', ['WorkStatusForm'], {
    WORK_LABELS, WORK_TRANSITIONS, Field: wrapper, FormFooter: blank,
    useState: () => [selected, next => { selected = next; }],
  });
  const props = { item: order, busy: false, close: () => { closed = true; }, mutate: async (...args) => { calls.push(args); return workspace([order]); } };
  const form = WorkStatusForm(props);
  const select = children(form).find(element => element.type === 'select');
  assert.deepEqual(children(select).filter(element => element.type === 'option').map(element => element.props.value), ['COMPLETED', 'ACTIVE']);
  await form.props.onSubmit({ preventDefault() {} });
  assert.equal(calls.length, 0);
  select.props.onChange({ target: { value: 'ACTIVE' } });
  await WorkStatusForm(props).props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [['workorder_save', { id: order.id, status: 'ACTIVE' }, false]]);
  assert.equal(closed, true);
});

test('accepted quotations open their own linked work order and missing links retain safe recovery', () => {
  const props = { quote, permissions: { approve: true }, open() {}, busy: false, mutate() {}, print() {} };
  const linked = render('QuoteDetail', { ...props, data: workspace([quoted]) });
  assert.match(linked, /Open work order/);
  assert.doesNotMatch(linked, /Create work order|Link accepted quotation/);
  const pending = render('QuoteDetail', { ...props, data: workspace([unquoted]) });
  assert.match(pending, /Link accepted quotation/);
  assert.doesNotMatch(pending, /Create work order/);
  const differentScope = { ...quoted, quoteId: 'another-quote', snapshot: { ...quote, id: 'another-quote' } };
  const additional = render('QuoteDetail', { ...props, data: workspace([differentScope]) });
  assert.match(additional, /Create work order/);
  assert.doesNotMatch(additional, /Open work order|Link accepted quotation/);
});

test('each accepted quotation opens its own automatically generated scope', () => {
  const secondQuote = { ...quote, id: 'quote-second', title: 'Additional approved scope' };
  const secondOrder = { ...quoted, id: 'work-second', quoteId: secondQuote.id, snapshot: secondQuote };
  const data = { ...workspace([quoted, secondOrder]), quotations: [quote, secondQuote] };
  const opened = [];
  const tree = views.QuoteDetail({ quote: secondQuote, data, permissions: { approve: true }, open: target => opened.push(target), busy: false, mutate() {}, print() {} });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Open work order/);
  assert.doesNotMatch(html, /Create work order|Link accepted quotation/);
  const link = children(tree).find(item => item.type === 'button' && React.Children.toArray(item.props.children).includes('Open work order '));
  assert.ok(link);
  link.props.onClick();
  assert.deepEqual(opened, [{ type: 'work_detail', id: secondOrder.id }]);
});

test('payment entry supports advances for Won lead work orders and excludes cancelled or example records', () => {
  assert.equal(canRecord(workspace(), unquoted.id), true);
  assert.equal(canRecord(workspace([quoted]), quoted.id), true);
  assert.equal(canRecord(workspace([{ ...quoted, status: 'CANCELLED' }]), quoted.id), false);
  assert.equal(canRecord(workspace([{ ...unquoted, isDemo: true }]), unquoted.id), false);
  assert.equal(canRecord({ ...workspace(), leads: [{ ...lead, status: 'NEW' }] }, unquoted.id), false);
  assert.equal(canRecord({ ...workspace(), leads: [] }, unquoted.id), false);
});
