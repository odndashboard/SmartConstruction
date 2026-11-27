import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { REQUIRED_QUOTE_CATEGORIES } from '../lib/quotation-categories.ts';

const source = readFileSync(new URL('../components/JobMaterials.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const compiled = ts.transpileModule(`${source}\nexport { MaterialIssueForm, materialIssuePayload, canRecordJobMaterials, usageSummary };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const stores = new Map(); let key = '', cursor = 0;
function slot(initial) {
  const values = stores.get(key); const index = cursor++;
  if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial;
  return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }];
}
const blank = () => null;
const helpers = { useState: slot, useRef: value => slot({ current: value })[0], useEffect() {},
  REQUIRED_QUOTE_CATEGORIES, styles: new Proxy({}, { get: (_, name) => name }),
  Check: blank, CircleAlert: blank, LoaderCircle: blank, Package: blank, Plus: blank };
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const order = { id: 'work', title: 'Solar job', number: 'WO/1', status: 'ACTIVE', isDemo: false,
  snapshot: { items: [{ id: 'quote-item', category: 'Panels', description: 'Customer approved panel specification', quantity: '25', unit: 'nos' }] } };
function data(role = 'OWNER') {
  return { user: { userId: 'user', role, active: true }, permissions: { canWrite: true },
    stockItems: [{ id: 'panels', name: 'Chosen panel model', sku: 'P-1', unit: 'nos', active: true },
      { id: 'wire', name: 'Exact DC wire', sku: 'W-1', unit: 'm', active: true },
      { id: 'wire-weight', name: 'Different wire roll', sku: 'W-2', unit: 'kg', active: true },
      { id: 'inactive-item', name: 'Inactive material', unit: 'nos', active: false }],
    extension: { sites: [{ id: 'store', name: 'Main store', active: true }, { id: 'empty-site', name: 'Empty site', active: true }, { id: 'inactive-site', name: 'Inactive store', active: false }],
      siteBalances: [{ itemId: 'panels', siteId: 'store', quantityMilli: 10000 }, { itemId: 'wire', siteId: 'store', quantityMilli: 50500 }, { itemId: 'wire-weight', siteId: 'store', quantityMilli: 6000 }], jobMaterialEntries: [] } };
}
function entry(overrides = {}) { return { id: 'entry', workOrderId: order.id, category: 'Panels', movementId: 'movement', itemId: 'panels', siteId: 'store', quantityMilli: 2500, returnedMilli: '500', actorId: 'user', actorName: 'Team member', createdAt: '2026-11-27T06:00:00Z', ...overrides }; }
function reset() { stores.clear(); }
function invoke(name, props, storeKey = name) {
  key = storeKey; cursor = 0; if (!stores.has(key)) stores.set(key, []);
  return views[name](props);
}
function props(overrides = {}) { return { workspace: { user: { role: 'OWNER' } }, data: data(), order, blocked: false, save: async () => true, ...overrides }; }
function renderPanel(overrides = {}) { return invoke('default', props(overrides)); }
function elements(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
}
function field(tree, name) { return elements(tree).find(element => element.props.name === name); }
function button(tree, text) { return elements(tree).find(element => element.type === 'button' && React.Children.toArray(element.props.children).includes(text)); }
function form(options = {}) { return invoke('MaterialIssueForm', { ...props(), category: 'Panels', disabled: false, commit() {}, close() {}, report() {}, ...options }); }
function submit(tree) { tree.props.onSubmit({ preventDefault() {} }); }

test('job panel shows nine categories, real quotation reference and no stock deduction on render', () => {
  reset(); const calls = []; const tree = renderPanel({ save: async (...args) => { calls.push(args); return true; } });
  const html = renderToStaticMarkup(tree);
  assert.deepEqual(elements(tree).filter(element => element.type === 'section').map(element => element.props['aria-label']), [...REQUIRED_QUOTE_CATEGORIES]);
  assert.match(html, /Customer approved panel specification/); assert.match(html, /25 nos/);
  assert.match(html, /Quantities follow the stock item’s unit/);
  assert.equal(calls.length, 0);
});

test('material form never guesses stock item, source or quantity from the quotation', () => {
  reset(); const tree = form();
  for (const name of ['itemId', 'siteId', 'quantity']) assert.equal(field(tree, name).props.value, '');
  assert.equal(field(tree, 'siteId').props.disabled, true);
  assert.equal(field(tree, 'quantity').props.disabled, true);
  assert.equal(elements(field(tree, 'itemId')).some(element => element.props.value === 'inactive-item'), false);
  assert.equal(elements(field(tree, 'siteId')).some(element => element.props.value === 'inactive-site'), false);
  assert.equal(button(tree, 'Save material use').props.disabled, true);
});

test('exact stock choice controls units, availability and deliberately entered partial quantities', () => {
  reset(); const calls = []; const errors = []; const options = { commit: (...args) => calls.push(args), report: message => errors.push(message) };
  let tree = form(options); field(tree, 'itemId').props.onChange({ target: { value: 'wire' } });
  tree = form(options); assert.equal(field(tree, 'siteId').props.value, '');
  field(tree, 'siteId').props.onChange({ target: { value: 'store' } }); tree = form(options);
  assert.match(renderToStaticMarkup(tree), /Actual quantity \(m\)/);
  assert.match(renderToStaticMarkup(tree), /50.5 m available/);
  assert.equal(field(tree, 'quantity').props.max, '50.500');
  const emptySite = elements(field(tree, 'siteId')).find(element => element.props.value === 'empty-site');
  assert.equal(emptySite.props.disabled, true);
  field(tree, 'quantity').props.onChange({ target: { value: '2.125' } }); tree = form(options); submit(tree);
  assert.deepEqual(calls, [['job_material_issue', { workOrderId: 'work', category: 'Panels', itemId: 'wire', siteId: 'store', quantity: '2.125' }]]);
  assert.deepEqual(errors, []);
  field(tree, 'itemId').props.onChange({ target: { value: 'panels' } }); tree = form(options);
  assert.equal(field(tree, 'siteId').props.value, ''); assert.equal(field(tree, 'quantity').props.value, '');
});

test('quantity validation rejects unavailable stock, inactive choices, malformed and nonpositive values', () => {
  const stock = data();
  for (const quantity of ['0', '-1', '1e1', 'NaN', '1.0001', '10.001', '']) {
    assert.throws(() => views.materialIssuePayload(stock, order, 'Panels', 'panels', 'store', quantity));
  }
  assert.throws(() => views.materialIssuePayload(stock, order, 'Panels', 'panels', 'empty-site', '1'), /Only 0 nos/);
  assert.throws(() => views.materialIssuePayload(stock, order, 'Panels', 'inactive-item', 'store', '1'), /active stock item/);
  assert.throws(() => views.materialIssuePayload(stock, order, 'Panels', 'panels', 'inactive-site', '1'), /active source/);
  assert.throws(() => views.materialIssuePayload(stock, order, 'Invalid', 'panels', 'store', '1'), /category/);
  assert.equal(views.materialIssuePayload(stock, order, 'Panels', 'panels', 'store', '10').quantity, '10');
  reset(); let tree = form(); field(tree, 'itemId').props.onChange({ target: { value: 'panels' } });
  field(tree, 'siteId').props.onChange({ target: { value: 'store' } });
  stock.extension.siteBalances[0].quantityMilli = 0;
  tree = form({ data: stock }); assert.equal(button(tree, 'Save material use').props.disabled, true);
});

test('job history includes all partial uses and returns without combining different stock units', () => {
  reset(); const stock = data();
  stock.extension.jobMaterialEntries = [entry(), entry({ id: 'second', movementId: 'second-move', quantityMilli: 1000, returnedMilli: '0' }),
    entry({ id: 'metres', category: 'DC Wire', itemId: 'wire', quantityMilli: 5000, returnedMilli: '1250' }),
    entry({ id: 'weight', category: 'DC Wire', itemId: 'wire-weight', quantityMilli: 2000, returnedMilli: '0' }),
    entry({ id: 'other-work', workOrderId: 'another-work', quantityMilli: 10000, returnedMilli: '0' })];
  const tree = renderPanel({ data: stock }); const html = renderToStaticMarkup(tree);
  assert.match(html, /3 nos net used/); assert.match(html, /3.75 m net used/); assert.match(html, /2 kg net used/);
  assert.match(html, /0.5 returned · 2 net used/); assert.match(html, /View history \(2\)/);
  assert.doesNotMatch(html, /13 nos net used/);
  const summary = views.usageSummary(stock.extension.jobMaterialEntries.filter(row => row.category === 'DC Wire'), stock);
  assert.deepEqual(summary.map(row => [row.unit, row.quantity]), [['m', 3750n], ['kg', 2000n]]);
});

test('Filing completion uses its own stock-free action and duplicate clicks are guarded while saving', async () => {
  reset(); const calls = []; let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const options = { save: async (...args) => { calls.push(args); return pending; } };
  const tree = renderPanel(options);
  const complete = button(tree, 'Complete Filing without stock');
  complete.props.onClick(); complete.props.onClick();
  assert.deepEqual(calls, [['job_filing_complete', { workOrderId: 'work' }]]);
  const saving = renderPanel(options);
  assert.equal(button(saving, 'Complete Filing without stock').props.disabled, true);
  assert.equal(button(saving, 'Record material use').props.disabled, true);
  finish(true); await pending; await Promise.resolve();
  const stock = data(); stock.extension.jobMaterialEntries = [entry({ category: 'Filing', movementId: null, itemId: null, siteId: null, quantityMilli: null, returnedMilli: '0' })];
  const saved = renderPanel({ ...options, data: stock });
  assert.equal(button(saved, 'Complete Filing without stock'), undefined);
  assert.match(renderToStaticMarkup(saved), /Filing completion recorded/);
});

test('closed, paused, planned, example and unauthorised work orders preserve read-only history', () => {
  for (const status of ['PLANNED', 'ON_HOLD', 'COMPLETED', 'CANCELLED']) {
    reset(); const stock = data(); stock.extension.jobMaterialEntries = [entry()];
    const record = { ...order, status }; const tree = renderPanel({ data: stock, order: record });
    assert.equal(button(tree, 'Record material use'), undefined);
    assert.equal(button(tree, 'Complete Filing without stock'), undefined);
    assert.match(renderToStaticMarkup(tree), /2 nos net used/);
    assert.throws(() => views.materialIssuePayload(stock, record, 'Panels', 'panels', 'store', '1'), /In progress/);
  }
  for (const role of ['SALES', 'ACCOUNTANT', 'DEALER']) {
    reset(); assert.equal(button(renderPanel({ data: data(role) }), 'Record material use'), undefined);
  }
  for (const role of ['OWNER', 'MANAGER', 'OPERATIONS']) {
    reset(); assert.ok(button(renderPanel({ data: data(role) }), 'Record material use'));
  }
  reset(); assert.equal(button(renderPanel({ order: { ...order, isDemo: true } }), 'Record material use'), undefined);
  reset(); const cancelled = renderToStaticMarkup(renderPanel({ order: { ...order, status: 'CANCELLED' } }));
  assert.match(cancelled, /No recorded job activity/); assert.doesNotMatch(cancelled, /9 categories|Required/);
});

test('blocked writes and failed saves retain form choices for a safe retry', async () => {
  reset(); const calls = []; const blocked = renderPanel({ blocked: true, save: async (...args) => { calls.push(args); return true; } });
  button(blocked, 'Complete Filing without stock').props.onClick(); assert.equal(calls.length, 0);
  reset(); const tree = renderPanel({ save: async () => false });
  button(tree, 'Complete Filing without stock').props.onClick(); await Promise.resolve(); await Promise.resolve();
  const failed = renderPanel({ save: async () => false }); assert.match(renderToStaticMarkup(failed), /has not been confirmed/);
  reset(); const options = { disabled: true, commit: (...args) => calls.push(args) }; const formTree = form(options); submit(formTree); assert.equal(calls.length, 0);
});
