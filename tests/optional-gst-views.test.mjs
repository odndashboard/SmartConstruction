import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { computeQuote } from '../lib/finance.ts';
import { REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS } from '../lib/quotation-categories.ts';

// Exercise the real editor and printable quotation, including their handlers.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['initializeQuoteItems', 'QuoteEditor', 'Totals', 'QuoteDocument', 'Field'];
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
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
    return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
  },
  FormData: class { constructor(form) { this.form = form; } entries() { return this.form.entries; } },
  computeQuote, REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS, formatINR: value => `INR ${(value / 100).toFixed(2)}`, units: ['job'], plusDays: () => '2026-12-27',
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
function rows(tree) { return fields(tree).filter(item => item.type === 'section' && item.props.className === 'quote-item-editor'); }
function completeRows(tree) {
  for (const [index, row] of rows(tree).entries()) {
    for (const [label, value] of [['Description *', `Customer-specified scope ${index + 1}`], ['Unit *', 'job'], ['Quantity *', '1'], ['Unit price (₹) *', '0'], ['GST rate (%) *', '18']]) {
      const control = input(row, label);
      if (control && !control.props.value) control.props.onChange({ target: { value } });
    }
  }
}

test('new quotation editor defaults to No GST and removes HSN/SAC and Discount inputs', () => {
  reset(); let tree = editor();
  assert.equal(input(tree, 'GST').props.value, 'NONE');
  assert.equal(rows(tree).length, 9);
  assert.equal(input(tree, 'GST rate (%) *'), undefined);
  assert.doesNotMatch(renderToStaticMarkup(tree), /HSN|SAC|Discount|Total incl\. GST|setup needed/);
  completeRows(tree);
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
  completeRows(tree);
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

test('nine named rows require deliberate descriptions, quantities, units and prices and cannot be removed', () => {
  reset(); const tree = editor();
  const sections = rows(tree);
  const names = sections.map(row => fields(row).find(item => item.type === 'strong').props.children);
  assert.deepEqual(names, ['Panels', 'Inverter', 'Structure', 'DC Wire', 'Ac Wire', 'Earthing Wire', 'Earthing ROD', 'Lighting Arrester', 'Filing']);
  for (const row of sections) {
    for (const label of ['Description *', 'Unit *', 'Quantity *', 'Unit price (₹) *']) {
      assert.equal(input(row, label).props.required, true);
      assert.equal(input(row, label).props.value, '');
    }
    assert.equal(input(row, 'Quantity *').props.min, '0.001');
    assert.equal(input(row, 'Unit price (₹) *').props.min, '0');
    assert.equal(fields(row).some(item => item.props.label?.startsWith('Remove item')), false);
  }
  assert.match(renderToStaticMarkup(tree), /Enter ₹0 when its price is included in a package/);
});

test('required row IDs stay stable across edits and optional extras remain addable and removable', () => {
  reset(); let tree = editor();
  const originalIds = rows(tree).map(row => row.key);
  completeRows(tree); tree = editor();
  assert.deepEqual(rows(tree).map(row => row.key), originalIds);
  button(tree, 'Add extra item').props.onClick(); tree = editor();
  assert.equal(rows(tree).length, 10);
  assert.deepEqual(rows(tree).slice(0, 9).map(row => row.key), originalIds);
  const remove = fields(rows(tree)[9]).find(item => item.props.label === 'Remove item 10');
  assert.ok(remove); remove.props.onClick(); tree = editor();
  assert.deepEqual(rows(tree).map(row => row.key), originalIds);
});

test('legacy initialization preserves original IDs, labels and financial inputs without category guesses', () => {
  const existing = { ...noGst, status: 'DRAFT', items: [
    { ...line, id: 'legacy-panels', description: 'Panels', quantity: '12', unit: 'nos', unitPrice: '4000', discount: '10', hsnSac: '8541' },
    { ...line, id: 'named-inverter', category: 'Inverter', description: 'Genuine existing inverter description', quantity: '1', unit: 'nos', unitPrice: '20000' },
  ] };
  const frozen = structuredClone(existing);
  const initialized = views.initializeQuoteItems(existing, false);
  assert.equal(initialized.length, 10);
  for (let index = 0; index < 2; index++) {
    for (const key of Object.keys(existing.items[index])) assert.deepEqual(initialized[index][key], existing.items[index][key]);
  }
  assert.equal(initialized[0].category, undefined, 'the old description must not be interpreted as a category');
  assert.equal(initialized.filter(item => item.category === 'Inverter').length, 1);
  assert.equal(initialized.filter(item => item.category === 'Panels').length, 1);
  for (const row of initialized.slice(2)) assert.equal(row.unitPrice, '');
  assert.deepEqual(existing, frozen);
  const completed = { ...noGst, items: REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, id: `saved-${index}`, category })) };
  assert.deepEqual(views.initializeQuoteItems(completed, false).map(row => row.id), completed.items.map(row => row.id));
});

test('legacy maximum-size drafts retain 100 original rows plus nine required rows without further extras', () => {
  const quote = { ...noGst, status: 'DRAFT', items: Array.from({ length: 100 }, (_, index) => ({ ...line, id: `legacy-${index}` })) };
  reset(); const tree = editor({ quote });
  assert.equal(rows(tree).length, MAX_QUOTE_ITEMS);
  assert.equal(button(tree, 'Add extra item').props.disabled, true);
  assert.match(renderToStaticMarkup(tree), /Your existing lines and prices are kept/);
  assert.deepEqual(views.initializeQuoteItems(quote, false).slice(0, 100).map(row => row.id), quote.items.map(row => row.id));
});

test('save requires all row inputs and permits explicit zero-priced package inclusions', () => {
  for (const [label, value] of [['Description *', '  '], ['Unit *', ''], ['Quantity *', '0'], ['Unit price (₹) *', ''], ['Unit price (₹) *', '-1']]) {
    reset(); const calls = []; let tree = editor(); completeRows(tree);
    tree = editor(); input(rows(tree)[0], label).props.onChange({ target: { value } });
    tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
    assert.equal(calls.length, 0, `${label}: ${value}`);
  }
  reset(); const calls = []; let tree = editor(); completeRows(tree);
  tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].items.map(item => item.category), [...REQUIRED_QUOTE_CATEGORIES]);
  assert.ok(calls[0][1].items.every(item => item.unitPrice === '0' && Number(item.quantity) > 0));
});

test('printed quotations display every category beside its own entered description', () => {
  const items = REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, id: `categorized-${index}`, category, description: `Customer specification ${index + 1}` }));
  const quote = { ...noGst, ...computeQuote(items, '', '', false) };
  const html = renderToStaticMarkup(React.createElement(views.QuoteDocument, { quote, data }));
  for (const item of items) {
    assert.ok(html.includes(`<small>${item.category}</small><strong>${item.description}</strong>`));
  }
});
