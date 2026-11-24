import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the actual handlers and Next matcher with a controlled Auth/database
// transport. No real credentials, network requests or production data are used.
const require = createRequire(import.meta.url);
const nextServerUrl = pathToFileURL(require.resolve('next/server')).href;
const { unstable_doesMiddlewareMatch } = require('next/experimental/testing/server');
const { NextRequest } = require('next/server');
const root = new URL('../', import.meta.url);
const fixtureKey = Symbol.for('smart-construction.refresh-auth-test');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const fixtures = {
  'server-only': moduleUrl('export {};'),
  'next/headers': moduleUrl(`export async function cookies() { return globalThis[Symbol.for('smart-construction.refresh-auth-test')].cookies; }`),
  '@supabase/ssr': moduleUrl(`export function createServerClient(_url, _key, options) {
    return { auth: { async getUser() {
      const state = globalThis[Symbol.for('smart-construction.refresh-auth-test')];
      state.authCalls++;
      if (state.renewCookie) options.cookies.setAll([{ name: 'sb-test-auth-token', value: 'renewed-test-token', options: { httpOnly: true, path: '/' } }], {});
      return { data: { user: state.user }, error: state.authError };
    } } };
  }`),
  '@supabase/supabase-js': moduleUrl(`export function createClient() {
    return { async rpc(name, args) {
      const state = globalThis[Symbol.for('smart-construction.refresh-auth-test')];
      state.rpcCalls.push({ name, args });
      return { data: state.databaseError ? null : { ready: true }, error: state.databaseError };
    } };
  }`),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(fixtures, specifier)) return { url: fixtures[specifier], shortCircuit: true };
    if (specifier === 'next/server') return { url: nextServerUrl, shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { config, proxy } = await import('../proxy.ts');
const routes = [
  { path: '/api/workspace', rpc: 'crm_workspace_read', handler: (await import('../app/api/workspace/route.ts')).GET },
  { path: '/api/operations?month=2026-11', rpc: 'crm_operations_v2_read', handler: (await import('../app/api/operations/route.ts')).GET },
  { path: '/api/team-activity?month=2026-11', rpc: 'crm_team_activity_read', handler: (await import('../app/api/team-activity/route.ts')).GET },
];
const environment = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://crm-tests.invalid',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_test_key',
  SUPABASE_SECRET_KEY: 'example-test-server-key',
};
const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);

function reset() {
  const writes = [];
  const state = {
    user: null, authError: null, databaseError: null, authCalls: 0, rpcCalls: [], renewCookie: false,
    cookieWrites: writes,
    cookies: { getAll: () => [], set: (name, value, options) => writes.push({ name, value, options }) },
  };
  globalThis[fixtureKey] = state;
  return state;
}
beforeEach(reset);
after(() => {
  hooks.deregister();
  delete globalThis[fixtureKey];
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function confirmedUser() {
  return { id: '00000000-0000-4000-8000-000000000001', email: 'employee@example.test', email_confirmed_at: '2026-11-01T00:00:00Z', is_anonymous: false, user_metadata: {} };
}
async function dispatch(route) {
  const url = `https://crm.example.test${route.path}`;
  const request = new NextRequest(url);
  if (unstable_doesMiddlewareMatch({ config, url })) await proxy(request);
  return route.handler(request);
}

test('API refreshes skip duplicate proxy verification while pages retain cookie renewal', () => {
  for (const path of ['/api/workspace', '/api/operations', '/api/team-activity', '/api/export', '/api/team', '/api/auth/login', '/api/auth/logout', '/api/auth/confirm', '/api/auth/password', '/api/auth/change-password', '/api/expense-receipts', '/api/expense-receipts/example']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `https://crm.example.test${path}` }), false, path);
  }
  for (const path of ['/', '/login', '/set-password', '/auth/confirm']) {
    assert.equal(unstable_doesMiddlewareMatch({ config, url: `https://crm.example.test${path}` }), true, path);
  }
});

test('refresh handlers reject signed-out requests without reading private data', async () => {
  for (const route of routes) {
    const state = reset();
    const response = await dispatch(route);
    assert.equal(response.status, 401, route.path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(state.authCalls, 1, route.path);
    assert.deepEqual(state.rpcCalls, []);
  }
});

test('each authenticated refresh verifies Auth once, renews cookies and scopes the live database read', async () => {
  for (const route of routes) {
    const state = reset();
    state.user = confirmedUser();
    state.renewCookie = true;
    const response = await dispatch(route);
    assert.equal(response.status, 200, route.path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(state.authCalls, 1, route.path);
    assert.equal(state.cookieWrites.length, 1, route.path);
    assert.equal(state.cookieWrites[0].value, 'renewed-test-token');
    assert.equal(state.cookieWrites[0].options.httpOnly, true);
    assert.equal(state.rpcCalls.length, 1);
    assert.equal(state.rpcCalls[0].name, route.rpc);
    assert.equal(state.rpcCalls[0].args.p_actor_id, state.user.id);
  }
});

test('a removed member remains rejected by every refresh handler after Auth succeeds', async () => {
  for (const route of routes) {
    const state = reset();
    state.user = confirmedUser();
    state.databaseError = { code: 'PT403', message: 'This account no longer has active CRM access.' };
    const response = await dispatch(route);
    assert.equal(response.status, 403, route.path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(state.authCalls, 1);
    assert.equal(state.rpcCalls.length, 1);
  }
});

test('Auth outages return a retryable error without reading private data', async () => {
  for (const route of routes) {
    const state = reset();
    state.authError = { name: 'AuthRetryableFetchError', status: 503 };
    const response = await dispatch(route);
    assert.equal(response.status, 503, route.path);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(state.authCalls, 1);
    assert.deepEqual(state.rpcCalls, []);
  }
});
