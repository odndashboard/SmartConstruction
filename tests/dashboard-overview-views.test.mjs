import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { buildDashboardOverview } from '../lib/dashboard-overview.ts';

// The real component with the same controlled hook harness as the other view
// tests. Memo dependencies use React's Object.is comparison across renders.
const source = readFileSync(new URL('../components/DashboardOverview.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('DashboardOverview.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
let slots = [], cursor = 0, calls = [], updateRead;
function useState(initial) {
  const index = cursor++;
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
  const update = value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; };
  if (slots[index] && typeof slots[index] === 'object' && 'loading' in slots[index]) updateRead = update;
  return [slots[index], update];
}
function useMemo(create, dependencies) {
  const index = cursor++, previous = slots[index];
  if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
    slots[index] = { dependencies, value: create() };
  }
  return slots[index].value;
}
const blank = () => null;
const helpers = {
  useState, useMemo, useRef: value => useState({ current: value })[0], useCallback: value => value, useEffect() {},
  buildDashboardOverview(...args) { const summary = buildDashboardOverview(...args); calls.push({ args, summary }); return summary; },
  ReadTimeoutError: class extends Error {}, DashboardRefreshError: class extends Error {},
  readDashboardSnapshot: async () => { throw new Error('Unexpected network request in render.'); },
  styles: new Proxy({}, { get: (_, name) => name }),
  ArrowUpRight: blank, Building2: blank, CalendarCheck2: blank, CalendarClock: blank, CheckCircle2: blank, ChevronRight: blank,
  CircleAlert: blank, FileText: blank, HardHat: blank, IndianRupee: blank, MapPin: blank, Package: blank,
  ReceiptText: blank, RefreshCw: blank, ShieldCheck: blank, ShoppingCart: blank, Truck: blank, UsersRound: blank,
};
const compiled = ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const views = {};
new Function('require', 'exports', ...Object.keys(helpers), compiled)(createRequire(import.meta.url), views, ...Object.values(helpers));
const stamp = '2026-11-24T04:30:00.000Z';
function fixture(serverTime = stamp) {
  const user = { userId: 'owner', name: 'Owner', role: 'OWNER', active: true };
  const workspace = { user, members: [user], customers: [], leads: [], quotations: [], followups: [], workorders: [] };
  const operations = { user, serverTime, month: '2026-11', today: '2026-11-24', permissions: { admin: true }, expenses: [],
    stockItems: [], myTodayAttendance: null, myOpenAttendance: null, expenseSummary: null, counts: { stockMovements: 0, expenses: 0 },
    extension: { sites: [], assignments: [], attendanceCalendar: [], attendanceSummary: [], shiftRule: { configured: false },
      materialRequests: [], purchaseOrders: null, paymentAccounts: null, transfers: [], returns: [] } };
  return { workspace, operations };
}
function props(data, operations = data.operations) {
  return { workspace: data.workspace, navigate() {}, onWorkspaceRefreshed() {}, onRefreshError() {},
    initialOverview: { identity: 'owner:OWNER:true', data: operations, error: '' } };
}
function render(value) { cursor = 0; return views.default(value); }
function reset() { slots = []; calls = []; updateRead = undefined; }

test('unchanged dashboard snapshots aggregate once across parent, loading and error renders', () => {
  reset(); const data = fixture(), input = props(data);
  const initial = renderToStaticMarkup(render(input));
  assert.equal(calls.length, 1); assert.equal(calls[0].summary.asOf, stamp);
  assert.equal(renderToStaticMarkup(render({ ...input, navigate() {} })), initial);
  updateRead(current => ({ ...current, loading: true }));
  assert.equal(render(input).props['aria-busy'], true);
  updateRead(current => ({ ...current, loading: false, error: 'Temporary refresh issue' }));
  assert.match(renderToStaticMarkup(render(input)), /Temporary refresh issue/);
  assert.equal(calls.length, 1);
});

test('workspace or operations replacement recomputes totals and changed identity discards cached private summaries', () => {
  reset(); const data = fixture(), input = props(data); render(input);
  const updated = { ...input, workspace: { ...data.workspace, leads: [{ status: 'NEW', value: 12345 }] } };
  render(updated); assert.equal(calls.length, 2); assert.equal(calls.at(-1).summary.core.pipelinePaise, '12345');
  updateRead(current => ({ ...current, data: { ...current.data, serverTime: '2026-11-24T05:00:00.000Z' } }));
  render(updated); assert.equal(calls.length, 3); assert.equal(calls.at(-1).summary.asOf, '2026-11-24T05:00:00.000Z');
  const changedIdentity = { ...updated, workspace: { ...updated.workspace, user: { ...updated.workspace.user, role: 'OPERATIONS' } } };
  const html = renderToStaticMarkup(render(changedIdentity));
  assert.equal(calls.length, 4); assert.equal(calls.at(-1).args[1], null); assert.equal(calls.at(-1).summary.operations, null);
  assert.doesNotMatch(html, /Company totals and team attendance|Agreed outstanding/);
});

test('absent or invalid snapshot times keep the live clock and do not aggregate twice in one render', t => {
  for (const value of [null, 'invalid-server-time']) {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T18:29:59.000Z') });
    reset(); const data = fixture(value), input = props(data, value === null ? null : data.operations);
    render(input); const first = calls[0]; t.mock.timers.tick(1000); render(input);
    assert.equal(calls.length, 2); assert.equal(first.args.length, 2); assert.equal(calls[1].args.length, 2);
    assert.equal(first.summary.operations, null); assert.equal(calls[1].summary.operations, null);
    assert.equal(first.summary.today, '2026-11-30'); assert.equal(calls[1].summary.today, '2026-12-01');
    assert.equal(calls[1].summary.asOf, '2026-11-30T18:30:00.000Z');
    t.mock.timers.reset();
  }
});
