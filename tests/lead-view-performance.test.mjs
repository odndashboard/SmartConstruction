import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { LEAD_STAGES } from '../lib/types.ts';

const source = readFileSync(new URL('../components/CRMApp.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('CRMApp.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ['ownerName', 'indexLeadCustomers', 'indexLeadOwners', 'useLeadViewLookup', 'groupLeadStages', 'Dashboard', 'LeadBoard', 'LeadTable'];
const declarations = names.map(name => {
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing ${name}`);
  return node.getText(ast);
}).join('\n');
const compiled = ts.transpileModule(`${declarations}\nexport { ${names.join(',')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const blank = () => null;
const helpers = {
  useMemo: React.useMemo, LEAD_STAGES,
  Badge: ({ children }) => React.createElement('span', null, children),
  DemoTag: ({ demo }) => demo ? 'Example' : null,
  Avatar: ({ name }) => React.createElement('span', { title: name }, name),
  IconButton: ({ label, onClick }) => React.createElement('button', { 'aria-label': label, onClick }),
  Plus: blank, MoreHorizontal: blank, MapPin: blank, RefreshCw: blank,
  Trash2: blank, CalendarDays: blank, ArrowUpRight: blank,
  DashboardOverview: blank, PanelHeader: ({ title, children }) => React.createElement('div', null, title, children),
  FollowupRow: blank, QuoteTable: blank, WorkCard: blank, Empty: blank,
  CalendarClock: blank, HardHat: blank, Building2: blank, effectiveQuoteStatus: quote => quote.status,
  formatINR: value => `INR ${value}`, stateLabel: code => code,
  leadLabel: status => status, displayDate: value => value,
};
function load(overrides = {}) {
  const bindings = { ...helpers, ...overrides };
  const result = {};
  new Function('require', 'exports', ...Object.keys(bindings), compiled)(createRequire(import.meta.url), result, ...Object.values(bindings));
  return result;
}
const views = load();
function workspace() {
  return {
    customers: [{ id: 'customer', name: 'First customer' }, { id: 'customer', name: 'Duplicate customer' }],
    members: [{ userId: 'member', name: 'Former colleague', active: false }, { userId: 'member', name: 'Duplicate colleague' }, { userId: '', name: 'Empty ID member' }],
    leads: [], followups: [{ owner: 'demo-follow', isDemo: true }], workorders: [{ owner: 'demo-work', isDemo: true }],
  };
}
function lead(id, status = 'NEW', changes = {}) {
  return { id, title: `Project ${id}`, status, customerId: 'customer', contact: 'Contact fallback', priority: 'Medium', value: 0, owner: 'member', createdAt: '2026-11-27', stateCode: '06', expectedKw: 0, ...changes };
}
function render(name, props) {
  return renderToStaticMarkup(React.createElement(views[name], { open() {}, commercial: false, manageLeadStatus: false, dashboard: false, ...props }));
}

test('indexed lead lookups preserve first matches, historical members and demo owner fallback', () => {
  const data = workspace();
  data.leads = [lead('demo', 'NEW', { owner: 'demo-lead', isDemo: true })];
  const customers = views.indexLeadCustomers(data.customers);
  const owners = views.indexLeadOwners(data.members, data.leads, data.followups, data.workorders);
  assert.equal(customers.get('customer'), data.customers[0]);
  assert.equal(customers.get('missing'), undefined);
  for (const id of ['member', '', 'demo-lead', 'demo-follow', 'demo-work', 'missing']) {
    assert.equal(owners.get(id) ?? 'Unassigned', views.ownerName(data, id));
  }
  const noEmptyMember = views.indexLeadOwners([], [{ owner: '', isDemo: true }], [], []);
  assert.equal(noEmptyMember.get('') ?? 'Unassigned', 'Unassigned');
});

test('lead table and board retain ordering, customer fallback, zero capacity and status permissions', () => {
  const data = workspace();
  data.leads = [lead('third', 'SITE_VISIT'), lead('first', 'NEW'), lead('second', 'NEW', { customerId: 'missing', owner: 'missing' }), lead('won', 'WON'), lead('lost', 'LOST')];
  const table = render('LeadTable', { data, leads: data.leads });
  assert.ok(table.indexOf('Project third') < table.indexOf('Project first'));
  assert.ok(table.indexOf('Project first') < table.indexOf('Project second'));
  assert.match(table, /First customer/);
  assert.doesNotMatch(table, /Duplicate customer|Duplicate colleague|Change status of/);
  assert.match(table, /Former colleague/);
  assert.match(table, /Unassigned/);
  assert.match(table, /0 kW/);
  const managerTable = render('LeadTable', { data, leads: data.leads, manageLeadStatus: true });
  assert.match(managerTable, /Change status of Project first/);
  assert.doesNotMatch(managerTable, /Change status of Project won/);
  const board = render('LeadBoard', { data, leads: data.leads, commercial: true, manageLeadStatus: true });
  assert.ok(board.indexOf('Project first') < board.indexOf('Project second'));
  assert.ok(board.indexOf('Project second') < board.indexOf('Project third'));
  assert.match(board, /Contact fallback/);
  assert.doesNotMatch(board, /Project won|Project lost/);
  assert.match(board, /Change status of Project second/);
  assert.match(board, /aria-label="Add lead"/);
  const hidden = render('LeadBoard', { data, leads: data.leads });
  assert.doesNotMatch(hidden, /Change status of|aria-label="Add lead"/);
});

test('dashboard preview keeps two cards per stage and counts every matching lead without mutating inputs', () => {
  const data = workspace();
  data.leads = Object.freeze([lead('a'), lead('b'), lead('c'), lead('d', 'CONTACTED')]);
  const html = render('LeadBoard', { data, leads: data.leads, dashboard: true });
  assert.match(html, /Project a/);
  assert.match(html, /Project b/);
  assert.match(html, /Project d/);
  assert.doesNotMatch(html, /Project c/);
  assert.match(html, /\+1 more opportunities/);
  assert.match(html, /stage-count">3/);
  assert.deepEqual(data.leads.map(row => row.id), ['a', 'b', 'c', 'd']);
});

test('actual initial dashboard pipeline offers a readable Delete lead action only to the active Owner', () => {
  const data = { ...workspace(), company: { legalName: 'Company', address: 'Office' }, quotations: [], followups: [], workorders: [],
    user: { role: 'OWNER', active: true, name: 'Admin' }, leads: [lead('roof')] };
  const props = { data, permissions: { owner: true, commercial: true, manageLeadStatus: true }, navigate() {}, busy: false };
  const markup = render('Dashboard', props);
  assert.match(markup, /Lead pipeline/);
  assert.match(markup, /aria-label="Delete Project roof"[^>]*>Delete lead<\/button>/);
  assert.match(markup, /lead-delete-action/);
  assert.doesNotMatch(render('Dashboard', { ...props, data: { ...data, user: { ...data.user, role: 'MANAGER' } } }), /Delete lead/);
  assert.doesNotMatch(render('Dashboard', { ...props, data: { ...data, user: { ...data.user, active: false } } }), /Delete lead/);
});

test('dashboard and advanced cards and first table cell open the existing confirmation for the exact lead', () => {
  const local = load({ useMemo: fn => fn() });
  const nodes = element => React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(nodes)] : [];
  const data = { ...workspace(), user: { role: 'OWNER', active: true }, leads: [lead('roof')] };
  for (const [name, dashboard] of [['LeadBoard', true], ['LeadBoard', false], ['LeadTable', false]]) {
    const opened = [];
    const props = { data, leads: data.leads, dashboard, manageLeadStatus: false, commercial: false, open: target => opened.push(target) };
    const tree = local[name](props);
    const remove = nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Delete Project roof');
    assert.ok(remove); assert.equal(React.Children.toArray(remove.props.children).at(-1), 'Delete lead');
    if (name === 'LeadTable') {
      const firstCell = nodes(tree).find(node => node.type === 'td');
      assert.ok(nodes(firstCell).some(node => node.props['aria-label'] === 'Delete Project roof'), 'Deletion is beside the project name, not beyond phone horizontal scrolling.');
    }
    assert.deepEqual(opened, []); remove.props.onClick();
    assert.deepEqual(opened, [{ type: 'lead_delete', id: 'roof' }]);
    const busy = nodes(local[name]({ ...props, busy: true })).find(node => node.type === 'button' && node.props['aria-label'] === 'Delete Project roof');
    assert.equal(busy.props.disabled, true);
    for (const role of ['MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER']) {
      assert.equal(nodes(local[name]({ ...props, data: { ...data, user: { role, active: true } } })).some(node => node.props['aria-label'] === 'Delete Project roof'), false);
    }
  }
});

test('memoized view data reuses unchanged arrays and refreshes edited customer, owner and stage data', () => {
  const slots = [];
  let cursor = 0;
  let calculations = 0;
  const local = load({ useMemo(calculate, deps) {
    const index = cursor++;
    const prior = slots[index];
    if (prior && deps.every((value, i) => Object.is(value, prior.deps[i]))) return prior.value;
    calculations++;
    const value = calculate();
    slots[index] = { deps, value };
    return value;
  } });
  let data = workspace();
  data.leads = [lead('first')];
  const draw = () => { cursor = 0; return local.LeadBoard({ data, leads: data.leads, open() {}, commercial: false, manageLeadStatus: false, dashboard: true }); };
  draw(); assert.equal(calculations, 3);
  data = { ...data, user: { role: 'MANAGER' } };
  draw(); assert.equal(calculations, 3, 'unrelated UI state/outer snapshot does not repeat lookups');
  data = { ...data, customers: [{ id: 'customer', name: 'Edited customer' }] };
  assert.match(renderToStaticMarkup(draw()), /Edited customer/);
  assert.equal(calculations, 4);
  data = { ...data, members: [{ userId: 'member', name: 'Edited owner' }] };
  assert.match(renderToStaticMarkup(draw()), /Edited owner/);
  assert.equal(calculations, 5);
  data = { ...data, leads: [lead('first', 'WON')] };
  assert.doesNotMatch(renderToStaticMarkup(draw()), /Project first/);
  assert.equal(calculations, 7);
  data = { ...data, customers: [], members: [], leads: [], followups: [], workorders: [] };
  assert.doesNotMatch(renderToStaticMarkup(draw()), /Edited customer|Edited owner|Project first/);
});

test('1000 lead fixture removes repeated full-array lookups and five separate board scans', t => {
  const counts = { customer: 0, member: 0, demo: 0, stage: 0 };
  const customers = Array.from({ length: 1000 }, (_, i) => ({ get id() { counts.customer++; return `customer-${i}`; }, name: `Customer ${i}` }));
  const members = Array.from({ length: 20 }, (_, i) => ({ get userId() { counts.member++; return `member-${i}`; }, name: `Member ${i}` }));
  const tracked = row => ({ ...row, get isDemo() { counts.demo++; return false; } });
  const leads = Array.from({ length: 1000 }, (_, i) => tracked({ id: `lead-${i}`, customerId: `customer-${i}`, owner: i % 4 ? `member-${i % 20}` : 'missing', get status() { counts.stage++; return LEAD_STAGES[i % 5].value; } }));
  // Keep status access observable after creating each tracked row.
  leads.forEach((row, i) => Object.defineProperty(row, 'status', { get() { counts.stage++; return LEAD_STAGES[i % 5].value; } }));
  const followups = Array.from({ length: 1000 }, () => tracked({ owner: 'missing' }));
  const workorders = Array.from({ length: 1000 }, () => tracked({ owner: 'missing' }));
  const data = { customers, members, leads, followups, workorders };
  Object.keys(counts).forEach(key => { counts[key] = 0; });
  const legacyRows = leads.map(row => [customers.find(customer => customer.id === row.customerId)?.name, views.ownerName(data, row.owner), views.ownerName(data, row.owner)]);
  const legacyGroups = LEAD_STAGES.slice(0, 5).map(stage => leads.filter(row => row.status === stage.value));
  const before = { ...counts };
  Object.keys(counts).forEach(key => { counts[key] = 0; });
  const byCustomer = views.indexLeadCustomers(customers);
  const byOwner = views.indexLeadOwners(members, leads, followups, workorders);
  const currentRows = leads.map(row => [byCustomer.get(row.customerId)?.name, byOwner.get(row.owner) ?? 'Unassigned', byOwner.get(row.owner) ?? 'Unassigned']);
  const groups = views.groupLeadStages(leads);
  const after = { ...counts };
  assert.deepEqual(currentRows, legacyRows);
  assert.deepEqual(LEAD_STAGES.slice(0, 5).map(stage => groups.get(stage.value)), legacyGroups);
  assert.deepEqual(before, { customer: 500500, member: 26500, demo: 1500000, stage: 5000 });
  assert.deepEqual(after, { customer: 1000, member: 20, demo: 3000, stage: 1000 });
  t.diagnostic(`Record-field reads for 1,000 visible leads: ${JSON.stringify(before)} -> ${JSON.stringify(after)}. Rendering and Map lookups remain linear.`);
});


test('advanced Leads offers Delete on both views only to an active owner', () => {
  const data = workspace();
  const leads = [lead('roof')];
  for (const [role, active, visible] of [['OWNER', true, true], ['OWNER', false, false], ['MANAGER', true, false], ['SALES', true, false]]) {
    data.user = { role, active };
    for (const view of ['LeadBoard', 'LeadTable']) {
      assert.equal(render(view, { data, leads }).includes('Delete Project roof'), visible);
    }
    assert.equal(render('LeadBoard', { data, leads, dashboard: true }).includes('Delete Project roof'), visible);
  }
});
