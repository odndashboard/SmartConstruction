import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';

// Load the real bootstrap/Auth/RPC boundary with controlled network responses.
const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const nextServerUrl = pathToFileURL(require.resolve('next/server')).href;
const { NextRequest } = require('next/server');
const fixtureKey = Symbol.for('smart-construction.initial-workspace-test');
const fixtureSymbol = "Symbol.for('smart-construction.initial-workspace-test')";
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const fixtures = {
  'server-only': moduleUrl('export {};'),
  'next/headers': moduleUrl(`export async function cookies() { return globalThis[${fixtureSymbol}].cookies; }`),
  '@supabase/ssr': moduleUrl(`export function createServerClient(_url, _key, options) {
    return { auth: {
      async getUser() { const state=globalThis[${fixtureSymbol}]; state.authCalls++; state.authOptions.push(options);
        if (state.auth) return state.auth(options);
        return { data: { user: state.authUsers.length ? state.authUsers.shift() : state.user }, error: state.authError }; },
      async getClaims() { const state=globalThis[${fixtureSymbol}]; state.claimCalls++;
        if (state.renewCookie) options.cookies.setAll([{name:'sb-test-auth-token',value:'renewed-test-token',options:{httpOnly:true,path:'/'}}], {'Cache-Control':'public, max-age=3600'});
        return { data: { claims: { sub:'untrusted-claim-subject',role:'OWNER' } }, error: null }; }
    } };
  }`),
  '@supabase/supabase-js': moduleUrl(`export function createClient() {
    return { rpc(name,args) {
      const state=globalThis[${fixtureSymbol}]; let signal;
      const request={ abortSignal(value) { signal=value; return request; }, then(resolve,reject) {
        state.rpcCalls.push({name,args,signal});
        return Promise.resolve().then(() => state.rpc(name,args,signal)).then(resolve,reject);
      } }; return request;
    } };
  }`),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(fixtures, specifier)) return { url: fixtures[specifier], shortCircuit: true };
    if (specifier === 'next/server') return { url: nextServerUrl, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { getInitialWorkspace } = await import('../lib/initial-workspace.ts');
const { GET: dashboardGET } = await import('../app/api/dashboard/route.ts');
const { GET: workspaceGET } = await import('../app/api/workspace/route.ts');
const { GET: operationsGET } = await import('../app/api/operations/route.ts');
const { SERVER_READ_TIMEOUT_MS } = await import('../lib/server-read.ts');
const { mutateWorkspace } = await import('../lib/server.ts');
const { proxy } = await import('../proxy.ts');
const environment = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://crm-tests.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_test_key',
  SUPABASE_SECRET_KEY: 'example-test-server-key',
};
const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
const OWNER = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE = '00000000-0000-4000-8000-000000000002';
const member = id => ({ userId: id, name: id === OWNER ? 'Owner' : 'Employee', email: 'member@example.test', role: id === OWNER ? 'OWNER' : 'SALES', active: true });
const authUser = id => ({ id, email: 'member@example.test', email_confirmed_at: '2026-11-01T00:00:00Z', is_anonymous: false, user_metadata: {} });
function resultFor(name, args) {
  const user = member(args.p_actor_id);
  return { data: name === 'crm_workspace_read' ? { user, revision: 1 } : { user, permissions: { admin: user.role === 'OWNER', canWrite: true }, month: args.p_month, extension: {} }, error: null };
}
function reset() {
  const cookieWrites = [];
  const state = {
    user: authUser(OWNER), authUsers: [], authError: null, auth: null, authOptions: [], authCalls: 0, claimCalls: 0, rpcCalls: [], renewCookie: false,
    cookieWrites, cookies: { getAll: () => [], set(...args) { cookieWrites.push(args); } }, rpc: resultFor,
  };
  globalThis[fixtureKey] = state;
  return state;
}
beforeEach(reset);

test('current clients receive won-order advances while already-open previous clients can still read numeric contract balances', async () => {
  const state = reset();
  const accounts = [{ workOrderId: 'agreed', contractPaise: '10000' }, { workOrderId: 'pending', contractPaise: null }];
  const receipts = [{ workOrderId: 'agreed', amountPaise: 100 }, { workOrderId: 'pending', amountPaise: 200 }];
  state.rpc = (name, args) => {
    const response = resultFor(name, args);
    if (name === 'crm_operations_v2_read') response.data.extension = { paymentAccounts: accounts, customerPayments: receipts };
    return response;
  };
  for (const [path, handler] of [['dashboard', dashboardGET], ['operations', operationsGET]]) {
    for (const current of [false, true]) {
      const request = new Request(`https://crm.example.test/api/${path}`, { headers: current ? { 'X-CRM-Payment-Accounts': '2' } : {} });
      const result = await handler(request);
      assert.equal(result.status, 200);
      const body = await result.json();
      const { extension } = path === 'dashboard' ? body.operations : body;
      assert.deepEqual(extension.paymentAccounts, current ? accounts : [accounts[0]]);
      assert.deepEqual(extension.customerPayments, current ? receipts : [receipts[0]]);
    }
  }
});
after(() => {
  hooks.deregister(); delete globalThis[fixtureKey];
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('bootstrap verifies Auth once and begins both scoped reads before either finishes', async () => {
  const state = reset(), finish = new Map();
  state.rpc = (name, args) => new Promise(resolve => finish.set(name, () => resolve(resultFor(name, args))));
  const pending = getInitialWorkspace();
  await setImmediate();
  assert.equal(state.authCalls, 1);
  assert.deepEqual([...finish.keys()].sort(), ['crm_operations_v2_read', 'crm_workspace_read']);
  for (const call of state.rpcCalls) { assert.equal(call.args.p_actor_id, OWNER); assert.ok(call.signal instanceof AbortSignal); }
  finish.get('crm_operations_v2_read')(); finish.get('crm_workspace_read')();
  const result = await pending;
  assert.equal(result.workspace.user.userId, OWNER);
  assert.equal(result.operations.user.userId, OWNER);
  assert.equal(result.operationsError, '');
});

test('each bootstrap gets a fresh identity without leaking the preceding request data', async () => {
  const state = reset();
  state.authUsers = [authUser(OWNER), authUser(EMPLOYEE)];
  const [owner, employee] = await Promise.all([getInitialWorkspace(), getInitialWorkspace()]);
  assert.equal(state.authCalls, 2);
  assert.equal(owner.workspace.user.userId, OWNER);
  assert.equal(employee.workspace.user.userId, EMPLOYEE);
  assert.equal(owner.operations.permissions.admin, true);
  assert.equal(employee.operations.permissions.admin, false);
});

test('missing or unconfirmed Auth identities never start private database reads', async () => {
  for (const user of [null, { ...authUser(OWNER), email_confirmed_at: null }, { ...authUser(OWNER), is_anonymous: true }]) {
    const state = reset(); state.user = user;
    await assert.rejects(getInitialWorkspace(), error => [401, 403].includes(error.status));
    assert.equal(state.rpcCalls.length, 0);
  }
});

test('denial from either database source fails the bootstrap closed', async () => {
  for (const denied of ['crm_workspace_read', 'crm_operations_v2_read']) {
    const state = reset();
    state.rpc = (name, args) => name === denied ? { data: null, error: { code: 'PT403', message: 'Membership changed.' } } : resultFor(name, args);
    await assert.rejects(getInitialWorkspace(), error => error.status === 403);
  }
});

test('an unavailable optional operations source keeps the workspace with a retry message', async () => {
  const state = reset();
  state.rpc = (name, args) => name === 'crm_operations_v2_read' ? { data: null, error: { code: 'PT503', message: 'Unavailable.' } } : resultFor(name, args);
  const result = await getInitialWorkspace();
  assert.equal(result.workspace.user.userId, OWNER);
  assert.equal(result.operations, null);
  assert.match(result.operationsError, /Refresh overview/);
});

test('an incomplete operations response is discarded before it can enter dashboard props', async () => {
  const state = reset();
  state.rpc = (name, args) => { const result = resultFor(name, args); if (name === 'crm_operations_v2_read') delete result.data.extension; return result; };
  const result = await getInitialWorkspace();
  assert.equal(result.operations, null);
  assert.match(result.operationsError, /Refresh overview/);
});

test('a stalled optional read is aborted and cannot hold the initial page indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = reset();
  state.rpc = (name, args) => name === 'crm_operations_v2_read' ? new Promise(() => undefined) : resultFor(name, args);
  const pending = getInitialWorkspace();
  await setImmediate();
  t.mock.timers.tick(5_000);
  const result = await pending;
  assert.equal(result.operations, null);
  assert.match(result.operationsError, /Refresh overview/);
  assert.equal(state.rpcCalls.find(call => call.name === 'crm_operations_v2_read').signal.aborted, true);
});

test('workspace deadlines fail with a retryable error and cancel remaining work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = reset(); state.rpc = () => new Promise(() => undefined);
  const pending = getInitialWorkspace();
  await setImmediate();
  t.mock.timers.tick(10_000);
  await assert.rejects(pending, error => error.status === 503);
  assert.ok(state.rpcCalls.every(call => call.signal.aborted));
});

test('mixed identity, role, inactive membership and administrator scope never serialize together', async () => {
  const variants = [
    data => ({ ...data, user: { ...data.user, userId: EMPLOYEE } }),
    data => ({ ...data, user: { ...data.user, role: 'SALES' } }),
    data => ({ ...data, user: { ...data.user, active: false } }),
    data => ({ ...data, permissions: { ...data.permissions, admin: false } }),
  ];
  for (const transform of variants) {
    const state = reset();
    state.rpc = (name, args) => { const result = resultFor(name, args); if (name === 'crm_operations_v2_read') result.data = transform(result.data); return result; };
    await assert.rejects(getInitialWorkspace(), error => error.status === 403);
  }
});

test('page proxy renews cookies and keeps private headers while claims cannot authorize CRM data', async () => {
  const state = reset(); state.renewCookie = true; state.user = null;
  const response = await proxy(new NextRequest('https://crm.example.test/'));
  assert.equal(state.claimCalls, 1); assert.equal(state.authCalls, 0);
  assert.equal(response.cookies.get('sb-test-auth-token').value, 'renewed-test-token');
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  await assert.rejects(getInitialWorkspace(), error => error.status === 401);
  assert.equal(state.authCalls, 1); assert.equal(state.rpcCalls.length, 0);
});

test('dashboard GET verifies one identity, reads both modules concurrently and exposes only phase timings', async () => {
  const state = reset(), finish = new Map();
  state.rpc = (name, args) => new Promise(resolve => finish.set(name, () => resolve(resultFor(name, args))));
  const pending = dashboardGET(new Request('https://crm.example.test/api/dashboard'));
  await setImmediate();
  assert.equal(state.authCalls, 1);
  assert.deepEqual([...finish.keys()].sort(), ['crm_operations_v2_read', 'crm_workspace_read']);
  finish.get('crm_workspace_read')(); finish.get('crm_operations_v2_read')();
  const response = await pending, body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ['operations', 'operationsError', 'workspace']);
  assert.equal(body.workspace.user.userId, OWNER);
  assert.equal(body.operations.user.userId, OWNER);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  const timing = response.headers.get('server-timing');
  assert.match(timing, /auth;dur=\d/); assert.match(timing, /workspace;dur=\d/);
  assert.match(timing, /operations;dur=\d/); assert.match(timing, /total;dur=\d/);
  assert.doesNotMatch(timing, /example|00000000|token|email/);
});

test('all refresh endpoints bound stalled Auth and reject late cookies and private reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [path, handler] of [['dashboard', dashboardGET], ['workspace', workspaceGET], ['operations', operationsGET]]) {
    const state = reset(); let finishAuth;
    state.auth = () => new Promise(resolve => { finishAuth = resolve; });
    const pending = handler(new Request(`https://crm.example.test/api/${path}`));
    await setImmediate();
    assert.equal(state.authCalls, 1); assert.equal(state.rpcCalls.length, 0);
    t.mock.timers.tick(SERVER_READ_TIMEOUT_MS);
    const response = await pending;
    assert.equal(response.status, 503, path);
    assert.match(response.headers.get('server-timing'), /total;dur=/);
    state.authOptions[0].cookies.setAll([{ name: 'test-auth', value: 'late-token', options: {} }]);
    finishAuth({ data: { user: authUser(OWNER) }, error: null });
    await setImmediate();
    assert.equal(state.cookieWrites.length, 0, path);
    assert.equal(state.rpcCalls.length, 0, path);
  }
});

test('one total deadline includes authentication time and aborts downstream RPCs', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = reset(); let finishAuth;
  state.auth = () => new Promise(resolve => { finishAuth = resolve; });
  state.rpc = () => new Promise(() => undefined);
  const pending = dashboardGET(new Request('https://crm.example.test/api/dashboard'));
  await setImmediate();
  t.mock.timers.tick(7_000);
  finishAuth({ data: { user: authUser(OWNER) }, error: null });
  await setImmediate();
  assert.equal(state.rpcCalls.length, 2);
  t.mock.timers.tick(3_000);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.ok(state.rpcCalls.every(call => call.signal.aborted));
});

test('a disconnected refresh aborts Auth transport and cannot write cookies later', async t => {
  const state = reset(), controller = new AbortController(); let fetchSignal;
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    fetchSignal = init.signal;
    return new Promise(() => undefined);
  });
  state.auth = async options => {
    await options.global.fetch('https://crm-tests.invalid/auth/v1/user');
    return { data: { user: authUser(OWNER) }, error: null };
  };
  const pending = dashboardGET(new Request('https://crm.example.test/api/dashboard', { signal: controller.signal }));
  await setImmediate();
  assert.ok(fetchSignal instanceof AbortSignal);
  controller.abort();
  assert.equal((await pending).status, 503);
  assert.equal(fetchSignal.aborted, true);
  state.authOptions[0].cookies.setAll([{ name: 'test-auth', value: 'late-token', options: {} }]);
  assert.equal(state.cookieWrites.length, 0);
  assert.equal(state.rpcCalls.length, 0);
});

test('a disconnected refresh aborts all in-flight RPCs and returns no private snapshot', async () => {
  const state = reset(), controller = new AbortController();
  state.rpc = () => new Promise(() => undefined);
  const pending = dashboardGET(new Request('https://crm.example.test/api/dashboard', { signal: controller.signal }));
  await setImmediate();
  assert.equal(state.rpcCalls.length, 2);
  controller.abort();
  const response = await pending, body = await response.json();
  assert.equal(response.status, 503);
  assert.ok(state.rpcCalls.every(call => call.signal.aborted));
  assert.equal(Object.hasOwn(body, 'workspace'), false);
});

test('combined refresh preserves 401/403 denials and treats Auth outages as retryable', async () => {
  for (const status of [401, 403, 503]) {
    const state = reset();
    if (status === 401) state.user = null;
    if (status === 403) state.user = { ...authUser(OWNER), email_confirmed_at: null };
    if (status === 503) state.authError = { name: 'AuthRetryableFetchError', status: 503 };
    const response = await dashboardGET(new Request('https://crm.example.test/api/dashboard'));
    assert.equal(response.status, status);
    assert.equal(state.rpcCalls.length, 0);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});

test('an operations denial or mixed role fails the complete dashboard response closed', async () => {
  for (const denied of [true, false]) {
    const state = reset();
    state.rpc = (name, args) => {
      if (name === 'crm_operations_v2_read' && denied) return { data: null, error: { code: 'PT403', message: 'Membership changed.' } };
      const result = resultFor(name, args);
      if (name === 'crm_operations_v2_read') result.data.user.role = 'SALES';
      return result;
    };
    const response = await dashboardGET(new Request('https://crm.example.test/api/dashboard'));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(Object.hasOwn(body, 'workspace'), false);
    assert.equal(Object.hasOwn(body, 'operations'), false);
  }
});

test('mutation replays keep the existing receipt path without a read timeout or aborted Auth scope', async () => {
  const state = reset();
  const workspace = { user: member(OWNER), revision: 1 };
  state.rpc = () => ({ data: { data: workspace, receiptMessage: 'Already saved.' }, error: null });
  const result = await mutateWorkspace(new Request('https://crm.example.test/api/workspace', {
    method: 'POST', headers: { origin: 'https://crm.example.test', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'lead_save', payload: {}, expectedRevision: 1, requestId: 'test-replayed-request' }),
  }));
  assert.deepEqual(result, { data: workspace, message: 'Already saved.' });
  assert.equal(state.authCalls, 1);
  assert.equal(state.authOptions[0].global, undefined);
  assert.equal(state.rpcCalls.length, 1);
  assert.equal(state.rpcCalls[0].name, 'crm_mutation_prepare');
  assert.equal(state.rpcCalls[0].signal, undefined);
});
