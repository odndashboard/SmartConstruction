import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { REQUIRED_QUOTE_CATEGORIES } from '../lib/quotation-categories.ts';

// Render the actual detail, printed document and accepted work-order scope.
// No editor or server mutations are simulated by these presentation checks.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['QuoteDetail', 'QuoteDocument', 'WorkDetail', 'Totals', 'DetailField', 'workOrderLeadId'];
const code = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing ${name}`); return node.getText(ast);
}).join('\n');
const blank = () => null;
const wrapper = ({ children }) => React.createElement('span', null, children);
const helpers = {
  Badge: wrapper, DemoTag: blank, Notes: wrapper, WorkActions: blank,
  ChevronDown: blank, Printer: blank, CheckCircle2: blank, Building2: blank, Pencil: blank,
  FileText: blank, Check: blank, RefreshCw: blank, ArrowRight: blank, HardHat: blank,
  ArrowUpRight: blank, Plus: blank, CircleAlert: blank,
  QUOTE_LABELS: { DRAFT: 'Draft', ISSUED: 'Awaiting approval', ACCEPTED: 'Accepted' }, WORK_LABELS: { ACTIVE: 'In progress' },
  customerForLead: data => data.customers[0], ownerName: () => 'Assigned colleague',
  effectiveQuoteStatus: quote => quote.status, displayDate: value => value, stateLabel: value => value,
  formatINR: value => `INR ${(value / 100).toFixed(2)}`,
};
const compiled = ts.transpileModule(`${code}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const packageQuote = {
  id: 'package-quote', leadId: 'lead', title: 'Solar package', number: 'Q/2026/001', revision: 1, status: 'ACCEPTED',
  validUntil: '2026-12-31', siteAddress: 'Agreed site', placeOfSupply: '06', terms: 'Actual scope and terms', gstEnabled: true,
  packagePrice: '1250.50', packageGstRate: '18',
  supplier: { name: 'Frozen supplier', legalName: 'Frozen supplier legal name', address: 'Supplier address', gstin: 'Original supplier GST' },
  customer: { name: 'Frozen customer', address: 'Customer address', gstin: 'Original customer GST' },
  items: REQUIRED_QUOTE_CATEGORIES.map((category, index) => ({ id: `item-${index}`, category,
    description: `Actual ${category} specification`, quantity: '1.5', unit: 'set', warranty: `Warranty ${index + 1}: actual supplier terms`,
    // Package rows carry no individual commercial amount. These sentinel values
    // also prove presentation never exposes an old per-line amount accidentally.
    unitPrice: '999', discount: '87', gstRate: '28', gross: 99900, taxable: 91200, total: 116736, hsnSac: 'private-old-HSN' })),
  totals: { subtotal: 125050, discount: 0, taxable: 125050, cgst: 0, sgst: 0, utgst: 0, igst: 22509, total: 147559, mode: 'IGST', needsConfig: false },
};
function data(quote) {
  return { user: { role: 'OWNER' }, company: { name: 'Changed supplier', legalName: 'Changed legal name', address: 'Changed address' },
    customers: [{ name: 'Changed customer' }], leads: [{ id: 'lead', title: 'Lead', status: 'WON' }], quotations: [quote], workorders: [] };
}
function render(name, quote) {
  const workspace = data(quote);
  if (name === 'WorkDetail') {
    const order = { id: 'order', leadId: quote.leadId, quoteId: quote.id, number: 'WO/2026/001', title: quote.title, customerName: quote.customer.name,
      siteAddress: quote.siteAddress, status: 'ACTIVE', snapshot: quote, milestones: [], owner: '', startDate: '', endDate: '' };
    workspace.workorders = [order];
    return renderToStaticMarkup(React.createElement(views.WorkDetail, { item: order, data: workspace, delivery: false, busy: false, open() {}, mutate: assert.fail }));
  }
  return renderToStaticMarkup(React.createElement(views[name], { quote, data: workspace, permissions: {}, busy: false, open() {}, mutate: assert.fail, print() {} }));
}
function table(markup) { return markup.match(/<table>.*?<\/table>/s)?.[0]; }

test('package details and printed quotation show all nine warranties and one package price without line amounts', () => {
  const before = structuredClone(packageQuote);
  for (const name of ['QuoteDetail', 'QuoteDocument']) {
    const markup = render(name, packageQuote), rows = table(markup);
    assert.ok(rows); assert.match(rows, /<th>Warranty<\/th>/);
    assert.equal((rows.match(/<td/g) || []).length, 9 * 3);
    for (const item of packageQuote.items) {
      assert.ok(rows.includes(item.category)); assert.ok(rows.includes(item.description)); assert.ok(rows.includes(item.warranty));
    }
    assert.match(rows, /1.5 set/);
    assert.doesNotMatch(rows, /Rate|GST|Total|Discount|Unit price|999|1167.36|private-old-HSN|INR/);
    assert.equal((markup.match(/Package price/g) || []).length, 1);
    assert.match(markup, /INR 1250\.50/); assert.match(markup, /GST rate/); assert.match(markup, /18%/);
    assert.match(markup, /IGST/); assert.match(markup, /INR 225\.09/); assert.match(markup, /INR 1475\.59/);
    assert.doesNotMatch(markup, /Subtotal|Discount/);
  }
  assert.deepEqual(packageQuote, before, 'Views never alter accepted snapshot inputs or amounts.');
  const printed = render('QuoteDocument', packageQuote);
  assert.match(printed, /Frozen supplier legal name/); assert.match(printed, /Frozen customer/);
  assert.doesNotMatch(printed, /Changed supplier|Changed customer|per line and tax component/);
});

test('accepted package work orders preserve the genuine total and show warranties without per-line prices', () => {
  const markup = render('WorkDetail', packageQuote);
  for (const item of packageQuote.items) assert.ok(markup.includes(`Warranty: ${item.warranty}`));
  assert.match(markup, /Agreed total incl\. GST/); assert.match(markup, /INR 1475\.59/);
  assert.equal((markup.match(/Package price/g) || []).length, 1);
  assert.match(markup, /Actual scope and terms/);
  assert.doesNotMatch(markup, /INR 1167\.36|Discount|private-old-HSN/);
});

test('zero-priced and No GST packages retain package presentation and honest optional warranty text', () => {
  const quote = { ...packageQuote, packagePrice: '0', packageGstRate: '0', gstEnabled: false,
    items: [{ ...packageQuote.items[0], warranty: '' }],
    totals: { ...packageQuote.totals, mode: 'NO_GST', subtotal: 0, taxable: 0, igst: 0, total: 0 } };
  for (const name of ['QuoteDetail', 'QuoteDocument', 'WorkDetail']) {
    const markup = render(name, quote);
    assert.match(markup, /Package price/); assert.match(markup, /Not specified/); assert.match(markup, /INR 0\.00/);
    assert.match(markup, /Not applied/); assert.doesNotMatch(markup, /incl\. GST|GST rate|>IGST<|>CGST<|>SGST</);
  }
});

test('historical itemized quotation detail, print and work orders retain individual rates, discounts and totals', () => {
  const legacy = { ...packageQuote };
  delete legacy.packagePrice; delete legacy.packageGstRate;
  legacy.items = [{ ...packageQuote.items[0], warranty: undefined, quantity: '1', unitPrice: '250', discount: '25', gstRate: '5', gross: 25000, taxable: 22500, total: 23625 }];
  legacy.totals = { ...packageQuote.totals, subtotal: 25000, discount: 2500, taxable: 22500, igst: 1125, total: 23625 };
  for (const name of ['QuoteDetail', 'QuoteDocument', 'WorkDetail']) {
    const markup = render(name, legacy);
    assert.doesNotMatch(markup, /Package price|Warranty/); assert.match(markup, /Discount/);
    assert.match(markup, /INR 236\.25/);
  }
  const detail = table(render('QuoteDetail', legacy));
  assert.match(detail, /<th>Rate<\/th>/); assert.match(detail, /INR 250\.00/); assert.match(detail, /5%/);
  const print = render('QuoteDocument', legacy);
  assert.match(print, /Unit price ₹/); assert.match(print, /Discount ₹/); assert.match(print, />236\.25<\/td>/);
  assert.match(print, /Subtotal/); assert.match(print, /per line and tax component/);
});

test('package totals preserve tax component mode and incomplete-registration guidance', () => {
  for (const [mode, label] of [['CGST_SGST', 'SGST'], ['CGST_UTGST', 'UTGST']]) {
    const markup = renderToStaticMarkup(React.createElement(views.Totals, { packagePrice: '1000', packageGstRate: '18',
      totals: { ...packageQuote.totals, mode, subtotal: 100000, taxable: 100000, cgst: 9000, sgst: mode === 'CGST_SGST' ? 9000 : 0, utgst: mode === 'CGST_UTGST' ? 9000 : 0, igst: 0, total: 118000 } }));
    assert.match(markup, /CGST/); assert.ok(markup.includes(label)); assert.match(markup, /INR 1180\.00/);
  }
  const markup = renderToStaticMarkup(React.createElement(views.Totals, { packagePrice: '1250.50', packageGstRate: '18',
    totals: { ...packageQuote.totals, mode: 'UNCONFIGURED', needsConfig: true, igst: 0, total: 125050 } }));
  assert.match(markup, /GST setup needed/); assert.match(markup, /Total before GST/); assert.doesNotMatch(markup, /Total incl\. GST/);
});

test('warranty added to an itemized draft or revision is visible without replacing its original pricing columns', () => {
  const legacy = { ...packageQuote, status: 'DRAFT', items: [{ ...packageQuote.items[0], warranty: 'Supplier warranty: 3 years',
    quantity: '1', unitPrice: '250', discount: '25', gstRate: '5', gross: 25000, taxable: 22500, total: 23625 }],
    totals: { ...packageQuote.totals, subtotal: 25000, discount: 2500, taxable: 22500, igst: 1125, total: 23625 } };
  delete legacy.packagePrice; delete legacy.packageGstRate;
  for (const name of ['QuoteDetail', 'QuoteDocument', 'WorkDetail']) {
    const markup = render(name, legacy);
    assert.match(markup, /Warranty: Supplier warranty: 3 years/);
    assert.match(markup, /Discount/); assert.match(markup, /INR 236\.25/); assert.doesNotMatch(markup, /Package price/);
  }
  assert.match(table(render('QuoteDetail', legacy)), /<th>Rate<\/th>/);
  assert.match(table(render('QuoteDocument', legacy)), /Unit price ₹/);
});
