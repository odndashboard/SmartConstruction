import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { SITE_ALERT_ROLES, canResolveSiteAlert } from '../lib/site-alerts.ts';
import { AlertRequestError } from '../lib/site-alerts-client.ts';
import { ROLE_LABELS } from '../lib/types.ts';

const source = readFileSync(new URL('../components/SiteAlerts.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const compiled = ts.transpileModule(`${source}\nexport { AlertsWorkspace, AlertReportForm, reportPayload, canResolveAlert };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
let stores = new Map(), key = '', cursor = 0, effects = [];
let load = async () => fixture(), save = async () => ({ data: fixture(), message: 'Saved' });
function hook() { const values = stores.get(key); const index = cursor++; return { values, index }; }
function same(left, right) { return left && right && left.length === right.length && left.every((item, index) => item === right[index]); }
const blank = () => null;
const helpers = {
  useState(initial) { const { values, index } = hook(); if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
  useRef(initial) { const { values, index } = hook(); if (!(index in values)) values[index] = { current: initial }; return values[index]; },
  useCallback(fn, deps) { const { values, index } = hook(); if (!same(values[index]?.deps, deps)) values[index] = { fn, deps }; return values[index].fn; },
  useEffect(fn, deps) { const { values, index } = hook(); if (!same(values[index]?.deps, deps)) { const previous = values[index]; values[index] = { deps }; effects.push(() => { previous?.cleanup?.(); values[index].cleanup = fn(); }); } },
  SITE_ALERT_ROLES, canResolveSiteAlert, AlertRequestError, ROLE_LABELS, loadAlerts: (...args) => load(...args), saveAlert: (...args) => save(...args),
  styles: new Proxy({}, { get: (_, name) => name }), ArrowRight: blank, Bell: blank, Check: blank, ChevronLeft: blank, ChevronRight: blank, CircleAlert: blank, LoaderCircle: blank, Plus: blank, RefreshCw: blank, ShieldCheck: blank, X: blank,
};
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const order = { id: 'work', number: 'WO/1', title: 'Solar installation', status: 'ACTIVE', siteAddress: 'Genuine project site', isDemo: false };
const alert = { id: 'alert', workOrderId: 'work', workOrderNumber: 'WO/1', workOrderTitle: order.title, siteAddress: order.siteAddress,
  itemId: null, itemName: 'Missing DC cable', quantityMilli: 2250, unit: 'm', note: 'Required for the east roof', assigneeId: 'staff', assigneeName: 'Assigned teammate', reportedBy: 'reporter', reportedByName: 'Site reporter', status: 'OPEN', createdAt: '2026-11-27T07:00:00Z', resolvedAt: null, resolvedBy: null, resolvedByName: null };
function fixture(overrides = {}) { return { revision: 7, serverTime: '2026-11-27T07:00:00Z', user: { userId: 'staff', name: 'Assigned teammate', role: 'OPERATIONS' }, alerts: [alert], total: 1, page: 1, pageSize: 50, openCount: 1, resolvedCount: 0, assignees: [{ userId: 'staff', name: 'Assigned teammate', role: 'OPERATIONS' }], stockItems: [], workOrders: [order], ...overrides }; }
const workspace = { user: { userId: 'staff', role: 'OPERATIONS', active: true }, workorders: [order] };
function reset() { for (const values of stores.values()) for (const value of values) value?.cleanup?.(); stores = new Map(); effects = []; load = async () => fixture(); save = async () => ({ data: fixture(), message: 'Saved' }); }
function invoke(name, props, store = name) { key = store; cursor = 0; if (!stores.has(key)) stores.set(key, []); return views[name](props); }
async function flush() { const current = effects.splice(0); current.forEach(fn => fn()); await new Promise(resolve => setTimeout(resolve, 5)); }
function panel(options = {}) { return invoke('AlertsWorkspace', { workspace, ...options }); }
async function ready(options = {}) { panel(options); await flush(); return panel(options); }
function form(options = {}) { return invoke('AlertReportForm', { data: fixture(), order, disabled: false, report() {}, submit() {}, ...options }); }
function elements(element) { if (!React.isValidElement(element)) return []; return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]; }
function field(tree, name) { return elements(tree).find(element => element.props.name === name); }
function button(tree, label) { return elements(tree).find(element => element.type === 'button' && React.Children.toArray(element.props.children).includes(label)); }
function submit(tree) { tree.props.onSubmit({ preventDefault() {} }); }
function reportFields(overrides = {}) { return { workOrderId: 'work', mode: 'named', itemId: '', itemName: '  Missing bracket  ', assigneeId: 'staff', quantity: '', unit: '', note: '  Needed at site  ', ...overrides }; }

test('empty inventory still permits reporting an actual missing item with required active assignment', () => {
  reset(); const calls = []; let tree = form({ submit: payload => calls.push(payload) });
  assert.ok(field(tree, 'itemName')); assert.equal(field(tree, 'assigneeId').props.value, ''); assert.equal(field(tree, 'assigneeId').props.required, true);
  assert.match(renderToStaticMarkup(tree), /stock list is empty/);
  field(tree, 'itemName').props.onChange({ target: { value: 'Actual missing bracket' } });
  field(tree, 'assigneeId').props.onChange({ target: { value: 'staff' } });
  tree = form({ submit: payload => calls.push(payload) }); submit(tree);
  assert.deepEqual(calls, [{ workOrderId: 'work', assigneeId: 'staff', note: '', itemName: 'Actual missing bracket' }]);
});

test('catalogue selection preserves the actual stock unit and optional quantity does not imply stock use', () => {
  const data = fixture({ stockItems: [{ id: 'stock', name: 'Actual cable', unit: 'm' }] });
  assert.deepEqual(views.reportPayload(data, reportFields({ mode: 'catalogue', itemId: 'stock', itemName: 'Ignored name', quantity: '2.125' })),
    { workOrderId: 'work', assigneeId: 'staff', note: 'Needed at site', itemId: 'stock', quantity: '2.125', unit: 'm' });
  reset(); const tree = form({ data }); assert.ok(field(tree, 'itemId')); assert.equal(field(tree, 'unit').props.readOnly, true);
  assert.match(renderToStaticMarkup(tree), /does not change stock quantities/);
  assert.equal(views.reportPayload(data, reportFields({ mode: 'catalogue', itemId: 'stock' })).quantity, undefined);
});

test('report validation rejects missing names or assignments and invalid quantity/unit pairs', () => {
  for (const patch of [{ itemName: ' ' }, { assigneeId: '' }, { assigneeId: 'inactive' }, { workOrderId: 'closed-order' }, { quantity: '0', unit: 'm' }, { quantity: '-1', unit: 'm' }, { quantity: '1e3', unit: 'm' }, { quantity: '1.0001', unit: 'm' }, { quantity: '1', unit: '' }, { quantity: '', unit: 'm' }]) {
    assert.throws(() => views.reportPayload(fixture(), reportFields(patch)));
  }
  assert.deepEqual(views.reportPayload(fixture(), reportFields({ quantity: '1.5', unit: 'nos' })), { workOrderId: 'work', assigneeId: 'staff', itemName: 'Missing bracket', quantity: '1.5', unit: 'nos', note: 'Needed at site' });
});

test('alerts display reporter, assignment, work order and notes and limit resolution to eligible people', async () => {
  reset(); const opened = []; const tree = await ready({ onOpenWorkOrder: id => opened.push(id) }); const html = renderToStaticMarkup(tree);
  for (const text of ['Missing DC cable', 'Assigned teammate', 'Site reporter', 'WO/1', order.siteAddress, '2.25 m', alert.note]) assert.ok(html.includes(text));
  assert.ok(button(tree, 'Mark resolved'));
  elements(tree).find(item => item.props.className === 'orderLink').props.onClick(); assert.deepEqual(opened, ['work']);
  for (const role of ['OWNER', 'MANAGER']) assert.equal(views.canResolveAlert(fixture({ user: { userId: 'other', role } }), alert), true);
  for (const role of ['SALES', 'OPERATIONS', 'ACCOUNTANT']) assert.equal(views.canResolveAlert(fixture({ user: { userId: 'other', role } }), alert), false);
  assert.equal(views.canResolveAlert(fixture(), { ...alert, status: 'RESOLVED' }), false);
});

test('Open and Resolved filters and server search use scoped requests', async () => {
  reset(); const queries = [];
  load = async query => { queries.push(query); return fixture(query.status === 'RESOLVED' ? { alerts: [{ ...alert, status: 'RESOLVED', resolvedAt: '2026-11-27T08:00:00Z', resolvedBy: 'staff', resolvedByName: 'Assigned teammate' }], resolvedCount: 1, openCount: 0 } : {}); };
  let tree = await ready(); button(tree, 'Resolved ').props.onClick(); tree = panel(); await flush(); tree = panel();
  assert.equal(queries.at(-1).status, 'RESOLVED'); assert.match(renderToStaticMarkup(tree), /Resolved by Assigned teammate/); assert.equal(button(tree, 'Mark resolved'), undefined);
  panel({ search: 'cable' }); await flush(); await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal(queries.at(-1).search, 'cable'); assert.equal(queries.at(-1).page, 1);
});

test('uncertain saves freeze the request and retry the identical action without duplicate sends', async () => {
  reset(); const calls = []; const busy = [];
  save = async request => { calls.push(request); if (calls.length === 1) throw new AlertRequestError('Connection interrupted', 0, true); return { data: fixture({ alerts: [] }), message: 'Alert resolved' }; };
  const options = { onBusyChange: value => busy.push(value) }; let tree = await ready(options);
  const resolve = button(tree, 'Mark resolved'); resolve.props.onClick(); resolve.props.onClick(); await Promise.resolve(); await Promise.resolve();
  tree = panel(options); await flush(); tree = panel(options);
  assert.equal(calls.length, 1); assert.equal(calls[0].expectedRevision, 7); assert.match(renderToStaticMarkup(tree), /Save not yet confirmed/);
  assert.equal(button(tree, 'Mark resolved').props.disabled, true);
  button(tree, 'Retry save').props.onClick(); await Promise.resolve(); await Promise.resolve();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]); assert.ok(busy.includes(true));
});

test('action-level denial keeps the workspace, while revoked access clears alert data', async () => {
  for (const revoked of [false, true]) {
    reset(); const access = []; const options = { onAccessError: (...args) => access.push(args) };
    save = async () => { throw new AlertRequestError(revoked ? 'Session ended' : 'Not assigned to you', revoked ? 401 : 403, false, revoked); };
    let tree = await ready(options); button(tree, 'Mark resolved').props.onClick(); await Promise.resolve(); await Promise.resolve(); tree = panel(options);
    const html = renderToStaticMarkup(tree);
    assert.equal(access.length, revoked ? 1 : 0);
    if (revoked) assert.doesNotMatch(html, /Missing DC cable/); else assert.match(html, /Missing DC cable/);
  }
});

test('loading, empty and failed-refresh states keep their meaning and preserve previous alerts', async () => {
  reset(); assert.match(renderToStaticMarkup(panel()), /Loading alerts and available team members/);
  await flush(); let tree = panel();
  load = async () => { throw new Error('Connection unavailable'); };
  button(tree, 'Refresh').props.onClick(); await Promise.resolve(); await Promise.resolve(); tree = panel();
  const html = renderToStaticMarkup(tree); assert.match(html, /Connection unavailable/); assert.match(html, /Missing DC cable/);
  reset(); load = async () => fixture({ alerts: [], total: 0, openCount: 0 }); tree = await ready(); assert.match(renderToStaticMarkup(tree), /No open alerts/);
});

test('dealer and retired viewer accounts never mount the alerts workspace', () => {
  for (const role of ['DEALER', 'VIEWER']) {
    reset(); const tree = views.default({ workspace: { ...workspace, user: { ...workspace.user, role } } });
    assert.match(renderToStaticMarkup(tree), /does not have access to site alerts/);
    assert.equal(effects.length, 0);
  }
});
