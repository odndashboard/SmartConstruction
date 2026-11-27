import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { DealerLeadRequestError } from '../lib/dealer-leads-client.ts';
import { LEAD_STAGES, ROLE_LABELS } from '../lib/types.ts';
import { WORK_LABELS } from '../lib/work-order-status.ts';

let stores = new Map(), key = '', cursor = 0;
let load = async () => data(), create = async () => data(), remove = async () => ({ data: data(), message: 'Lead deleted.' }), effects = [];
const listeners = new Map();
const eventTarget = { addEventListener(name, handler) { listeners.set(name, handler); }, removeEventListener(name) { listeners.delete(name); } };
const browserDocument = { ...eventTarget, visibilityState: 'visible' };
const blank = () => null;
function slot(initial) { const values = stores.get(key); const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; }
const helpers = { useState: slot, useRef: value => slot({ current: value })[0], useCallback: fn => fn, useEffect(fn) { effects.push(fn); }, useId: () => 'team-id',
  DealerLeadRequestError, LEAD_STAGES, ROLE_LABELS, WORK_LABELS, window: eventTarget, document: browserDocument, loadDealerLeads: (...args) => load(...args), createDealerLead: (...args) => create(...args), deleteDealerLead: (...args) => remove(...args),
  SignOutButton: () => React.createElement('button', null, 'Sign out'), styles: new Proxy({}, { get: (_, name) => name }),
  ArrowRight: blank, Check: blank, CircleAlert: blank, LoaderCircle: blank, MapPin: blank, Plus: blank, RefreshCw: blank, UsersRound: blank, X: blank,
  ChevronDown: blank, Copy: blank, KeyRound: blank, RotateCcw: blank, ShieldCheck: blank, UserRound: blank, UserRoundMinus: blank };
function compile(path, extra = '') {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const code = ts.transpileModule(`${source}\n${extra}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {}; new Function('require', 'exports', ...Object.keys(helpers), code)(createRequire(import.meta.url), exports, ...Object.values(helpers)); return exports;
}
const views = compile('../components/DealerPortal.tsx', 'export { DealerLeadForm, DealerAssignments, dealerLeadPayload };');
const team = compile('../components/TeamSettings.tsx');
const lead = { id: 'own-lead', title: 'Own solar enquiry', contact: 'Genuine contact', phone: '9000000000', siteAddress: 'Own submitted site', expectedKw: 0, status: 'SITE_VISIT', createdAt: '2026-11-27T06:00:00Z', updatedAt: '2026-11-27T07:00:00Z', canDelete: false, deleteBlockedReason: 'Only new enquiries can be deleted.' };
const assigned = { id: 'assigned-work', title: 'Assigned installation', siteAddress: 'Assigned roof', siteName: 'Team site', siteId: 'site', leadId: 'not-own-lead', workOrderId: 'work', workOrderNumber: 'WO/1', leadStatus: 'WON', workOrderStatus: 'ACTIVE', expectedKw: 0, completedMilestones: 1, totalMilestones: 3, assignedVia: ['LEAD', 'WORK_ORDER', 'SITE'] };
function data(overrides = {}) { return { revision: 7, user: { userId: 'dealer', name: 'Synthetic Dealer', role: 'DEALER' }, leads: [lead], assignedSites: [], ...overrides }; }
function reset() { stores = new Map(); load = async () => data(); create = async () => data(); remove = async () => ({ data: data(), message: 'Lead deleted.' }); effects = []; listeners.clear(); browserDocument.visibilityState = 'visible'; }
function invoke(fn, props, name) { key = name; cursor = 0; if (!stores.has(key)) stores.set(key, []); return fn(props); }
function portal(props = {}) { return invoke(views.default, { initialData: data(), ...props }, 'portal'); }
function form(props = {}) { return invoke(views.DealerLeadForm, { disabled: false, submit() {}, close() {}, report() {}, ...props }, 'form'); }
function elements(element) { if (!React.isValidElement(element)) return []; return [element, ...React.Children.toArray(element.props.children).flatMap(elements)]; }
function button(tree, label) { return elements(tree).find(element => element.type === 'button' && React.Children.toArray(element.props.children).includes(label)); }
function field(tree, name) { return elements(tree).find(element => element.props.name === name); }
function submit(tree) { tree.props.onSubmit({ preventDefault() {} }); }

test('dealer portal renders only own lead fields, real stage/progress and logout', () => {
  reset(); const html = renderToStaticMarkup(portal());
  for (const text of ['Dealer portal', 'Your leads', 'Own solar enquiry', 'Genuine contact', '9000000000', 'Own submitted site', '0 kW', 'Site visit', 'Site visit stage', 'Sign out']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /dashboard|Quotations|Work orders|Stock|Payments|Alerts|Team settings/i);
  const source = readFileSync(new URL('../components/DealerPortal.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /CRMApp|OperationsPanel|DashboardOverview|SiteAlerts|\/api\/(workspace|dashboard|operations|alerts)/);
});

test('dealer Add Lead accepts only lead details and numeric optional capacity, without customer or email', () => {
  reset(); const calls = []; let tree = form({ submit: payload => calls.push(payload) });
  assert.deepEqual(elements(tree).filter(item => ['input', 'textarea', 'select'].includes(item.type)).map(item => item.props.name), ['title', 'contact', 'phone', 'expectedKw', 'siteAddress']);
  assert.equal(field(tree, 'title').props.required, true); assert.equal(field(tree, 'expectedKw').props.min, '0'); assert.equal(field(tree, 'expectedKw').props.step, 'any');
  field(tree, 'title').props.onChange({ target: { value: '  Actual project  ' } }); field(tree, 'expectedKw').props.onChange({ target: { value: '10.25' } });
  tree = form({ submit: payload => calls.push(payload) }); submit(tree);
  assert.deepEqual(calls, [{ title: 'Actual project', contact: '', phone: '', siteAddress: '', expectedKw: 10.25 }]);
  const base = { title: 'Project', contact: '', phone: '', siteAddress: '', expectedKw: '' };
  assert.equal(views.dealerLeadPayload(base).expectedKw, null); assert.equal(views.dealerLeadPayload({ ...base, expectedKw: '0' }).expectedKw, 0);
  for (const expectedKw of ['-1', 'Infinity', 'NaN', '5 kW', '0x10', '1e309']) assert.throws(() => views.dealerLeadPayload({ ...base, expectedKw }));
  assert.throws(() => views.dealerLeadPayload({ ...base, title: ' ' }));
});

test('dealer creation guards duplicate clicks and preserves exact uncertain submission on retry', async () => {
  reset(); const calls = []; create = async request => { calls.push(request); if (calls.length === 1) throw new DealerLeadRequestError('Uncertain save', 0, true); return data({ leads: [...data().leads, { ...lead, id: 'new', title: 'New own lead', status: 'NEW' }] }); };
  let tree = portal(); button(tree, 'Add lead').props.onClick(); tree = portal();
  const editor = elements(tree).find(item => item.type === views.DealerLeadForm); assert.ok(editor);
  const payload = { title: 'New own lead', expectedKw: 3.5 };
  editor.props.submit(payload); editor.props.submit(payload); await Promise.resolve(); await Promise.resolve(); tree = portal();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].payload, payload); assert.equal(elements(tree).find(item => item.type === views.DealerLeadForm).props.disabled, true);
  assert.ok(button(tree, 'Retry submission')); button(tree, 'Retry submission').props.onClick(); await Promise.resolve(); await Promise.resolve(); tree = portal();
  assert.deepEqual(calls[1], calls[0]); assert.match(renderToStaticMarkup(tree), /New own lead/); assert.equal(elements(tree).find(item => item.type === views.DealerLeadForm), undefined);
});

test('dealer refresh errors preserve own leads but revoked access clears them', async () => {
  reset(); load = async () => { throw new Error('Connection stalled'); };
  let tree = portal(); button(tree, 'Refresh').props.onClick(); await Promise.resolve(); await Promise.resolve(); tree = portal();
  assert.match(renderToStaticMarkup(tree), /Own solar enquiry/); assert.match(renderToStaticMarkup(tree), /Connection stalled/);
  load = async () => { throw new DealerLeadRequestError('Access removed', 403); };
  button(tree, 'Refresh').props.onClick(); await Promise.resolve(); await Promise.resolve(); tree = portal();
  const html = renderToStaticMarkup(tree); assert.doesNotMatch(html, /Own solar enquiry|Genuine contact/); assert.match(html, /Dealer access has changed/);
});

test('dealer initial failure has a clear retry and empty accounts have a lead-only starting point', () => {
  reset(); const failed = renderToStaticMarkup(portal({ initialData: null, initialError: 'Temporary connection issue' })); assert.match(failed, /Try refreshing/); assert.match(failed, /Temporary connection issue/);
  reset(); const empty = renderToStaticMarkup(portal({ initialData: data({ leads: [] }) })); assert.match(empty, /Your first lead starts here/); assert.match(empty, /Add lead/);
});

test('team settings offers Dealer instead of Viewer and describes the limited portal', () => {
  reset(); const owner = { userId: 'owner', name: 'Owner', role: 'OWNER', email: 'owner@example.invalid', active: true };
  const props = { data: { user: owner, members: [owner] }, owner: true, busy: false, mutate() {}, onUpdated() {} };
  let tree = invoke(team.default, props, 'team'); button(tree, 'Add employee').props.onClick(); tree = invoke(team.default, props, 'team');
  const select = field(tree, 'role'); assert.equal(select.props.defaultValue, 'DEALER');
  const options = elements(select).filter(item => item.type === 'option').map(item => item.props.value);
  assert.ok(options.includes('DEALER')); assert.ok(!options.includes('VIEWER'));
  const html = renderToStaticMarkup(tree); assert.match(html, /own submitted leads/); assert.match(html, /separate dealer portal/); assert.doesNotMatch(html, /Viewer/);
});

test('assigned sites remain visible without submissions and show only explicit assigned project progress', () => {
  reset(); const html = renderToStaticMarkup(portal({ initialData: data({ leads: [], assignedSites: [assigned] }) }));
  for (const text of ['Assigned sites', 'Assigned installation', 'Assigned roof', 'Team site', 'WO/1', 'In progress', '0 kW', '1 of 3 milestones completed', 'Your first lead starts here']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /not-own-lead|Delete lead|Genuine contact|Payments|Quotation total/);
  reset(); assert.match(renderToStaticMarkup(portal()), /No sites are assigned to you yet/);
});

test('deletion names the eligible enquiry, requires confirmation and replays only its original uncertain request', async () => {
  reset(); const calls = [];
  const ownNew = { ...lead, status: 'NEW', canDelete: true, deleteBlockedReason: null };
  const initialData = data({ leads: [ownNew], assignedSites: [assigned] });
  remove = async request => { calls.push(request); if (calls.length === 1) throw new DealerLeadRequestError('Response lost', 0, true); return { data: data({ revision: 8, leads: [], assignedSites: [assigned] }), message: 'Lead deleted.' }; };
  let tree = portal({ initialData });
  button(tree, 'Delete lead').props.onClick(); tree = portal({ initialData });
  assert.equal(calls.length, 0);
  assert.match(renderToStaticMarkup(tree), /Delete “Own solar enquiry”\?/);
  assert.match(renderToStaticMarkup(tree), /cannot be undone/);
  button(tree, 'Keep enquiry').props.onClick(); tree = portal({ initialData });
  assert.equal(elements(tree).find(item => item.props.role === 'alertdialog'), undefined);
  button(tree, 'Delete lead').props.onClick(); tree = portal({ initialData });
  const confirmation = elements(tree).find(item => item.props.role === 'alertdialog');
  button(confirmation, 'Delete lead').props.onClick(); button(confirmation, 'Delete lead').props.onClick();
  await new Promise(done => setImmediate(done)); tree = portal({ initialData });
  assert.equal(calls.length, 1); assert.equal(calls[0].leadId, 'own-lead'); assert.equal(calls[0].expectedRevision, 7);
  assert.match(renderToStaticMarkup(tree), /Deletion not yet confirmed/);
  button(tree, 'Retry deletion').props.onClick(); await new Promise(done => setImmediate(done)); tree = portal({ initialData });
  assert.deepEqual(calls[1], calls[0]);
  assert.match(renderToStaticMarkup(tree), /“Own solar enquiry” was deleted/);
  assert.match(renderToStaticMarkup(tree), /Assigned installation/);
  assert.equal(elements(tree).find(item => item.props.role === 'alertdialog'), undefined);
  assert.equal(button(tree, 'Delete lead'), undefined);
});

test('protected enquiries show an unavailable Delete lead button and reason; denied deletion refreshes eligibility without revoking active access', async () => {
  reset(); let tree = portal(); assert.equal(button(tree, 'Delete lead').props.disabled, true); assert.equal(button(tree, 'Delete lead').props.onClick, undefined);
  assert.match(renderToStaticMarkup(tree), /Only new enquiries can be deleted/);
  reset(); const initialData = data({ leads: [{ ...lead, status: 'NEW', canDelete: true, deleteBlockedReason: null }] });
  remove = async () => { throw new DealerLeadRequestError('This enquiry is now assigned.', 403, false, false); };
  load = async () => data({ revision: 8, leads: [{ ...lead, status: 'NEW', deleteBlockedReason: 'Assigned enquiries are protected.' }], assignedSites: [assigned] });
  tree = portal({ initialData }); button(tree, 'Delete lead').props.onClick(); tree = portal({ initialData });
  button(elements(tree).find(item => item.props.role === 'alertdialog'), 'Delete lead').props.onClick();
  await new Promise(done => setImmediate(done)); tree = portal({ initialData });
  assert.match(renderToStaticMarkup(tree), /Assigned enquiries are protected/); assert.match(renderToStaticMarkup(tree), /Assigned installation/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /Dealer access has changed|Retry deletion/); assert.equal(button(tree, 'Delete lead').props.disabled, true); assert.equal(button(tree, 'Delete lead').props.onClick, undefined);
});

test('every submitted lead has a findable Delete lead label while protected cards never offer an action', () => {
  reset(); const leads = [
    { ...lead, id: 'eligible', status: 'NEW', canDelete: true, deleteBlockedReason: null },
    { ...lead, id: 'assigned', status: 'NEW', canDelete: false, deleteBlockedReason: 'Assigned enquiries are protected.' },
    { ...lead, id: 'historical', status: 'WON', canDelete: false, deleteBlockedReason: null },
    { ...lead, id: 'inconsistent', status: 'SITE_VISIT', canDelete: true, deleteBlockedReason: null },
  ];
  const tree = portal({ initialData: data({ leads }) });
  const buttons = elements(tree).filter(item => item.type === 'button' && item.props['aria-label']?.startsWith('Delete lead:'));
  assert.equal(buttons.length, 4); assert.equal(buttons[0].props.disabled, false); assert.equal(typeof buttons[0].props.onClick, 'function');
  for (const item of buttons.slice(1)) { assert.equal(item.props.disabled, true); assert.equal(item.props.onClick, undefined); assert.ok(item.props['aria-describedby']); }
  const html = renderToStaticMarkup(tree); assert.match(html, /Unavailable: Assigned enquiries are protected/); assert.match(html, /Unavailable: Only your untouched new enquiries can be deleted/);
});

test('long assigned-site lists provide a direct submissions shortcut and assigned-only accounts explain Admin review without destructive controls', () => {
  reset(); const assignedSites = Array.from({ length: 20 }, (_, index) => ({ ...assigned, id: `assigned-${index}`, title: `Assigned project ${index}` }));
  const tree = portal({ initialData: data({ assignedSites }) });
  const jump = elements(tree).find(item => item.type === 'a' && item.props.href === '#dealer-submitted-leads');
  assert.ok(jump); assert.match(renderToStaticMarkup(jump), /Your submitted leads \(1\)/);
  assert.ok(elements(tree).some(item => item.props.id === 'dealer-submitted-leads'));
  const html = renderToStaticMarkup(tree); assert.ok(html.indexOf('Your submitted leads') < html.indexOf('Assigned project 0'));
  reset(); const assignedOnly = portal({ initialData: data({ leads: [], assignedSites }) });
  const assignedOnlyHtml = renderToStaticMarkup(assignedOnly); assert.match(assignedOnlyHtml, /You have no submitted leads to delete/); assert.match(assignedOnlyHtml, /For a lead you did not submit, contact Admin to review its removal/);
  assert.equal(button(assignedOnly, 'Delete lead'), undefined); assert.equal(elements(assignedOnly).find(item => item.type === 'a' && item.props.href === '#dealer-submitted-leads'), undefined);
});

test('regaining focus refreshes assignments and role, coalesces duplicate resume events and clears scoped data after revocation', async () => {
  reset(); let resolveRead, count = 0;
  load = () => { count++; return new Promise(resolve => { resolveRead = resolve; }); };
  portal(); const cleanup = effects.at(-1)();
  listeners.get('focus')(); listeners.get('visibilitychange')(); assert.equal(count, 1);
  resolveRead(data({ assignedSites: [assigned] })); await new Promise(done => setImmediate(done));
  assert.match(renderToStaticMarkup(portal()), /Assigned installation/);
  load = async () => { throw new DealerLeadRequestError('Dealer access removed', 403); };
  listeners.get('focus')(); await new Promise(done => setImmediate(done));
  const html = renderToStaticMarkup(portal()); assert.match(html, /Dealer access has changed/); assert.doesNotMatch(html, /Own solar enquiry|Assigned installation/);
  cleanup(); assert.equal(listeners.size, 0);
});

test('a stale read cannot restore a deleted enquiry and a focus event during deletion validates the latest scoped access afterwards', async () => {
  reset(); const initialData = data({ leads: [{ ...lead, status: 'NEW', canDelete: true, deleteBlockedReason: null }] });
  let finishRead, finishDelete;
  load = () => new Promise(resolve => { finishRead = resolve; });
  remove = () => new Promise(resolve => { finishDelete = resolve; });
  let tree = portal({ initialData }); const cleanup = effects.at(-1)();
  button(tree, 'Delete lead').props.onClick(); tree = portal({ initialData });
  const confirmation = elements(tree).find(item => item.props.role === 'alertdialog');
  listeners.get('focus')();
  button(confirmation, 'Delete lead').props.onClick();
  finishRead(data({ assignedSites: [assigned] })); await new Promise(done => setImmediate(done));
  listeners.get('focus')();
  load = async () => { throw new DealerLeadRequestError('Access removed', 403); };
  finishDelete({ data: data({ revision: 8, leads: [] }), message: 'Lead deleted.' }); await new Promise(done => setImmediate(done));
  assert.doesNotMatch(renderToStaticMarkup(portal({ initialData })), /Own solar enquiry|Assigned installation/);
  assert.match(renderToStaticMarkup(portal({ initialData })), /Dealer access has changed/); cleanup();
});
