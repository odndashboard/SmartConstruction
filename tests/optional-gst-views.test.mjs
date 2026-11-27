import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { computeQuote } from '../lib/finance.ts';

// Exercise the real editor and printable quotation, including their handlers.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['QuoteEditor', 'Totals', 'QuoteDocument', 'Field'];
const code = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing function ${name}`);
  return node.getText(ast);
}).join('\n');
let state = [], cursor = 0;
const blank = () => null;
const wrapper = ({ children }) => React.createElement('span', null, children);
const helpers = {
  useState(initial) {
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  },
  FormData: class { constructor(form) { this.form = form; } entries() { return this.form.entries; } },
  computeQuote, formatINR: value => `INR ${(value / 100).toFixed(2)}`, units: ['job'], plusDays: () => '2026-12-27',
  displayDate: value => value, stateLabel: value => value, customerForLead: data => data.customers[0],
  FormFooter: blank, IconButton: wrapper, StateOptions: blank, ShieldCheck: blank, FileText: blank,
  CircleAlert: blank, Plus: blank, Trash2: blank,
};
const compiled = ts.transpileModule(`${code}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const data = { company: { name: 'Supplier', legalName: 'Genuine supplier', address: 'Supplier address', gstin: '', stateCode: '', terms: '' },
  customers: [{ name: 'Genuine customer', address: 'Customer address', gstin: '' }],
  leads: [{ id: 'lead', title: 'Solar installation', siteAddress: 'Project site', stateCode: '', status: 'NEW' }] };
const line = { id: 'item', description: 'Solar scope', quantity: '2', unit: 'job', unitPrice: '500', hsnSac: '', discount: '0', gstRate: '0' };
const noGst = { id: 'quote', leadId: 'lead', title: 'Solar installation', revision: 1, number: 'Q/001', status: 'ISSUED',
  gstEnabled: false, validUntil: '2026-12-27', siteAddress: 'Project site', placeOfSupply: '', terms: '', ...computeQuote([line], '', '', false) };
function reset() { state = []; }
function editor(options = {}) { cursor = 0; return views.QuoteEditor({ data, leadId: 'lead', busy: false, close() {}, mutate() {}, ...options }); }
function fields(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(fields)];
}
function input(tree, label) { return fields(tree).find(item => item.props.label === label)?.props.children; }
function button(tree, label) { return fields(tree).find(item => item.type === 'button' && React.Children.toArray(item.props.children).includes(label)); }
function submit(tree) { tree.props.onSubmit({ preventDefault() {}, currentTarget: { entries: [['validUntil', '2026-12-27'], ['terms', '']] } }); }

test('new quotation editor defaults to No GST and removes HSN/SAC and Discount inputs', () => {
  reset(); let tree = editor();
  assert.equal(input(tree, 'GST').props.value, 'NONE');
  button(tree, 'Add item').props.onClick(); tree = editor();
  assert.equal(input(tree, 'GST rate (%) *'), undefined);
  assert.doesNotMatch(renderToStaticMarkup(tree), /HSN|SAC|Discount|Total incl\. GST|setup needed/);
  input(tree, 'Description *').props.onChange({ target: { value: 'Solar scope' } });
  input(tree, 'Unit price (₹) *').props.onChange({ target: { value: '1000' } });
  const calls = []; tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[0][0], 'quote_save');
  assert.equal(calls[0][1].gstEnabled, false);
  assert.equal(calls[0][1].items[0].gstRate, '0');
  assert.equal(calls[0][1].items[0].hsnSac, '');
  assert.equal(calls[0][1].items[0].discount, '0');
});

test('Apply GST exposes a reviewed rate without restoring removed fields and switching off clears only tax', () => {
  const historical = { ...noGst, gstEnabled: undefined, status: 'DRAFT', ...computeQuote([{ ...line, hsnSac: '9954', discount: '25', gstRate: '18' }], '06', '06') };
  const configured = { ...data, company: { ...data.company, stateCode: '06' } };
  reset(); let tree = editor({ quote: historical, data: configured });
  assert.equal(input(tree, 'GST').props.value, 'APPLY');
  assert.equal(input(tree, 'GST rate (%) *').props.value, '18');
  assert.ok(input(tree, 'GST rate (%) *').props.required);
  assert.equal(input(tree, 'Discount (₹)'), undefined);
  assert.equal(input(tree, 'HSN / SAC *'), undefined);
  const calls = []; tree = editor({ quote: historical, data: configured, mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[0][1].items[0].discount, '25');
  assert.equal(calls[0][1].items[0].hsnSac, '9954');
  assert.equal(calls[0][1].gstEnabled, true);
  input(tree, 'GST').props.onChange({ target: { value: 'NONE' } });
  tree = editor({ quote: historical, data: configured, mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[1][1].gstEnabled, false);
  assert.equal(calls[1][1].items[0].gstRate, '0');
  assert.equal(calls[1][1].items[0].discount, '25');
  assert.equal(calls[1][1].items[0].hsnSac, '9954');
  assert.equal(input(tree, 'GST rate (%) *'), undefined);
});

test('No GST print uses the agreed amount with no missing-registration, HSN or discount placeholders', () => {
  const html = renderToStaticMarkup(React.createElement(views.QuoteDocument, { quote: noGst, data }));
  for (const value of ['GST not applied', 'Not applied', 'INR 1000.00', 'Genuine supplier', 'Genuine customer', 'Project site']) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /GSTIN|HSN|SAC|Discount|Not configured|Unregistered|CGST|SGST|Total incl\. GST|Total before GST/);
  const total = renderToStaticMarkup(React.createElement(views.Totals, { totals: noGst.totals }));
  assert.match(total, /<dt>Total<\/dt>/);
});

test('historical priced documents retain actual discounts, classification, rate and exact totals', () => {
  const quote = { ...noGst, gstEnabled: undefined, placeOfSupply: '06', supplier: { ...data.company, gstin: '06ABCDE1234F1Z5' },
    ...computeQuote([{ ...line, hsnSac: '9954', discount: '25', gstRate: '18' }], '06', '06') };
  const frozen = structuredClone(quote);
  const html = renderToStaticMarkup(React.createElement(views.QuoteDocument, { quote, data }));
  for (const value of ['HSN/SAC', '9954', 'Discount', '25', 'GST %', '18', 'CGST', 'SGST', 'Total incl. GST', 'INR 1150.50', '06ABCDE1234F1Z5']) assert.ok(html.includes(value), value);
  assert.deepEqual(quote, frozen);
});

test('new GST quotations print rates without unused HSN or Discount fields', () => {
  const quote = { ...noGst, gstEnabled: true, ...computeQuote([{ ...line, gstRate: '18' }], '06', '06') };
  const html = renderToStaticMarkup(React.createElement(views.QuoteDocument, { quote, data }));
  assert.doesNotMatch(html, /HSN|SAC|Discount/);
  assert.match(html, /Total incl\. GST/);
  assert.match(html, /INR 1180.00/);
});
