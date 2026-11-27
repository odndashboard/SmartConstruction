import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { computeQuote } from '../lib/finance.ts';
import { REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS } from '../lib/quotation-categories.ts';
import { packageScopeFromItems, reusableQuoteScope } from '../lib/quotation-reuse.ts';

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
  computeQuote, packageScopeFromItems, reusableQuoteScope, REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS, formatINR: value => `INR ${(value / 100).toFixed(2)}`, units: ['job'], plusDays: () => '2026-12-27',
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
  quotations: [], leads: [{ id: 'lead', title: 'Solar installation', siteAddress: 'Project site', stateCode: '', status: 'NEW', isDemo: false }] };
const line = { id: 'item', description: 'Solar scope', quantity: '2', unit: 'job', unitPrice: '500', hsnSac: '', discount: '0', gstRate: '0' };
const noGst = { id: 'quote', leadId: 'lead', title: 'Solar installation', revision: 1, number: 'Q/001', status: 'ISSUED',
  gstEnabled: false, validUntil: '2026-12-27', siteAddress: 'Project site', placeOfSupply: '', terms: '', ...computeQuote([line], '', '', false) };
function reset() { state = []; }
function editor(options = {}) { cursor = 0; return views.QuoteEditor({ data, leadId: 'lead', busy: false, close() {}, mutate() {}, ...options }); }
function fields(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(fields)];
}
function input(tree, label) { return fields(fields(tree).find(item => item.props.label === label)).find(item => ['input', 'select', 'textarea'].includes(item.type)); }
function button(tree, label) { return fields(tree).find(item => item.type === 'button' && React.Children.toArray(item.props.children).includes(label)); }
function submit(tree, entries = [['validUntil', '2026-12-27'], ['terms', '']]) { tree.props.onSubmit({ preventDefault() {}, currentTarget: { entries } }); }
function rows(tree) { return fields(tree).filter(item => item.type === 'section' && item.props.className === 'quote-item-editor'); }
function completeRows(tree) {
  const packagePrice = input(tree, 'Package price (₹) *');
  if (packagePrice && !packagePrice.props.value) packagePrice.props.onChange({ target: { value: '1000' } });
  for (const [index, row] of rows(tree).entries()) {
    for (const [label, value] of [['Description *', `Customer-specified scope ${index + 1}`], ['Unit *', 'job'], ['Quantity *', '1'], ['Unit price (₹) *', '0'], ['GST rate (%) *', '18']]) {
      const control = input(row, label);
      if (control && !control.props.value) control.props.onChange({ target: { value } });
    }
  }
}

test('new quotation editor defaults to one No GST package price with warranties instead of line prices', () => {
  reset(); let tree = editor();
  assert.equal(input(tree, 'GST').props.value, 'NONE');
  assert.equal(rows(tree).length, 9);
  assert.equal(input(tree, 'GST rate (%) *'), undefined);
  assert.doesNotMatch(renderToStaticMarkup(tree), /HSN|SAC|Discount|Total incl\. GST|setup needed/);
  completeRows(tree);
  input(tree, 'Description *').props.onChange({ target: { value: 'Solar scope' } });
  input(tree, 'Package price (₹) *').props.onChange({ target: { value: '1000' } });
  input(rows(tree)[0], 'Warranty (optional)').props.onChange({ target: { value: '12 years manufacturer warranty' } });
  const calls = []; tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[0][0], 'quote_save');
  assert.equal(calls[0][1].gstEnabled, false);
  assert.equal(calls[0][1].packagePrice, '1000');
  assert.equal(calls[0][1].packageGstRate, '0');
  assert.equal(calls[0][1].items[0].warranty, '12 years manufacturer warranty');
  assert.ok(calls[0][1].items.every(item => item.unitPrice === '0' && item.discount === '0' && item.gstRate === '0'));
  assert.equal(input(tree, 'Unit price (₹) *'), undefined);
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

test('nine package rows require actual descriptions, quantities and units, with optional bounded warranties and no row pricing', () => {
  reset(); const tree = editor();
  const sections = rows(tree);
  const names = sections.map(row => fields(row).find(item => item.type === 'strong').props.children);
  assert.deepEqual(names, ['Panels', 'Inverter', 'Structure', 'DC Wire', 'Ac Wire', 'Earthing Wire', 'Earthing ROD', 'Lighting Arrester', 'Filing']);
  for (const row of sections) {
    for (const label of ['Description *', 'Unit *', 'Quantity *']) {
      assert.equal(input(row, label).props.required, true);
      assert.equal(input(row, label).props.value, '');
    }
    assert.equal(input(row, 'Quantity *').props.min, '0.001');
    assert.equal(input(row, 'Unit price (₹) *'), undefined);
    assert.equal(input(row, 'Warranty (optional)').props.maxLength, 200);
    assert.equal(input(row, 'Warranty (optional)').props.value, '');
    assert.equal(input(row, 'Warranty (optional)').props.required, undefined);
    assert.equal(fields(row).some(item => item.props.label?.startsWith('Remove item')), false);
  }
  assert.match(renderToStaticMarkup(tree), /individual prices are covered by the package/);
  assert.equal(input(tree, 'Package price (₹) *').props.required, true);
  assert.equal(input(tree, 'Package price (₹) *').props.value, '');
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

test('package save requires scope, quantity and deliberate valid package price, allowing an explicit zero package', () => {
  for (const [label, value] of [['Description *', '  '], ['Unit *', ''], ['Quantity *', '0'], ['Warranty (optional)', 'x'.repeat(201)]]) {
    reset(); const calls = []; let tree = editor(); completeRows(tree);
    tree = editor(); input(rows(tree)[0], label).props.onChange({ target: { value } });
    tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
    assert.equal(calls.length, 0, `${label}: ${value}`);
  }
  for (const value of ['', '-1', 'Infinity', '5.001']) {
    reset(); const calls = []; let tree = editor(); completeRows(tree);
    tree = editor(); input(tree, 'Package price (₹) *').props.onChange({ target: { value } });
    tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree); assert.equal(calls.length, 0, `Package price: ${value}`);
  }
  reset(); const calls = []; let tree = editor(); completeRows(tree);
  input(tree, 'Package price (₹) *').props.onChange({ target: { value: '0' } });
  tree = editor({ mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].packagePrice, '0');
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

test('package GST has one deliberate rate, is calculated once and clearing GST preserves the package and warranties', () => {
  const configured = { ...data, company: { ...data.company, stateCode: '06' } };
  reset(); const calls = []; let tree = editor({ data: configured }); completeRows(tree);
  input(tree, 'GST').props.onChange({ target: { value: 'APPLY' } });
  tree = editor({ data: configured, mutate: (...args) => calls.push(args) });
  input(tree, 'Project place of supply').props.onChange({ target: { value: '06' } });
  assert.equal(input(tree, 'Package GST rate (%) *').props.value, '');
  assert.equal(input(tree, 'GST rate (%) *'), undefined);
  submit(tree); assert.equal(calls.length, 0, 'a package rate must be chosen explicitly');
  input(tree, 'Package GST rate (%) *').props.onChange({ target: { value: '18' } });
  input(rows(tree)[0], 'Warranty (optional)').props.onChange({ target: { value: '10 years on panels' } });
  tree = editor({ data: configured, mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[0][1].packagePrice, '1000'); assert.equal(calls[0][1].packageGstRate, '18');
  assert.ok(calls[0][1].items.every(item => item.gstRate === '0'));
  assert.match(renderToStaticMarkup(tree), /INR 1180.00/);
  input(tree, 'GST').props.onChange({ target: { value: 'NONE' } });
  tree = editor({ data: configured, mutate: (...args) => calls.push(args) }); submit(tree);
  assert.equal(calls[1][1].packagePrice, '1000'); assert.equal(calls[1][1].packageGstRate, '0'); assert.equal(calls[1][1].items[0].warranty, '10 years on panels');
  assert.equal(input(tree, 'Package GST rate (%) *'), undefined); assert.match(renderToStaticMarkup(tree), /INR 1000.00/);
});

test('editing a saved package prefills exact package price, warranties and stable IDs without a fabricated price row', () => {
  const items = REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, category, id: `package-${index}`, unitPrice: '0', warranty: `Warranty ${index + 1}` }));
  const quote = { ...noGst, status: 'DRAFT', packagePrice: '98765.43', packageGstRate: '0', ...computeQuote(items, '', '', false, { packagePrice: '98765.43', packageGstRate: '0' }) };
  const frozen = structuredClone(quote); reset(); const calls = [];
  const tree = editor({ quote, mutate: (...args) => calls.push(args) });
  assert.equal(input(tree, 'Package price (₹) *').props.value, '98765.43'); assert.equal(input(tree, 'Unit price (₹) *'), undefined);
  assert.equal(rows(tree).length, 9); assert.equal(input(rows(tree)[0], 'Warranty (optional)').props.value, 'Warranty 1');
  submit(tree); assert.equal(calls.length, 1); assert.equal(calls[0][1].id, quote.id); assert.equal(calls[0][1].packagePrice, '98765.43');
  assert.deepEqual(calls[0][1].items.map(item => item.id), items.map(item => item.id)); assert.deepEqual(quote, frozen);
});

test('saved quotations explicitly replace only scope and pricing in new and legacy edited drafts for another client', () => {
  const scopeItems = REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, category, id: `source-${index}`, description: `Saved scope ${category}`, warranty: `Actual warranty ${index}`, quantity: '3', unitPrice: '0' }));
  const source = { ...noGst, id: 'source-quote', leadId: 'another-client', title: 'Saved source quotation', number: 'Q/SOURCE', isDemo: false, siteAddress: 'Source address must stay out', placeOfSupply: '27', terms: 'Source terms must stay out', validUntil: '2099-12-31', packagePrice: '25000', packageGstRate: '0', ...computeQuote(scopeItems, '', '', false, { packagePrice: '25000', packageGstRate: '0' }) };
  const legacyItems = REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, category, id: `target-${index}`, unitPrice: '100', discount: '10' }));
  const draft = { ...noGst, id: 'target-draft', status: 'DRAFT', isDemo: false, terms: 'Target draft terms', ...computeQuote(legacyItems, '', '', false) };
  const sourceFrozen = structuredClone(source);
  for (const quote of [undefined, draft]) {
    reset(); const calls = [], fixture = { ...data, quotations: [source, draft, { ...source, id: 'demo-source', isDemo: true }] };
    let tree = editor({ quote, data: fixture });
    input(tree, 'Quotation title *').props.onChange({ target: { value: 'Target client title' } });
    input(tree, 'Project site address').props.onChange({ target: { value: 'Target client site' } });
    input(tree, 'Project state (optional)').props.onChange({ target: { value: '06' } });
    const options = fields(input(tree, 'Saved quotation')).filter(item => item.type === 'option').map(item => item.props.value);
    assert.ok(options.includes('source-quote')); assert.ok(!options.includes('demo-source')); if (quote) assert.ok(!options.includes(quote.id));
    input(tree, 'Saved quotation').props.onChange({ target: { value: source.id } });
    tree = editor({ quote, data: fixture });
    if (quote) { assert.equal(input(tree, 'Package price (₹) *'), undefined); assert.equal(input(tree, 'Unit price (₹) *').props.value, '100'); }
    assert.match(renderToStaticMarkup(tree), /replaces this draft’s work items, warranties and pricing/);
    button(tree, 'Use saved quotation').props.onClick(); tree = editor({ quote, data: fixture, mutate: (...args) => calls.push(args) });
    assert.equal(input(tree, 'Package price (₹) *').props.value, '25000'); assert.equal(input(tree, 'Unit price (₹) *'), undefined);
    assert.equal(input(tree, 'Quotation title *').props.value, 'Target client title'); assert.equal(input(tree, 'Project site address').props.value, 'Target client site'); assert.equal(input(tree, 'Project state (optional)').props.value, '06');
    assert.equal(input(tree, 'Valid until *').props.defaultValue, '2026-12-27'); assert.equal(input(tree, 'Terms & exclusions').props.defaultValue, quote?.terms ?? data.company.terms);
    assert.match(renderToStaticMarkup(tree), /Saved quotation applied/);
    submit(tree, [['validUntil', '2027-01-15'], ['terms', 'Edited target terms']]);
    assert.equal(calls.length, 1); const payload = calls[0][1];
    assert.equal(payload.leadId, 'lead'); assert.equal(payload.title, 'Target client title'); assert.equal(payload.siteAddress, 'Target client site'); assert.equal(payload.placeOfSupply, '06'); assert.equal(payload.terms, 'Edited target terms'); assert.equal(payload.validUntil, '2027-01-15');
    assert.equal(payload.packagePrice, '25000'); assert.equal(payload.packageGstRate, '0'); assert.equal(payload.items[0].warranty, 'Actual warranty 0');
    assert.ok(payload.items.every(item => !source.items.some(original => original.id === item.id))); assert.equal(new Set(payload.items.map(item => item.id)).size, payload.items.length);
    assert.deepEqual(source, sourceFrozen);
  }
});

test('saved quotation choices follow the current target lead scope and mixed historical GST requires a reviewed package rate', () => {
  const taxed = [{ ...line, id: 'tax18', category: 'Panels', gstRate: '18' }, { ...line, id: 'tax12', category: 'Inverter', gstRate: '12' }];
  const real = { ...noGst, id: 'mixed-rates', title: 'Historical mixed rates', isDemo: false, gstEnabled: true, ...computeQuote(taxed, '06', '06') };
  const demo = { ...real, id: 'demo-scope', title: 'Demo only', isDemo: true };
  const fixture = { ...data, company: { ...data.company, stateCode: '06' }, leads: [...data.leads, { ...data.leads[0], id: 'demo-lead', isDemo: true }], quotations: [real, demo] };
  reset(); let tree = editor({ data: fixture, leadId: undefined });
  assert.equal(input(tree, 'Saved quotation').props.disabled, true); assert.equal(button(tree, 'Use saved quotation').props.disabled, true);
  input(tree, 'Lead / project *').props.onChange({ target: { value: 'demo-lead' } }); tree = editor({ data: fixture, leadId: undefined });
  let options = fields(input(tree, 'Saved quotation')).filter(item => item.type === 'option').map(item => item.props.value); assert.deepEqual(options, ['', demo.id]);
  input(tree, 'Saved quotation').props.onChange({ target: { value: demo.id } });
  input(tree, 'Lead / project *').props.onChange({ target: { value: 'lead' } }); tree = editor({ data: fixture, leadId: undefined });
  assert.equal(input(tree, 'Saved quotation').props.value, ''); options = fields(input(tree, 'Saved quotation')).filter(item => item.type === 'option').map(item => item.props.value); assert.deepEqual(options, ['', real.id]);
  input(tree, 'Saved quotation').props.onChange({ target: { value: real.id } }); tree = editor({ data: fixture }); button(tree, 'Use saved quotation').props.onClick(); tree = editor({ data: fixture });
  completeRows(tree); tree = editor({ data: fixture });
  assert.equal(input(tree, 'GST').props.value, 'APPLY'); assert.equal(input(tree, 'Package GST rate (%) *').props.value, '');
  const calls = []; tree = editor({ data: fixture, mutate: (...args) => calls.push(args) }); submit(tree); assert.equal(calls.length, 0);
  input(tree, 'Package GST rate (%) *').props.onChange({ target: { value: '18' } });
  tree = editor({ data: fixture, mutate: (...args) => calls.push(args) }); submit(tree); assert.equal(calls.length, 1); assert.equal(calls[0][1].packageGstRate, '18');
});

test('existing itemized drafts convert only on request using current unsaved prices and retain row identities, warranties and client details', () => {
  const items = REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ ...line, id: `old-${index}`, category, quantity: '2', unitPrice: index === 0 ? '500' : '0', discount: index === 0 ? '25' : '0', warranty: `Warranty ${index}` }));
  const quote = { ...noGst, status: 'DRAFT', terms: 'Current client terms', ...computeQuote(items, '', '', false) };
  const frozen = structuredClone(quote); reset(); const calls = [];
  let tree = editor({ quote, mutate: (...args) => calls.push(args) });
  assert.equal(input(tree, 'Package price (₹) *'), undefined); assert.equal(input(tree, 'Unit price (₹) *').props.value, '500');
  input(rows(tree)[0], 'Unit price (₹) *').props.onChange({ target: { value: '750' } });
  input(rows(tree)[0], 'Description *').props.onChange({ target: { value: 'Unsaved current specification' } });
  input(rows(tree)[0], 'Warranty (optional)').props.onChange({ target: { value: 'Unsaved warranty text' } });
  tree = editor({ quote, mutate: (...args) => calls.push(args) }); button(tree, 'Use one package price').props.onClick();
  assert.equal(calls.length, 0); tree = editor({ quote, mutate: (...args) => calls.push(args) });
  assert.equal(input(tree, 'Package price (₹) *').props.value, '1475.00'); assert.equal(input(tree, 'Unit price (₹) *'), undefined);
  assert.equal(input(rows(tree)[0], 'Description *').props.value, 'Unsaved current specification'); assert.equal(input(rows(tree)[0], 'Warranty (optional)').props.value, 'Unsaved warranty text');
  assert.deepEqual(rows(tree).map(row => row.props['aria-labelledby']), items.map(item => `quote-item-${item.id}`));
  assert.match(renderToStaticMarkup(tree), /save the quotation to keep this change/);
  submit(tree, [['validUntil', quote.validUntil], ['terms', quote.terms]]);
  assert.equal(calls.length, 1); const payload = calls[0][1]; assert.equal(payload.packagePrice, '1475.00'); assert.equal(payload.title, quote.title); assert.equal(payload.leadId, quote.leadId); assert.equal(payload.siteAddress, quote.siteAddress); assert.equal(payload.terms, quote.terms);
  assert.ok(payload.items.every(item => item.unitPrice === '0' && item.discount === '0' && item.gstRate === '0')); assert.deepEqual(quote, frozen);
});

test('manual package conversion leaves incomplete amounts blank and asks for one rate when original tax rates differ', () => {
  const rows = [{ ...line, id: 'first', gstRate: '18' }, { ...line, id: 'second', gstRate: '12' }];
  const mixed = packageScopeFromItems(rows, '06', '06', true); assert.equal(mixed.packagePrice, '2000.00'); assert.equal(mixed.packageGstRate, ''); assert.deepEqual(mixed.items.map(item => item.id), ['first', 'second']);
  const incomplete = packageScopeFromItems([{ ...line, unitPrice: '', warranty: 'Actual warranty' }], '', '', false); assert.equal(incomplete.packagePrice, ''); assert.equal(incomplete.packageGstRate, '0'); assert.equal(incomplete.items[0].warranty, 'Actual warranty');
  const common = packageScopeFromItems(rows.map(row => ({ ...row, gstRate: '18' })), '06', '06', true); assert.equal(common.packageGstRate, '18');
});
