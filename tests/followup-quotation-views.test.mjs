import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { followupQuotationPayload, getFollowupQuotationContext, savedHandoffQuotation } from '../lib/followup-quotation.ts';
import { effectiveQuoteStatus } from '../lib/quotation-status.ts';
import { getMissingQuoteCategories, REQUIRED_QUOTE_CATEGORIES } from '../lib/quotation-categories.ts';

const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['FollowupQuotationForm', 'FollowupForm', 'modalAfterClose', 'withFollowupContext', 'saveQuotationHandoff', 'QuoteStatusForm', 'quoteStatusAction'];
const code = names.map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast)).join('\n');
let values = [], cursor = 0;
function useState(initial) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; }
const blank = () => null, wrapper = ({ children }) => React.createElement('div', null, children);
const helpers = { useState, getFollowupQuotationContext, followupQuotationPayload, effectiveQuoteStatus, savedHandoffQuotation,
  Field: wrapper, SimpleForm: wrapper, MemberOptions: blank, FileText: blank, Badge: wrapper,
  Building2: blank, CalendarDays: blank, RefreshCw: blank, ArrowRight: blank, FormFooter: wrapper,
  customerForLead: () => ({ address: 'Actual billing address' }), getMissingQuoteCategories,
  displayDate: value => value, todayIST: () => '2026-11-27',
  QUOTE_LABELS: { DRAFT: 'Draft', ISSUED: 'Awaiting approval', ACCEPTED: 'Accepted', DECLINED: 'Declined', EXPIRED: 'Expired', SUPERSEDED: 'Superseded' },
  assigneeValue: (_data, value) => value, localInput: value => value || '',
};
const compiled = ts.transpileModule(`${code}\nexport { ${names.join(',')} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const task = { id: 'task', leadId: 'lead', title: 'Discuss proposal', dueAt: '2026-11-27T06:00:00Z', channel: 'Call', owner: 'sales', notes: 'Original preparation', status: 'OPEN', isDemo: false };
const quotation = { id: 'quote', leadId: 'lead', title: 'Actual scope', number: null, status: 'DRAFT', isDemo: false, siteAddress: 'Actual site', createdAt: '2026-11-27', validUntil: '2099-12-31', items: REQUIRED_QUOTE_CATEGORIES.map(category => ({ category })) };
function data(quotations = [quotation], role = 'OWNER') { return { user: { userId: 'user', role }, company: { legalName: 'Actual company', address: 'Actual registered address' }, members: [], leads: [{ id: 'lead', title: 'Roof project', status: 'NEW', isDemo: false }], followups: [task], quotations, workorders: [] }; }
function reset() { values = []; }
function render(name, props) { cursor = 0; return views[name](props); }
function elements(element) { return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(elements)] : []; }
function field(tree, label) { return elements(tree).find(element => element.props['aria-label'] === label || element.props.name === label); }
function button(tree, text) { return elements(tree).find(element => element.type === 'button' && React.Children.toArray(element.props.children).includes(text)); }
function props(extra = {}) { return { item: task, data: data(), busy: false, close() {}, mutate: async () => undefined, open() {}, ...extra }; }
function answer(input, choice) { let tree = render('FollowupQuotationForm', input); field(tree, 'Quotation given?').props.onChange({ target: { value: choice } }); return render('FollowupQuotationForm', input); }

test('Yes opens the exact linked quotation without guessing a newer scope or changing status', async () => {
  reset(); const opened = [], saved = [];
  const input = props({ item: { ...task, quoteId: 'issued' }, data: data([{ ...quotation, id: 'issued', status: 'ISSUED', number: 'Q/1' }, { ...quotation, id: 'newer' }]),
    open: value => opened.push(value), mutate: async (...args) => { saved.push(args); return data(); } });
  const tree = answer(input, 'given');
  assert.equal(field(tree, 'Quotation').props.value, 'issued');
  await button(tree, 'Open quotation').props.onClick();
  assert.deepEqual(opened, [{ type: 'quote_detail', id: 'issued', leadId: 'lead', followupId: 'task' }]); assert.deepEqual(saved, []);
});

test('multiple unlinked quotations require an intentional choice and preserve the task when saving its link', async () => {
  reset(); const saved = [], opened = [];
  const input = props({ data: data([quotation, { ...quotation, id: 'other', status: 'ISSUED' }]), open: value => opened.push(value),
    mutate: async (...args) => { saved.push(args); return data(); } });
  let tree = answer(input, 'given');
  assert.equal(field(tree, 'Quotation').props.value, ''); assert.equal(button(tree, 'Open quotation').props.disabled, true);
  field(tree, 'Quotation').props.onChange({ target: { value: 'other' } }); tree = render('FollowupQuotationForm', input);
  button(tree, 'Open quotation').props.onClick(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(saved, [['followup_save', followupQuotationPayload(task, 'other'), false]]);
  assert.equal(opened[0].id, 'other');
  assert.match(renderToStaticMarkup(tree), /Awaiting approval/);
});

test('No prepares an actual quotation for the same lead and carries a return destination without saving dummy records', () => {
  reset(); const opened = [], saved = [];
  const input = props({ item: undefined, leadId: 'lead', data: data([]), open: value => opened.push(value), mutate: async (...args) => { saved.push(args); } });
  const tree = answer(input, 'prepare'); button(tree, 'Create quotation').props.onClick();
  assert.deepEqual(opened, [{ type: 'quote', leadId: 'lead', followupLeadId: 'lead' }]); assert.deepEqual(saved, []);
  assert.deepEqual(views.modalAfterClose({ type: 'quote', leadId: 'lead', followupLeadId: 'lead' }), { type: 'followup', id: undefined, leadId: 'lead' });
});

test('the guided sequence saves a real draft, issues it, then returns to save the same follow-up with that exact quotation', async () => {
  reset(); const saved = [], opened = [], modal = { type: 'quote', leadId: 'lead', followupId: task.id };
  const mutate = async (action, payload, close) => { saved.push([action, payload, close]); return data([{ ...quotation, status: action === 'quote_issue' ? 'ISSUED' : 'DRAFT' }]); };
  await views.saveQuotationHandoff(data([]), modal, 'quote_save', { leadId: 'lead', title: quotation.title }, mutate, value => opened.push(value));
  assert.deepEqual(saved.map(row => row[0]), ['quote_save']);
  assert.deepEqual(opened[0], { type: 'quote_detail', id: quotation.id, followupId: task.id });
  reset(); const statusProps = { quote: quotation, data: data(), busy: false, close() {}, mutate,
    open: value => opened.push(views.withFollowupContext(opened[0], value)) };
  let statusForm = render('QuoteStatusForm', statusProps);
  field(statusForm, 'status').props.onChange({ target: { value: 'ISSUED' } }); statusForm = render('QuoteStatusForm', statusProps);
  await statusForm.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(saved.map(row => row[0]), ['quote_save', 'quote_issue']);
  const target = views.modalAfterClose(opened.at(-1));
  assert.deepEqual(target, { type: 'followup', id: task.id, leadId: undefined, quoteId: quotation.id });
  reset(); const tree = render('FollowupForm', props({ quoteId: target.quoteId, data: data([{ ...quotation, status: 'ISSUED' }]), mutate }));
  assert.equal(field(tree, 'leadId').props.disabled, true); assert.equal(field(tree, 'quoteId').props.value, quotation.id);
  assert.equal(tree.props.submit, 'Save quotation follow-up');
  await tree.props.onSubmit({ title: task.title, dueAt: '2026-11-27T11:30', channel: 'Call', owner: 'sales', notes: task.notes });
  assert.deepEqual(saved.map(row => row[0]), ['quote_save', 'quote_issue', 'followup_save']);
  assert.equal(saved[2][1].id, task.id); assert.equal(saved[2][1].quoteId, quotation.id); assert.equal(saved[2][1].notes, task.notes);
  assert.equal(opened.length, 2, 'saving the follow-up finishes instead of reopening review');
});

test('failed linking stays in place; Operations can view the actual quotation but cannot create or issue one', async () => {
  reset(); const opened = [], input = props({ data: data([{ ...quotation, status: 'ISSUED' }]), open: value => opened.push(value) });
  const tree = answer(input, 'given'); button(tree, 'Open quotation').props.onClick(); await Promise.resolve(); await Promise.resolve(); assert.deepEqual(opened, []);
  reset(); const operations = props({ item: { ...task, quoteId: quotation.id }, data: data([quotation], 'OPERATIONS') });
  const restricted = answer(operations, 'prepare');
  assert.equal(button(restricted, 'Create quotation'), undefined); assert.equal(button(restricted, 'Continue draft quotation'), undefined);
  assert.ok(button(restricted, 'Open quotation')); assert.match(renderToStaticMarkup(restricted), /Admin and Manager issue/);
});

test('quotation edit, status and billing navigation retains exact follow-up return context', () => {
  const current = { type: 'quote_detail', id: 'quote', followupId: 'task' };
  const billing = views.withFollowupContext(current, { type: 'customer', id: 'customer', quoteStatusId: 'quote' });
  assert.deepEqual(views.modalAfterClose(billing), { type: 'quote_status', id: 'quote', followupId: 'task' });
  assert.deepEqual(views.modalAfterClose(current), { type: 'followup', id: 'task', leadId: undefined, quoteId: 'quote' });
  assert.deepEqual(views.withFollowupContext(current, { type: 'quote', id: 'revision' }), { type: 'quote', id: 'revision', followupId: 'task' });
  assert.deepEqual(views.withFollowupContext(current, { type: 'work_detail', id: 'work' }), { type: 'work_detail', id: 'work' });
});

test('lead-only return reuses an exact acceptance reminder from the latest workspace and offers multiple tasks explicitly', () => {
  const modal = { type: 'quote_detail', id: quotation.id, followupLeadId: 'lead' };
  const reminder = { ...task, id: 'approval-reminder', quoteId: quotation.id };
  const latest = { ...data([{ ...quotation, status: 'ACCEPTED' }]), followups: [task, reminder] };
  assert.deepEqual(views.modalAfterClose(modal, latest), { type: 'followup', id: reminder.id, quoteId: quotation.id });
  latest.followups.push({ ...reminder, id: 'another-exact' });
  assert.deepEqual(views.modalAfterClose(modal, latest), { type: 'followup_choose', leadId: 'lead', quoteId: quotation.id });
  latest.followups = [task, { ...reminder, status: 'DONE' }, { ...reminder, id: 'different-lead', leadId: 'other' }, { ...reminder, id: 'example', isDemo: true }];
  assert.deepEqual(views.modalAfterClose(modal, latest), { type: 'followup', id: undefined, leadId: 'lead', quoteId: quotation.id });
});

test('an original generic task returns untouched when acceptance already created an exact quotation reminder', async () => {
  reset(); const reminder = { ...task, id: 'approval-reminder', quoteId: quotation.id };
  const latest = { ...data([{ ...quotation, status: 'ACCEPTED' }]), followups: [task, reminder] };
  const target = views.modalAfterClose({ type: 'quote_detail', id: quotation.id, followupId: task.id }, latest);
  assert.deepEqual(target, { type: 'followup', id: task.id, relatedQuoteId: quotation.id });
  const opened = [], saved = [];
  const tree = render('FollowupForm', props({ data: latest, relatedQuoteId: target.relatedQuoteId, open: value => opened.push(value), mutate: async (...args) => { saved.push(args); } }));
  assert.equal(field(tree, 'quoteId').props.value, '');
  button(tree, 'Open quotation follow-up').props.onClick();
  assert.deepEqual(opened, [{ type: 'followup', id: reminder.id, quoteId: quotation.id }]); assert.deepEqual(saved, []);
  reset(); const input = props({ data: latest, open: value => opened.push(value), mutate: async (...args) => { saved.push(args); } });
  const handoff = answer(input, 'given'); button(handoff, 'Open quotation').props.onClick(); await Promise.resolve();
  assert.deepEqual(saved, [], 'Yes never silently links the generic task a second time');
  assert.equal(opened.at(-1).followupId, task.id);
});

test('explicit closed follow-up returns to read-only history and a deliberate next task preserves the quotation', () => {
  reset(); const closed = { ...task, status: 'DONE', outcome: 'Customer approved actual scope', quoteId: quotation.id };
  const latest = { ...data(), followups: [closed] };
  const target = views.modalAfterClose({ type: 'quote_detail', id: quotation.id, followupId: closed.id }, latest);
  const opened = [], tree = render('FollowupForm', props({ item: closed, data: latest, quoteId: target.quoteId, open: value => opened.push(value) }));
  assert.equal(field(tree, 'title'), undefined); assert.equal(tree.props.onSubmit, undefined);
  assert.match(renderToStaticMarkup(tree), /completed.*history is kept/); assert.match(renderToStaticMarkup(tree), /Customer approved actual scope/);
  button(tree, 'Schedule another follow-up').props.onClick();
  assert.deepEqual(opened, [{ type: 'followup', leadId: task.leadId, quoteId: quotation.id }]);
});

test('continuing an unlinked draft never saves a follow-up before reviewing or issuing it', async () => {
  reset(); const saved = [], opened = [];
  const tree = answer(props({ mutate: async (...args) => { saved.push(args); return data(); }, open: value => opened.push(value) }), 'prepare');
  button(tree, 'Continue draft quotation').props.onClick(); await Promise.resolve();
  assert.deepEqual(saved, []); assert.deepEqual(opened, [{ type: 'quote', id: quotation.id, leadId: task.leadId, followupId: task.id }]);
});

test('read-only staff can inspect follow-up history but never receive a scheduling form from quotation return', () => {
  reset(); const input = props({ data: data([quotation], 'ACCOUNTANT'), open() {} });
  const existing = render('FollowupForm', input);
  assert.equal(field(existing, 'title'), undefined); assert.equal(button(existing, 'Schedule another follow-up'), undefined);
  reset(); const newTask = render('FollowupForm', { ...input, item: undefined, leadId: 'lead', quoteId: quotation.id });
  assert.equal(field(newTask, 'title'), undefined); assert.match(renderToStaticMarkup(newTask), /member schedules follow-ups/);
});
