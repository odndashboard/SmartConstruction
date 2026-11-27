import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DashboardRefreshError, mergeDashboardWorkspace, mergeWorkspaceUpdate, readDashboardSnapshot } from '../lib/dashboard-refresh.ts';
import { DEFAULT_COMPANY } from '../lib/types.ts';
import type { Member, WorkspaceData } from '../lib/types';
import type { OperationsData } from '../lib/operations-types';

const owner: Member = { userId: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'OWNER', active: true };
function workspace(user = owner, revision = 1): WorkspaceData {
  return { revision, company: { ...DEFAULT_COMPANY }, user: { ...user }, members: [{ ...user }],
    customers: [], leads: [], followups: [], quotations: [], workorders: [], activity: [], sequences: {} };
}
function operations(user = owner): OperationsData {
  return { revision: 1, month: '2026-11', today: '2026-11-24', serverTime: '2026-11-24T04:30:00Z', user: { ...user },
    permissions: { admin: user.role === 'OWNER', canWrite: user.role !== 'DEALER' }, stockItems: [], stockMovements: [], attendance: [],
    myTodayAttendance: null, myOpenAttendance: null, expenses: [], expenseSummary: null,
    counts: { stockMovements: 0, attendance: 0, expenses: 0 }, historyLimit: 500,
    extension: { sites: [], assignments: [], shiftRule: { configured: false, startLocal: null, endLocal: null, overnight: false, breakMinutes: 0, graceMinutes: 0, version: 0 },
      attendanceCalendar: [], attendanceSummary: [], siteBalances: [], transfers: [], returns: [], materialRequests: [], expenseReceipts: [],
      purchaseOrders: null, paymentAccounts: null, paymentInstallments: null, customerPayments: null } };
}
function status(code: number) {
  return (error: unknown) => error instanceof DashboardRefreshError && error.status === code;
}

test('one dashboard request refreshes both datasets with authenticated no-store transport', async t => {
  const expected = { workspace: workspace(), operations: operations(), operationsError: '' };
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/dashboard');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    return Response.json(expected);
  });
  assert.deepEqual(await readDashboardSnapshot(owner), expected);
  assert.equal(request.mock.callCount(), 1, 'no additional workspace or operations request is made');
});

test('an optional operations failure still returns the freshly verified workspace and its retry message', async t => {
  const expected = { workspace: workspace(), operations: null, operationsError: 'Operations are temporarily unavailable.' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(expected));
  assert.deepEqual(await readDashboardSnapshot(owner), expected);
});

test('auth denial is returned immediately even if the response body stalls', async t => {
  let code = 401;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream(), { status: code }));
  for (const denied of [401, 403]) {
    code = denied;
    await assert.rejects(readDashboardSnapshot(owner), status(denied));
  }
});

test('temporary server failure stays distinguishable from revoked access', async t => {
  let body: unknown = { error: 'The sign-in service is temporarily unavailable.' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status: 503 }));
  await assert.rejects(readDashboardSnapshot(owner), error => status(503)(error)
    && (error as Error).message === 'The sign-in service is temporarily unavailable.');
  body = null;
  await assert.rejects(readDashboardSnapshot(owner), status(503));
});

test('changed identity, role or active membership never enters the existing dashboard', async t => {
  let user = { ...owner };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ workspace: workspace(user), operations: operations(user), operationsError: '' }));
  for (const changed of [{ ...owner, userId: 'other' }, { ...owner, role: 'MANAGER' as const }, { ...owner, active: false }]) {
    user = changed;
    await assert.rejects(readDashboardSnapshot(owner), status(403));
  }
});

test('mixed operations identity, role and admin scope fail closed', async t => {
  let details = operations();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ workspace: workspace(), operations: details, operationsError: '' }));
  for (const invalid of [operations({ ...owner, userId: 'other' }), operations({ ...owner, role: 'MANAGER' }),
    operations({ ...owner, active: false }), { ...operations(), permissions: { admin: false, canWrite: true } }]) {
    details = invalid;
    await assert.rejects(readDashboardSnapshot(owner), status(403));
  }
});

test('an incomplete successful response produces a retryable failure, not a blank workspace', async t => {
  let body: unknown = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (const invalid of [null, {}, { workspace: workspace() }, { workspace: { ...workspace(), revision: -1 }, operations: null },
    { workspace: workspace(), operations: { ...operations(), extension: undefined } }]) {
    body = invalid;
    await assert.rejects(readDashboardSnapshot(owner), status(503));
  }
});

test('late refreshes preserve newer edits and cannot resurrect cleared or changed access', () => {
  const newer = workspace(owner, 12), older = workspace(owner, 11), latest = workspace(owner, 13);
  assert.equal(mergeDashboardWorkspace(newer, older), newer);
  assert.equal(mergeDashboardWorkspace(newer, latest), latest);
  assert.equal(mergeDashboardWorkspace(null, latest), null);
  assert.equal(mergeDashboardWorkspace(newer, workspace({ ...owner, userId: 'other' }, 13)), null);
  assert.equal(mergeDashboardWorkspace(newer, workspace({ ...owner, active: false }, 13)), null);
  const manager = workspace({ ...owner, role: 'MANAGER' }, 13);
  assert.equal(mergeDashboardWorkspace(manager, older), manager, 'an older Owner response cannot restore Owner access');
  assert.equal(mergeDashboardWorkspace(manager, workspace(owner, 13)), null, 'conflicting role snapshots are not mixed');
});

test('a confirmed write arriving after access was cleared cannot restore private workspace data', async () => {
  let current: WorkspaceData | null = workspace(owner, 12);
  let complete!: (snapshot: WorkspaceData) => void;
  const response = new Promise<WorkspaceData>(resolve => { complete = resolve; });
  const apply = response.then(snapshot => { current = mergeWorkspaceUpdate(current, snapshot); });
  current = null; // An independent read reported revoked membership while POST was in flight.
  complete(workspace(owner, 13));
  await apply;
  assert.equal(current, null);
});

test('team and mutation snapshots preserve changed identities, current roles and newer revisions', () => {
  const current = workspace(owner, 12), saved = workspace(owner, 13);
  assert.equal(mergeWorkspaceUpdate(current, saved), saved, 'a legitimate fresh mutation remains visible');
  assert.equal(mergeWorkspaceUpdate(current, workspace(owner, 11)), current);
  const manager = workspace({ ...owner, role: 'MANAGER' }, 13);
  assert.equal(mergeWorkspaceUpdate(manager, workspace(owner, 14)), manager, 'a late Owner response cannot restore elevated data');
  const other = workspace({ ...owner, userId: 'other' }, 12);
  assert.equal(mergeWorkspaceUpdate(other, saved), other);
  assert.equal(mergeWorkspaceUpdate(current, workspace({ ...owner, active: false }, 13)), current);
});
