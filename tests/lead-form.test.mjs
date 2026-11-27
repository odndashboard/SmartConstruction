import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { leadDeletionBlockReason } from '../lib/lead-deletion.ts';

// Compile the real form and lead views in isolation from dashboard network effects.
// The field components remain real; unrelated icons and formatting are simple stand-ins.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['LeadDeleteConfirmation', 'QuickLeadForm', 'LeadForm', 'LeadStatusForm', 'SimpleForm', 'Field', 'MemberOptions', 'assigneeValue', 'expectedKwInputValue', 'workOrderLeadId', 'LeadTable', 'LeadBoard', 'LeadDetail', 'DetailField', 'indexLeadCustomers', 'indexLeadOwners', 'useLeadViewLookup', 'groupLeadStages'];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing component ${name}`);
  return node.getText(ast);
}).join('\n');
const wrapper = ({ children }) => React.createElement('span', null, children);
const blank = () => null;
const helpers = {
  useState: React.useState, useMemo: React.useMemo,
  FormFooter: blank, StateOptions: blank, Badge: wrapper, DemoTag: blank, IconButton: wrapper,
  leadDeletionBlockReason, Trash2: blank, Avatar: blank, Notes: wrapper, FollowupRow: blank,
  Plus: blank, MoreHorizontal: blank, MapPin: blank, RefreshCw: blank, CalendarDays: blank,
  ArrowUpRight: blank, Pencil: blank, CircleAlert: blank, FileText: blank, ChevronRight: blank,
  ownerName: () => 'Sales colleague', formatINR: value => String(value), stateLabel: value => value,
  leadLabel: value => value, displayDate: value => value,
  LEAD_STAGES: ['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'].map(value => ({ value, label: value === 'WON' ? 'Won' : value })),
};
const compiled = ts.transpileModule(`${declarations}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const components = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), components, ...Object.values(helpers));

const member = { userId: 'sales-test', name: 'Sales colleague', active: true };
const data = { user: member, members: [member], customers: [], leads: [], quotations: [], followups: [], workorders: [] };
const baseLead = {
  id: 'lead-test', customerId: 'customer-existing', title: 'Solar installation', status: 'NEW',
  priority: 'Medium', value: 0, owner: member.userId, contact: 'Existing contact', phone: '1234567890',
  email: 'historical@example.test', createdAt: '2026-11-27', stateCode: '', location: '', source: 'Referral', lostReason: '',
};
function form(lead, mutate = async () => undefined, manageLeadStatus = false) {
  return components.LeadForm({ lead, data, busy: false, close() {}, mutate, manageLeadStatus });
}
function fields(element) {
  if (!React.isValidElement(element)) return [];
  return [element, ...React.Children.toArray(element.props.children).flatMap(fields)];
}

test('Add Lead renders without customer selection or email and accepts optional decimal kW', () => {
  const tree = form();
  const html = renderToStaticMarkup(tree);
  assert.doesNotMatch(html, /name="(?:customerId|email)"|Select customer|Create customer|Add customer details/);
  const input = fields(tree).find(item => item.props.name === 'expectedKw');
  assert.ok(input);
  assert.equal(input.type, 'input');
  assert.equal(input.props.type, 'number');
  assert.equal(input.props.inputMode, 'decimal');
  assert.equal(input.props.min, '0');
  assert.equal(input.props.step, 'any');
  assert.equal(input.props.required, undefined);
  assert.equal(input.props.defaultValue, '');
});

test('lead form submits kW without replacing historical email or customer association', async () => {
  const submitted = [];
  const mutate = async (action, payload) => { submitted.push({ action, payload }); };
  await form(undefined, mutate).props.onSubmit({ title: 'New solar lead', contact: 'New contact', phone: '9876543210', expectedKw: '10.5' });
  await form({ ...baseLead, expectedKw: 0 }, mutate).props.onSubmit({ title: baseLead.title, expectedKw: '0' });
  assert.deepEqual(submitted, [
    { action: 'lead_save', payload: { title: 'New solar lead', contact: 'New contact', phone: '9876543210', expectedKw: '10.5', status: 'NEW' } },
    { action: 'lead_save', payload: { id: baseLead.id, title: baseLead.title, expectedKw: '0', status: 'NEW' } },
  ]);
  const input = fields(form({ ...baseLead, expectedKw: 0 })).find(item => item.props.name === 'expectedKw');
  assert.equal(input.props.defaultValue, '0');
});

test('saved tiny and large kW values remain plain decimals on unchanged edit', async () => {
  for (const expectedKw of [0, 0.00000001, 1.2345678901234567e-25, Number.MIN_VALUE, 1e21, 1.2345678901234568e30, Number.MAX_VALUE]) {
    const submitted = [];
    const tree = form({ ...baseLead, expectedKw }, async (action, payload) => { submitted.push({ action, payload }); });
    const input = fields(tree).find(item => item.props.name === 'expectedKw');
    const unchangedValue = input.props.defaultValue;
    assert.match(unchangedValue, /^(?:\d+\.?\d*|\.\d+)$/);
    assert.equal(Number(unchangedValue), expectedKw);
    await tree.props.onSubmit({ title: baseLead.title, expectedKw: unchangedValue });
    assert.equal(Number(submitted[0].payload.expectedKw), expectedKw);
  }
  const empty = fields(form({ ...baseLead, expectedKw: null })).find(item => item.props.name === 'expectedKw');
  assert.equal(empty.props.defaultValue, '');
  const submitted = [];
  await form({ ...baseLead, expectedKw: 10.5 }, async (_action, payload) => { submitted.push(payload); }).props.onSubmit({ title: baseLead.title, expectedKw: '' });
  assert.equal(submitted[0].expectedKw, '');
});

test('lead details and list show decimal and zero kW while retaining historical email', () => {
  for (const expectedKw of [0, 10.5]) {
    const lead = { ...baseLead, expectedKw };
    const detail = renderToStaticMarkup(React.createElement(components.LeadDetail, { lead, data, permissions: {}, open() {}, busy: false }));
    const table = renderToStaticMarkup(React.createElement(components.LeadTable, { data, leads: [lead], open() {}, manageLeadStatus: false }));
    const board = renderToStaticMarkup(React.createElement(components.LeadBoard, { data, leads: [lead], open() {}, manageLeadStatus: false, commercial: false, dashboard: false }));
    assert.ok(detail.includes(`${expectedKw} kW`));
    assert.ok(table.includes(`${expectedKw} kW`));
    assert.ok(board.includes(`Expected: ${expectedKw} kW`));
    assert.ok(detail.includes(baseLead.email));
  }
  const detail = renderToStaticMarkup(React.createElement(components.LeadDetail, { lead: baseLead, data, permissions: {}, open() {}, busy: false }));
  assert.ok(detail.includes('Not entered'));
});

test('Admin and Manager lead forms offer Won for new and open leads', async () => {
  for (const lead of [undefined, baseLead, { ...baseLead, status: 'NEGOTIATION' }]) {
    const submitted = [];
    const tree = form(lead, async (action, payload) => { submitted.push({ action, payload }); }, true);
    const status = fields(tree).find(item => item.props.name === 'status');
    assert.ok(status);
    assert.ok(fields(status).some(item => item.type === 'option' && item.props.value === 'WON'));
    await tree.props.onSubmit({ title: baseLead.title, status: 'WON' });
    assert.equal(submitted[0].action, 'lead_save');
    assert.equal(submitted[0].payload.status, 'WON');
  }
});

test('lead forms preserve role restrictions, terminal Won and Lost reopening', async () => {
  for (const lead of [undefined, baseLead]) {
    const submitted = [];
    const tree = form(lead, async (_action, payload) => { submitted.push(payload); });
    assert.equal(fields(tree).some(item => item.props.name === 'status'), false);
    await tree.props.onSubmit({ title: baseLead.title, status: 'WON' });
    assert.equal(submitted[0].status, 'NEW');
  }
  const won = form({ ...baseLead, status: 'WON' }, undefined, true);
  assert.equal(fields(won).some(item => item.props.name === 'status'), false);
  assert.doesNotMatch(renderToStaticMarkup(won), /recorded from quotation acceptance/);
  const lost = form({ ...baseLead, status: 'LOST', lostReason: 'Paused project' }, undefined, true);
  const status = fields(lost).find(item => item.props.name === 'status');
  assert.deepEqual(fields(status).filter(item => item.type === 'option').map(item => item.props.value), ['NEW', 'LOST']);
});

test('Change Status offers Won while preserving closed lead rules', () => {
  const render = lead => renderToStaticMarkup(React.createElement(components.LeadStatusForm, {
    lead, busy: false, close() {}, mutate: async () => undefined, open() {},
  }));
  assert.match(render(baseLead), /<option value="WON">Won<\/option>/);
  const lost = render({ ...baseLead, status: 'LOST', lostReason: 'Paused project' });
  assert.doesNotMatch(lost, /value="WON"/);
  assert.match(lost, /value="NEW"/);
  assert.match(lost, /value="LOST"/);
  const won = render({ ...baseLead, status: 'WON' });
  assert.doesNotMatch(won, /name="status"|linked to the accepted quotation/);
  assert.match(won, /Won leads cannot be reopened/);
});

test('Simple mode creates a lead with only its name required, using the signed-in staff member', async () => {
  const saved = [];
  const tree = components.QuickLeadForm({ owner: member.userId, busy: false, close() {}, mutate: async (action, payload) => saved.push({ action, payload }) });
  const inputs = fields(tree).filter(node => node.type === 'input');
  assert.deepEqual(inputs.map(node => node.props.name), ['title', 'contact', 'phone', 'expectedKw']);
  assert.deepEqual(inputs.filter(node => node.props.required).map(node => node.props.name), ['title']);
  await tree.props.onSubmit({ title: 'Rooftop', contact: '', phone: '', expectedKw: '2.75' });
  assert.deepEqual(saved, [{ action: 'lead_save', payload: { title: 'Rooftop', contact: '', phone: '', expectedKw: '2.75', owner: member.userId } }]);
});

test('Simple mode names approval and rejection while preserving the stored lead stages', () => {
  const html = renderToStaticMarkup(React.createElement(components.LeadStatusForm, {
    lead: baseLead, busy: false, close() {}, mutate: async () => undefined, open() {}, simple: true,
  }));
  assert.match(html, /value="WON">Approved \(Won\)/);
  assert.match(html, /value="LOST">Not approved \(Lost\)/);
  assert.match(html, /value="NEW"/);
});


test('deleting a standalone lead requires confirming its name and id', () => {
  const calls = [];
  const props = { lead: baseLead, data, busy: false, close: () => calls.push('close'), mutate: (...args) => calls.push(args) };
  const dialog = components.LeadDeleteConfirmation(props);
  assert.match(renderToStaticMarkup(dialog), /Solar installation/);
  const [keep, remove] = fields(dialog).filter(item => item.type === 'button');
  assert.deepEqual(calls, []);
  keep.props.onClick();
  assert.deepEqual(calls, ['close']);
  remove.props.onClick();
  assert.deepEqual(calls[1], ['lead_delete', { id: baseLead.id }]);
  assert.ok(fields(components.LeadDeleteConfirmation({ ...props, busy: true })).filter(item => item.type === 'button').every(item => item.props.disabled));
});

test('lead history, examples and stale selections do not offer deletion', () => {
  for (const [lead, related, reason] of [
    [baseLead, { followups: [{ leadId: baseLead.id, status: 'DONE' }] }, /follow-up/],
    [baseLead, { quotations: [{ leadId: baseLead.id, status: 'DRAFT' }] }, /quotation/],
    [baseLead, { workorders: [{ leadId: baseLead.id }] }, /work order/],
    [baseLead, { workorders: [{ snapshot: { leadId: baseLead.id } }] }, /work order/],
    [{ ...baseLead, status: 'WON' }, {}, /Won/],
    [{ ...baseLead, isDemo: true }, {}, /example/],
    [undefined, {}, /no longer in the list/],
  ]) {
    const dialog = components.LeadDeleteConfirmation({ lead, data: { ...data, ...related }, busy: false, close() {}, mutate: assert.fail });
    assert.match(renderToStaticMarkup(dialog), reason);
    assert.deepEqual(fields(dialog).filter(item => item.type === 'button').map(item => item.props.children), ['Close']);
  }
});
