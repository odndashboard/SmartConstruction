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
      async getUser() { const state=globalThis[${fixtureSymbol}]; state.authCalls++; return { data: { user: state.authUsers.length ? state.authUsers.shift() : state.user }, error: state.authError }; },
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
  const state = {
    user: authUser(OWNER), authUsers: [], authError: null, authCalls: 0, claimCalls: 0, rpcCalls: [], renewCookie: false,
    cookies: { getAll: () => [], set() {} }, rpc: resultFor,
  };
  globalThis[fixtureKey] = state;
  return state;
}
beforeEach(reset);
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
