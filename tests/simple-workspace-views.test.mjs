import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { LEAD_STAGES } from '../lib/types.ts';
import { todayIST } from '../lib/finance.ts';
import { effectiveQuoteStatus } from '../lib/quotation-status.ts';
import { getFollowupQuotationContext } from '../lib/followup-quotation.ts';
import { WORK_LABELS, WORK_TRANSITIONS } from '../lib/work-order-status.ts';
import { DOCUMENT_KEYS, DOCUMENT_NAMES } from '../lib/work-documents.ts';
import { canRecordWorkOrderPayment } from '../lib/work-order-payments.ts';

const source = readFileSync(new URL('../components/SimpleWorkspace.tsx', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const compiled = ts.transpileModule(`${source}\nexport { SimpleWorkspaceContent, SimpleLead, SimpleFollowup, SimpleOrder, permissionFor };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
let slots = [], cursor = 0;
const helpers = {
  useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
  useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  useEffect() {}, useMemo: fn => fn(), LEAD_STAGES, todayIST, effectiveQuoteStatus, WORK_LABELS, WORK_TRANSITIONS, DOCUMENT_KEYS, DOCUMENT_NAMES, canRecordWorkOrderPayment,
  getFollowupQuotationContext,
  styles: new Proxy({}, { get: (_target, name) => name }),
};
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const baseLead = { id: 'lead', title: 'Solar roof', customerId: 'customer', contact: 'Site contact', phone: '9000000000', status: 'NEW', expectedKw: 0, isDemo: false, lostReason: '', siteAddress: 'Actual site' };
const baseQuote = { id: 'quote', leadId: 'lead', title: 'Solar quotation', number: 'Q/1', status: 'ISSUED', validUntil: '2099-01-01', revision: 1, isDemo: false, createdAt: '2026-11-27T00:00:00Z' };
const baseFollow = { id: 'follow', leadId: 'lead', title: 'Discuss roof', status: 'OPEN', dueAt: '2099-01-01T12:00:00+05:30', channel: 'Call', outcome: '', isDemo: false, quoteId: 'quote' };
const baseOrder = { id: 'work', leadId: 'lead', title: 'Solar installation', number: 'WO/1', customerName: 'Site contact', siteAddress: 'Actual site', status: 'ACTIVE', isDemo: false, quoteId: null, snapshot: null, milestones: [] };
function fixture(role = 'OWNER') {
  return { user: { role, active: true }, members: [], customers: [{ id: 'customer', name: 'Solar customer' }], leads: [{ ...baseLead }], quotations: [{ ...baseQuote }], followups: [{ ...baseFollow }], workorders: [{ ...baseOrder }] };
}
function nodes(element) { return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(nodes)] : []; }
function text(element) { return React.Children.toArray(element?.props?.children).map(item => React.isValidElement(item) ? text(item) : String(item)).join(''); }
function button(tree, name) { return nodes(tree).find(item => item.type === 'button' && (item.props['aria-label'] === name || text(item) === name)); }
function html(tree) { return renderToStaticMarkup(tree); }
function row(name, data, extra = {}) { const workspace = name === 'SimpleOrder' ? { ...data, workorders: [extra.order] } : data; return views[name]({ permissions: views.permissionFor(data), open() {}, disabled: false, now: new Date(), workorders: [], workspace, ...extra }); }
function content(data, extra = {}) { cursor = 0; return views.SimpleWorkspaceContent({ workspace: data, busy: false, open() {}, onRefresh() {}, ...extra }); }

test('simple workspace keeps all seven lead states and honest Approved/Won and Lost behavior', () => {
  slots = [];
  const data = fixture();
  const tree = content(data);
  const select = nodes(tree).find(item => item.type === 'select');
  assert.deepEqual(nodes(select).filter(item => item.type === 'option').map(item => item.props.value), ['ALL', ...LEAD_STAGES.map(stage => stage.value)]);
  assert.match(html(tree), /Approved \/ Won/);
  assert.match(html(tree), /Not approved \/ Lost/);
  const opened = [];
  const won = row('SimpleLead', data, { lead: { ...baseLead, status: 'WON' }, quotes: [], hasOpenFollowup: false, open: target => opened.push(target) });
  assert.doesNotMatch(html(won), /Change lead status|Reopen lead/);
  assert.match(html(won), /Won leads cannot be reopened/);
  button(won, 'Schedule follow-up for Solar roof').props.onClick();
  assert.deepEqual(opened.pop(), { type: 'followup', leadId: 'lead' });
  const lost = row('SimpleLead', data, { lead: { ...baseLead, status: 'LOST', lostReason: 'Customer postponed' }, quotes: [], hasOpenFollowup: false, open: target => opened.push(target) });
  assert.match(html(lost), /Customer postponed/);
  assert.doesNotMatch(html(lost), /Quotation &amp; follow-up|Schedule follow-up/);
  button(lost, 'Reopen Solar roof').props.onClick();
  assert.deepEqual(opened.pop(), { type: 'lead_status', id: 'lead' });
});

test('quotation handoff works directly from a lead and multiple quotations are explicit choices', () => {
  const data = fixture(), opened = [];
  const quotes = [{ ...baseQuote, id: 'draft', title: 'Actual draft', status: 'DRAFT', number: null }, { ...baseQuote, id: 'accepted', title: 'Accepted scope', status: 'ACCEPTED' }];
  const tree = row('SimpleLead', data, { lead: baseLead, customerName: 'Solar customer', quotes, hasOpenFollowup: true, open: target => opened.push(target) });
  const markup = html(tree);
  assert.match(markup, /0 kW/);
  assert.match(markup, /2 quotations · choose one/);
  assert.match(markup, /Draft · not issued/);
  assert.doesNotMatch(markup, /No follow-up scheduled/);
  button(tree, 'Quotation and follow-up for Solar roof').props.onClick();
  button(tree, 'Review & issue: Actual draft').props.onClick();
  button(tree, 'View quotation: Accepted scope').props.onClick();
  assert.deepEqual(opened, [{ type: 'followup_quote', leadId: 'lead' }, { type: 'quote_status', id: 'draft' }, { type: 'quote_detail', id: 'accepted' }]);
});

test('follow-up rows retain completion, exact quotation context and follow-up identity for handoff', () => {
  const data = fixture(), opened = [];
  const tree = row('SimpleFollowup', data, { item: { ...baseFollow, status: 'DONE', outcome: 'Customer will confirm tomorrow' }, lead: baseLead, open: target => opened.push(target) });
  assert.match(html(tree), /Completed/);
  assert.match(html(tree), /Customer will confirm tomorrow/);
  assert.match(html(tree), /Linked quotation: Q\/1 · Awaiting approval/);
  assert.equal(button(tree, 'Mark completed'), undefined);
  button(tree, 'Quotation given for Discuss roof?').props.onClick();
  assert.deepEqual(opened, [{ type: 'followup_quote', id: 'follow' }]);
  const noLink = row('SimpleFollowup', data, { item: { ...baseFollow, quoteId: undefined }, lead: baseLead });
  assert.doesNotMatch(html(noLink), /Linked quotation/);
  const open = row('SimpleFollowup', data, { item: baseFollow, lead: baseLead, open: target => opened.push(target) });
  button(open, 'Complete follow-up: Discuss roof').props.onClick();
  assert.deepEqual(opened.at(-1), { type: 'followup_complete', id: 'follow' });
});

test('job rows show actual pending documents and route status, filing and eligible payments precisely', () => {
  const data = fixture(); data.leads[0].status = 'WON';
  const opened = [];
  const order = { ...baseOrder, paperDocuments: { electricityBill: 'RECEIVED' }, milestones: [{ status: 'DONE' }, { status: 'PENDING' }] };
  const tree = row('SimpleOrder', data, { order, open: target => opened.push(target) });
  const markup = html(tree);
  assert.match(markup, /6 documents pending/);
  assert.match(markup, /Registration \/ Allotment/);
  assert.doesNotMatch(markup, /Electricity Bill|₹|unpaid|outstanding|Paid/);
  assert.match(markup, /1 of 2 milestones completed/);
  assert.match(markup, /No accepted quotation linked/);
  for (const name of ['Review documents for Solar installation', 'Update job status: Solar installation', 'Job items for Solar installation', 'Payments for Solar installation']) button(tree, name).props.onClick();
  assert.deepEqual(opened, [{ type: 'work_documents', id: 'work' }, { type: 'work_status', id: 'work' }, { type: 'work_job', id: 'work' }, { type: 'work_payment', id: 'work' }]);
  const all = row('SimpleOrder', data, { order: { ...baseOrder, paperDocuments: Object.fromEntries(DOCUMENT_KEYS.map(key => [key, 'RECEIVED'])) } });
  assert.match(html(all), /All 7 documents received/);
  const cancelled = row('SimpleOrder', data, { order: { ...baseOrder, status: 'CANCELLED' } });
  assert.match(html(cancelled), /View job history/);
  assert.doesNotMatch(html(cancelled), /Update job status|Payments/);
  const planned = row('SimpleOrder', data, { order: { ...baseOrder, status: 'PLANNED' } });
  assert.doesNotMatch(html(planned), /Job items &amp; filing/);
});

test('simple actions preserve role policies and keep Dealer/inactive accounts out of the staff workspace', () => {
  for (const role of ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT']) {
    const data = fixture(role); data.leads[0].status = 'WON';
    const lead = html(row('SimpleLead', data, { lead: baseLead, quotes: [{ ...baseQuote, status: 'DRAFT' }], hasOpenFollowup: false }));
    assert.equal(lead.includes('Change lead status'), ['OWNER', 'MANAGER'].includes(role));
    assert.equal(lead.includes('Quotation &amp; follow-up'), ['OWNER', 'MANAGER', 'SALES'].includes(role));
    const follow = html(row('SimpleFollowup', data, { item: baseFollow, lead: baseLead }));
    assert.equal(follow.includes('Mark completed'), role !== 'ACCOUNTANT');
    const work = html(row('SimpleOrder', data, { order: baseOrder }));
    assert.equal(work.includes('Update job status'), ['OWNER', 'MANAGER', 'OPERATIONS'].includes(role));
    assert.equal(work.includes('>Payments<'), role === 'OWNER');
    assert.match(work, /Review documents/);
  }
  for (const [role, active] of [['DEALER', true], ['VIEWER', true], ['OWNER', false]]) {
    const workspace = fixture(role); workspace.user.active = active;
    const markup = html(views.default({ workspace, busy: false, open() {}, onRefresh() {} }));
    assert.doesNotMatch(markup, /Solar roof|Solar installation|Find a project|Choose a task/);
  }
  const data = fixture();
  const example = row('SimpleOrder', data, { order: { ...baseOrder, isDemo: true } });
  assert.match(html(example), /Example/);
  assert.doesNotMatch(html(example), /Review documents|Payments|Job items &amp; filing/);
});

test('search, task views and pagination preserve source ordering and keep the first screen concise', () => {
  slots = [];
  const data = fixture(); data.leads = Array.from({ length: 10 }, (_, i) => ({ ...baseLead, id: `lead-${i}`, title: `Project ${i}`, status: i === 9 ? 'WON' : 'NEW' }));
  let tree = content(data);
  let cards = nodes(tree).filter(item => item.type === views.SimpleLead);
  assert.equal(cards.length, 8);
  assert.deepEqual(cards.map(item => item.props.lead.id), data.leads.slice(0, 8).map(item => item.id));
  button(tree, 'Show 2 more · 2 remaining').props.onClick();
  tree = content(data); assert.equal(nodes(tree).filter(item => item.type === views.SimpleLead).length, 10);
  nodes(tree).find(item => item.type === 'input').props.onChange({ target: { value: 'Project 9' } });
  tree = content(data); cards = nodes(tree).filter(item => item.type === views.SimpleLead);
  assert.deepEqual(cards.map(item => item.props.lead.id), ['lead-9']);
  nodes(tree).find(item => item.type === 'input').props.onChange({ target: { value: '' } });
  tree = content(data);
  button(tree, 'Follow-ups 1').props.onClick(); tree = content(data);
  assert.equal(nodes(tree).filter(item => item.type === views.SimpleFollowup).length, 1);
  button(tree, 'Work orders 1').props.onClick(); tree = content(data);
  assert.equal(nodes(tree).filter(item => item.type === views.SimpleOrder).length, 1);
});

test('refresh is intentional, ignores duplicate clicks and retains visible rows on failure', async () => {
  slots = [];
  const data = fixture(); let resolve, calls = 0;
  const onRefresh = () => { calls++; return new Promise(done => { resolve = done; }); };
  const tree = content(data, { onRefresh });
  button(tree, 'Refresh').props.onClick(); button(tree, 'Refresh').props.onClick();
  assert.equal(calls, 1);
  assert.match(html(content(data, { onRefresh })), /Refreshing…/);
  resolve(); await new Promise(done => setImmediate(done));
  const failed = content(data, { onRefresh: async () => { throw new Error('Connection interrupted'); } });
  button(failed, 'Refresh').props.onClick(); await new Promise(done => setImmediate(done));
  const after = html(content(data));
  assert.match(after, /Connection interrupted/);
  assert.match(after, /Solar roof/);
  assert.doesNotMatch(source, /fetch\(|readJson\(|setInterval\(/);
});

test('won lead work-order links resolve exact current and historical IDs without guessing across scopes', () => {
  slots = [];
  const data = fixture(); data.leads[0].status = 'WON';
  data.workorders = [
    { ...baseOrder, id: 'direct', number: 'WO/direct' },
    { ...baseOrder, id: 'historical-snapshot', number: 'WO/snapshot', leadId: undefined, snapshot: { ...baseQuote } },
    { ...baseOrder, id: 'historical-quote', number: 'WO/quote', leadId: undefined, quoteId: baseQuote.id },
    { ...baseOrder, id: 'other-lead', number: 'WO/other', leadId: 'another-lead' },
    { ...baseOrder, id: 'example', number: 'WO/demo', isDemo: true },
  ];
  const card = nodes(content(data)).find(item => item.type === views.SimpleLead);
  assert.deepEqual(card.props.workorders.map(order => order.id), ['direct', 'historical-snapshot', 'historical-quote']);
  const opened = [];
  const tree = views.SimpleLead({ ...card.props, open: target => opened.push(target) });
  for (const number of ['WO/direct', 'WO/snapshot', 'WO/quote']) button(tree, `Open work order ${number} for Solar roof`).props.onClick();
  assert.deepEqual(opened.map(target => target.id), ['direct', 'historical-snapshot', 'historical-quote']);
  assert.doesNotMatch(html(tree), /Won leads cannot be reopened|WO\/other|WO\/demo/);
});

test('follow-ups offer first reminders only for real approved leads with no history, respecting search and roles', () => {
  slots = [];
  const data = fixture(), opened = [];
  data.leads = ['first', 'second', 'done', 'cancelled', 'open', 'example', 'new'].map(id => ({ ...baseLead, id, title: `Project ${id}`, status: id === 'new' ? 'NEW' : 'WON', isDemo: id === 'example' }));
  data.followups = [['done', 'DONE'], ['cancelled', 'CANCELLED'], ['open', 'OPEN']].map(([id, status]) => ({ ...baseFollow, id: `follow-${id}`, leadId: id, status }));
  const props = { open: target => opened.push(target) };
  let tree = content(data, props);
  assert.doesNotMatch(html(tree), /Approved leads to schedule/);
  button(tree, 'Follow-ups 1').props.onClick(); tree = content(data, props);
  assert.match(html(tree), /Approved leads to schedule \(2\)/);
  button(tree, 'Schedule first follow-up for Project second').props.onClick();
  assert.deepEqual(opened, [{ type: 'followup', leadId: 'second' }]);
  for (const id of ['done', 'cancelled', 'open', 'example', 'new']) assert.equal(button(tree, `Schedule first follow-up for Project ${id}`), undefined);
  nodes(tree).find(item => item.type === 'input').props.onChange({ target: { value: 'Project first' } }); tree = content(data, props);
  assert.match(html(tree), /Approved leads to schedule \(1\)/);
  assert.ok(button(tree, 'Schedule first follow-up for Project first'));
  assert.equal(button(tree, 'Schedule first follow-up for Project second'), undefined);
  data.user.role = 'OPERATIONS'; assert.match(html(content(data, props)), /Approved leads to schedule/);
  assert.equal(button(content(data, { ...props, busy: true }), 'Schedule first follow-up for Project first').props.disabled, true);
  data.user.role = 'ACCOUNTANT'; assert.doesNotMatch(html(content(data, props)), /Approved leads to schedule|Schedule first follow-up/);
});
