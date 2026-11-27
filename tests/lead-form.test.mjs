import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Compile the real form and lead views in isolation from dashboard network effects.
// The field components remain real; unrelated icons and formatting are simple stand-ins.
const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['LeadForm', 'SimpleForm', 'Field', 'MemberOptions', 'assigneeValue', 'expectedKwInputValue', 'LeadTable', 'LeadBoard', 'LeadDetail', 'DetailField'];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing component ${name}`);
  return node.getText(ast);
}).join('\n');
const wrapper = ({ children }) => React.createElement('span', null, children);
const blank = () => null;
const helpers = {
  FormFooter: blank, StateOptions: blank, Badge: wrapper, DemoTag: blank, IconButton: wrapper,
  Avatar: blank, Notes: wrapper, FollowupRow: blank,
  Plus: blank, MoreHorizontal: blank, MapPin: blank, RefreshCw: blank, CalendarDays: blank,
  ArrowUpRight: blank, Pencil: blank, CircleAlert: blank, FileText: blank, ChevronRight: blank,
  ownerName: () => 'Sales colleague', formatINR: value => String(value), stateLabel: value => value,
  leadLabel: value => value, displayDate: value => value,
  LEAD_STAGES: [{ value: 'NEW', label: 'New' }],
};
const compiled = ts.transpileModule(`${declarations}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const components = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), components, ...Object.values(helpers));

const member = { userId: 'sales-test', name: 'Sales colleague', active: true };
const data = { user: member, members: [member], customers: [], quotations: [], followups: [] };
const baseLead = {
  id: 'lead-test', customerId: 'customer-existing', title: 'Solar installation', status: 'NEW',
  priority: 'Medium', value: 0, owner: member.userId, contact: 'Existing contact', phone: '1234567890',
  email: 'historical@example.test', createdAt: '2026-11-27', stateCode: '', location: '', source: 'Referral',
};
function form(lead, mutate = async () => undefined) {
  return components.LeadForm({ lead, data, busy: false, close() {}, mutate, manageLeadStatus: false });
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
