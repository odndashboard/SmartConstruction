import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { DealerLeadRequestError } from '../lib/dealer-leads-client.ts';
import { LEAD_STAGES, ROLE_LABELS } from '../lib/types.ts';

let stores = new Map(), key = '', cursor = 0;
let load = async () => data(), create = async () => data();
const blank = () => null;
function slot(initial) { const values = stores.get(key); const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; }
const helpers = { useState: slot, useRef: value => slot({ current: value })[0], useCallback: fn => fn, useEffect() {}, useId: () => 'team-id',
  DealerLeadRequestError, LEAD_STAGES, ROLE_LABELS, loadDealerLeads: (...args) => load(...args), createDealerLead: (...args) => create(...args),
  SignOutButton: () => React.createElement('button', null, 'Sign out'), styles: new Proxy({}, { get: (_, name) => name }),
  ArrowRight: blank, Check: blank, CircleAlert: blank, LoaderCircle: blank, MapPin: blank, Plus: blank, RefreshCw: blank, UsersRound: blank, X: blank,
  ChevronDown: blank, Copy: blank, KeyRound: blank, RotateCcw: blank, ShieldCheck: blank, UserRound: blank, UserRoundMinus: blank };
function compile(path, extra = '') {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const code = ts.transpileModule(`${source}\n${extra}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {}; new Function('require', 'exports', ...Object.keys(helpers), code)(createRequire(import.meta.url), exports, ...Object.values(helpers)); return exports;
}
const views = compile('../components/DealerPortal.tsx', 'export { DealerLeadForm, dealerLeadPayload };');
const team = compile('../components/TeamSettings.tsx');
const lead = { id: 'own-lead', title: 'Own solar enquiry', contact: 'Genuine contact', phone: '9000000000', siteAddress: 'Own submitted site', expectedKw: 0, status: 'SITE_VISIT', createdAt: '2026-11-27T06:00:00Z', updatedAt: '2026-11-27T07:00:00Z' };
function data(overrides = {}) { return { user: { userId: 'dealer', name: 'Synthetic Dealer', role: 'DEALER' }, leads: [lead], ...overrides }; }
function reset() { stores = new Map(); load = async () => data(); create = async () => data(); }
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
