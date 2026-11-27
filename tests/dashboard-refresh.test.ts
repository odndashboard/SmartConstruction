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

test('unchanged refresh reuses the same verified workspace and takes fresh operations, including a selected job', async t => {
  const known = workspace(owner, 42);
  const latest = operations();
  latest.extension.jobMaterialEntries = [];
  const mock = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/dashboard?job=work-1&sinceRevision=42');
    return Response.json({ workspace: { unchanged: true, revision: 42, user: owner }, operations: latest, operationsError: '' });
  });
  const next = await readDashboardSnapshot(owner, { knownWorkspace: known, jobId: 'work-1' });
  assert.equal(next.workspace, known);
  assert.deepEqual(next.operations, latest);
  assert.equal(mock.mock.callCount(), 1);
});

test('full snapshots replace stale revisions and are accepted from older servers', async t => {
  const latest = workspace(owner, 8);
  const known = workspace(owner, 7);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ workspace: latest, operations: null, operationsError: 'Retry operations' }));
  const result = await readDashboardSnapshot(owner, { knownWorkspace: known });
  assert.deepEqual(result.workspace, latest);
  assert.equal(result.operationsError, 'Retry operations');
});

test('a same-revision profile change reads one full workspace with the latest user and roster ordering', async t => {
  const known = workspace(owner, 42);
  const colleague = { ...owner, userId: 'colleague', name: 'Middle name' };
  known.members.push(colleague);
  for (const profile of [{ ...owner, name: 'Z updated name' }, { ...owner, email: 'updated@example.invalid' }]) {
    const updated = workspace(profile, 42);
    updated.members = [colleague, profile];
    const latest = operations(profile); latest.revision = 7; latest.extension.jobMaterialEntries = [];
    const calls: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url: string) => {
      calls.push(url);
      return Response.json(calls.length === 1
        ? { workspace: { unchanged: true, revision: 42, user: profile }, operations: null }
        : { workspace: updated, operations: latest, operationsError: '' });
    });
    const next = await readDashboardSnapshot(owner, { knownWorkspace: known, jobId: 'work-1' });
    assert.deepEqual(calls, ['/api/dashboard?job=work-1&sinceRevision=42', '/api/dashboard?job=work-1']);
    assert.deepEqual(next.workspace, updated); assert.notEqual(next.workspace, known);
    assert.deepEqual(next.operations, latest); assert.deepEqual(known.user, owner);
    assert.deepEqual(known.members.map(member => member.userId), ['owner', 'colleague']);
    mock.mock.restore();
  }
});

test('profile fallback rejects denial, changed identity and another unexpected compact response without further retries', async t => {
  const known = workspace(owner, 42), profile = { ...owner, name: 'Updated owner' };
  const compact = { workspace: { unchanged: true, revision: 42, user: profile }, operations: null };
  for (const denied of [401, 403, 'identity', 'compact'] as const) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async (url: string) => {
      calls++;
      if (calls === 1) return Response.json(compact);
      assert.equal(url, '/api/dashboard');
      if (typeof denied === 'number') return new Response(new ReadableStream(), { status: denied });
      return Response.json(denied === 'compact' ? compact
        : { workspace: workspace({ ...profile, userId: 'other-user' }, 42), operations: null });
    });
    await assert.rejects(readDashboardSnapshot(owner, { knownWorkspace: known }), status(denied === 'compact' ? 503 : denied === 'identity' ? 403 : denied));
    assert.equal(calls, 2);
    mock.mock.restore();
  }
});

test('the original cancellation signal still cancels the one full profile fallback', async t => {
  const known = workspace(owner, 42), controller = new AbortController();
  let started!: () => void;
  const fallbackStarted = new Promise<void>(resolve => { started = resolve; });
  let calls = 0, fallbackSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    calls++;
    if (calls === 1) return Response.json({ workspace: { unchanged: true, revision: 42, user: { ...owner, name: 'Updated owner' } }, operations: null });
    fallbackSignal = init?.signal ?? undefined;
    started();
    return new Promise<Response>(() => {});
  });
  const pending = readDashboardSnapshot(owner, { knownWorkspace: known, signal: controller.signal });
  await fallbackStarted;
  controller.abort(new DOMException('Cancelled profile refresh.', 'AbortError'));
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(calls, 2); assert.equal(fallbackSignal?.aborted, true);
});

test('a compact response is rebound only to the exact requested revision, user and role', async t => {
  const known = workspace(owner, 3);
  let returned = { unchanged: true, user: owner, revision: 3 };
  let requested = '';
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested = url;
    return Response.json({ workspace: returned, operations: null });
  });
  await assert.rejects(readDashboardSnapshot(owner), status(503));
  for (const invalid of [workspace({ ...owner, userId: 'previous' }, 3), workspace({ ...owner, role: 'SALES' }, 3),
    workspace({ ...owner, active: false }, 3)]) {
    await assert.rejects(readDashboardSnapshot(owner, { knownWorkspace: invalid }), status(503));
    assert.equal(requested, '/api/dashboard');
  }
  returned = { ...returned, revision: 4 };
  await assert.rejects(readDashboardSnapshot(owner, { knownWorkspace: known }), status(503));
  returned = { ...returned, revision: 3, user: { ...owner, role: 'ACCOUNTANT' } };
  await assert.rejects(readDashboardSnapshot(owner, { knownWorkspace: known }), status(403));
  returned = { ...returned, user: { ...owner, active: false } };
  await assert.rejects(readDashboardSnapshot(owner, { knownWorkspace: known }), status(403));
});
