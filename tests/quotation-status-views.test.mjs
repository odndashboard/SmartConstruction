import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { REQUIRED_QUOTE_CATEGORIES, getMissingQuoteCategories } from '../lib/quotation-categories.ts';

// Compile the actual status form and views with controlled hook state so tests
// can exercise select/change/submit handlers without the dashboard network client.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['QuoteStatusForm', 'quoteStatusAction', 'QuoteTable', 'QuoteDetail', 'Field', 'DetailField', 'workOrderLeadId', 'modalAfterClose'];
const code = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing function ${name}`);
  return node.getText(ast);
}).join('\n');
let values = [];
let cursor = 0;
const blank = () => null;
const wrapper = ({ children }) => React.createElement('span', null, children);
const labels = { DRAFT: 'Draft', ISSUED: 'Awaiting approval', ACCEPTED: 'Accepted', EXPIRED: 'Expired', DECLINED: 'Declined', SUPERSEDED: 'Superseded' };
const footer = ({ disabled, busy, onClose, label }) => React.createElement('div', null,
  React.createElement('button', { type: 'button', onClick: onClose }, 'Cancel'),
  React.createElement('button', { type: 'submit', disabled: disabled || busy }, label));
const helpers = {
  useState(initial) {
    const index = cursor++;
    if (!(index in values)) values[index] = initial;
    return [values[index], value => { values[index] = value; }];
  },
  Badge: wrapper, DemoTag: blank, IconButton: wrapper, Empty: blank, Notes: wrapper, Totals: blank,
  FormFooter: footer, Building2: blank, CalendarDays: blank, RefreshCw: blank, ArrowRight: blank,
  ChevronDown: blank, ArrowUpRight: blank, Printer: blank, Pencil: blank, Check: blank, FileText: blank,
  CheckCircle2: blank, HardHat: blank,
  getMissingQuoteCategories, QUOTE_LABELS: labels, todayIST: () => '2026-11-27',
  effectiveQuoteStatus: quote => quote.status === 'ISSUED' && quote.validUntil < '2026-11-27' ? 'EXPIRED' : quote.status,
  customerForLead: data => data.customers[0], displayDate: value => value, stateLabel: value => value,
  formatINR: value => `INR ${value / 100}`,
};
const compiled = ts.transpileModule(`${code}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const quote = { id: 'quote-test', leadId: 'lead-test', number: 'Q/2026/001', title: 'Solar project', revision: 1,
  status: 'ISSUED', validUntil: '2026-12-20', totals: { total: 10000, mode: 'CGST_SGST', needsConfig: false }, items: REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ id: `item-${index}`, category, description: `Reviewed ${category} scope`, quantity: '1', unit: 'job', unitPrice: '0', discount: '0', gstRate: '0' })), siteAddress: 'Site', placeOfSupply: '06', terms: '' };
function workspace(role = 'OWNER') {
  return { user: { role }, customers: [{ id: 'customer-test', name: 'Customer', address: 'Actual test billing address' }],
    leads: [{ id: quote.leadId, customerId: 'customer-test', status: 'WON' }], quotations: [quote],
    workorders: [{ id: 'work-test', quoteId: quote.id, leadId: quote.leadId }] };
}
function fields(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(fields)];
}
function field(tree, name) { return fields(tree).find(item => item.props.name === name); }
function button(tree, label) {
  return fields(tree).find(item => item.type === 'button' && React.Children.toArray(item.props.children).some(child => typeof child === 'string' && child.trim() === label));
}
function renderForm(record = quote, data = workspace(), options = {}) {
  cursor = 0;
  return views.QuoteStatusForm({ quote: record, data, busy: false, close() {}, mutate: async () => data, open() {}, ...options });
}
function reset() { values = []; }
async function submit(tree) { await tree.props.onSubmit({ preventDefault() {} }); }

test('quotation list and details expose a labeled status action to Admin and Manager, including drafts', () => {
  const draft = { ...quote, status: 'DRAFT', number: null };
  for (const role of ['OWNER', 'MANAGER']) {
    const data = workspace(role);
    const opened = [];
    const table = views.QuoteTable({ data, quotes: [draft], open: target => opened.push(target) });
    const shortcut = button(table, 'Change status');
    assert.ok(shortcut);
    assert.equal(shortcut.props.className.includes('quote-status-shortcut'), true);
    shortcut.props.onClick();
    assert.deepEqual(opened, [{ type: 'quote_status', id: quote.id }]);
    const detail = views.QuoteDetail({ quote: draft, data, permissions: { approve: true }, open() {}, busy: false, mutate() {}, print() {} });
    assert.ok(button(detail, 'Change status'));
  }
  const table = views.QuoteTable({ data: workspace('SALES'), quotes: [draft], open() {} });
  assert.equal(button(table, 'Change status'), undefined);
});

test('draft dropdown issues intentionally as Awaiting approval, never accepting directly', async () => {
  reset(); const draft = { ...quote, status: 'DRAFT', number: null };
  const calls = []; const opened = [];
  const options = { mutate: async (action, payload) => { calls.push({ action, payload }); return workspace(); }, open: target => opened.push(target) };
  let tree = renderForm(draft, workspace(), options);
  const select = field(tree, 'status');
  const choices = fields(select).filter(item => item.type === 'option');
  assert.equal(choices.find(item => item.props.value === 'ISSUED').props.disabled, false);
  assert.equal(choices.find(item => item.props.value === 'ACCEPTED').props.disabled, true);
  assert.equal(choices.find(item => item.props.value === 'EXPIRED').props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /Choose Awaiting approval to issue this draft/);
  select.props.onChange({ target: { value: 'ISSUED' } });
  assert.equal(calls.length, 0, 'changing the dropdown must not perform a mutation');
  tree = renderForm(draft, workspace(), options);
  await submit(tree);
  assert.deepEqual(calls, [{ action: 'quote_issue', payload: { id: quote.id } }]);
  assert.deepEqual(opened, [{ type: 'quote_detail', id: quote.id }]);
});

test('draft billing shortcut handles blank and missing addresses and preserves return navigation', async () => {
  for (const address of ['', undefined]) {
    reset(); const data = workspace(); data.customers[0].address = address;
    const draft = { ...quote, status: 'DRAFT' }; const calls = []; const opened = [];
    const options = { mutate: async (...args) => { calls.push(args); return data; }, open: target => opened.push(target) };
    let tree = renderForm(draft, data, options);
    const shortcut = button(tree, 'Edit billing details');
    assert.ok(shortcut); shortcut.props.onClick();
    assert.deepEqual(opened, [{ type: 'customer', id: 'customer-test', quoteStatusId: quote.id }]);
    field(tree, 'status').props.onChange({ target: { value: 'ISSUED' } });
    tree = renderForm(draft, data, options); await submit(tree);
    assert.equal(calls.length, 0);
    assert.deepEqual(views.modalAfterClose(opened[0]), { type: 'quote_status', id: quote.id });
  }
  assert.equal(views.modalAfterClose({ type: 'customer', id: 'customer-test' }), null);
});

test('legacy draft status identifies missing required categories and opens its own work-item editor', async () => {
  reset(); const data = workspace(); data.customers[0].address = '';
  const legacy = { ...quote, status: 'DRAFT', items: [{ id: 'old-item', description: 'Actual package scope', unitPrice: '1000' }, quote.items[0]] };
  const frozen = structuredClone(legacy);
  const calls = []; const opened = [];
  const options = { mutate: async (...args) => { calls.push(args); return data; }, open: target => opened.push(target) };
  let tree = renderForm(legacy, data, options);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Required work items needed/);
  for (const category of REQUIRED_QUOTE_CATEGORIES.slice(1)) assert.ok(html.includes(category));
  assert.ok(button(tree, 'Edit billing details'));
  button(tree, 'Edit work items').props.onClick();
  assert.deepEqual(opened, [{ type: 'quote', id: quote.id }]);
  field(tree, 'status').props.onChange({ target: { value: 'ISSUED' } });
  data.customers[0].address = 'Genuine billing address';
  tree = renderForm(legacy, data, options); await submit(tree);
  assert.equal(calls.length, 0);
  assert.deepEqual(legacy, frozen);
});

test('acceptance requires a reference, uses the existing action, then returns to the same quotation', async () => {
  reset(); const calls = []; const opened = [];
  const options = { mutate: async (action, payload) => { calls.push({ action, payload }); return workspace(); }, open: target => opened.push(target) };
  let tree = renderForm(quote, workspace(), options);
  field(tree, 'status').props.onChange({ target: { value: 'ACCEPTED' } });
  tree = renderForm(quote, workspace(), options);
  const note = field(tree, 'acceptanceNote'); assert.ok(note); assert.equal(note.props.required, true);
  await submit(tree); assert.equal(calls.length, 0);
  note.props.onChange({ target: { value: '  Customer approved by email today.  ' } });
  tree = renderForm(quote, workspace(), options); await submit(tree);
  assert.deepEqual(calls, [{ action: 'quote_accept', payload: { id: quote.id, acceptanceNote: 'Customer approved by email today.' } }]);
  assert.deepEqual(opened, [{ type: 'quote_detail', id: quote.id }]);
});

test('expiry and reopening use dedicated actions within the original validity date', async () => {
  for (const [record, target, expected] of [[quote, 'EXPIRED', 'quote_expire'], [{ ...quote, status: 'EXPIRED' }, 'ISSUED', 'quote_reopen']]) {
    reset(); const calls = []; const options = { mutate: async (action, payload) => { calls.push({ action, payload }); return workspace(); } };
    let tree = renderForm(record, workspace(), options);
    field(tree, 'status').props.onChange({ target: { value: target } });
    tree = renderForm(record, workspace(), options); await submit(tree);
    assert.deepEqual(calls, [{ action: expected, payload: { id: quote.id } }]);
  }
});

test('date-expired quotations require a revision rather than reopening or acceptance', async () => {
  reset(); const expired = { ...quote, validUntil: '2026-11-26' }; const calls = []; const opened = [];
  const options = { mutate: async (action, payload) => { calls.push({ action, payload }); return { quotations: [{ id: 'revision-test', revisionOf: quote.id, status: 'DRAFT' }] }; }, open: target => opened.push(target) };
  const tree = renderForm(expired, workspace(), options);
  assert.equal(field(tree, 'status').props.value, 'EXPIRED');
  assert.equal(field(tree, 'status').props.disabled, true);
  await submit(tree); assert.equal(calls.length, 0);
  await button(tree, 'Create revision').props.onClick();
  // The UI starts its async action without returning it from the click handler.
  await Promise.resolve();
  assert.deepEqual(calls, [{ action: 'quote_revise', payload: { id: quote.id } }]);
  assert.deepEqual(opened, [{ type: 'quote', id: 'revision-test' }]);
  assert.equal(views.quoteStatusAction(expired, 'ISSUED'), undefined);
  assert.equal(views.quoteStatusAction(expired, 'ACCEPTED'), undefined);
});

test('Accepted is final and both its Won lead and work order remain reachable', async () => {
  reset(); const accepted = { ...quote, status: 'ACCEPTED' }; const calls = []; const opened = [];
  const data = workspace();
  const tree = renderForm(accepted, data, { mutate: async (...args) => { calls.push(args); }, open: target => opened.push(target) });
  assert.equal(field(tree, 'status').props.disabled, true);
  await submit(tree); assert.equal(calls.length, 0);
  button(tree, 'View won lead').props.onClick(); button(tree, 'Open work order').props.onClick();
  assert.deepEqual(opened, [{ type: 'lead_detail', id: quote.leadId }, { type: 'work_detail', id: 'work-test' }]);
  const detail = views.QuoteDetail({ quote: accepted, data, permissions: { approve: true }, open() {}, busy: false, mutate() {}, print() {} });
  assert.ok(button(detail, 'View won lead')); assert.ok(button(detail, 'Open work order')); assert.ok(button(detail, 'View status'));
});
