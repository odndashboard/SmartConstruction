import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const key = Symbol.for('smart-construction.lead-delete-api');
const url = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  'server-only': url('export {};'),
  './auth': url(`export async function authenticate(){const s=globalThis[Symbol.for('smart-construction.lead-delete-api')];s.authCalls++;if(s.authError)throw s.authError;return {userId:s.actorId};}`),
  './supabase/admin': url(`export function createAdminClient(){return {async rpc(name,args){const s=globalThis[Symbol.for('smart-construction.lead-delete-api')];s.calls.push({name,args});return {data:s.error?null:s.result,error:s.error};}};}`),
};
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only' || context.parentURL?.endsWith('/lib/server.ts') && mocks[specifier]) return { url: mocks[specifier], shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
const { POST } = await import('../app/api/workspace/route.ts');
const { CRMError } = await import('../lib/server-actions.ts');
let state;
beforeEach(() => {
  state = { actorId: '76000000-0000-4000-8000-000000000001', authCalls: 0, calls: [], authError: null, error: null,
    result: { data: { revision: 8, leads: [] }, message: 'Lead deleted.' } };
  globalThis[key] = state;
});
after(() => { hooks.deregister(); delete globalThis[key]; });
function input() { return { action: 'lead_delete', payload: { id: 'actual-lead' }, expectedRevision: 7, requestId: 'delete-request-1' }; }
function request(body = input(), headers = {}) {
  return new Request('https://crm.example.test/api/workspace', { method: 'POST', headers: { origin: 'https://crm.example.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('staff delete uses the authenticated actor and one narrow authoritative RPC, including retry', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await POST(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), state.result);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  assert.equal(state.authCalls, 2); assert.equal(state.calls.length, 2); assert.deepEqual(state.calls[0], state.calls[1]);
  assert.deepEqual(state.calls[0], { name: 'crm_lead_delete', args: {
    p_actor_id: state.actorId, p_expected_revision: 7, p_request_id: 'delete-request-1', p_lead_id: 'actual-lead',
  } });
});

test('delete rejects foreign origins and forged payload authority without calling the database', async () => {
  assert.equal((await POST(request(input(), { origin: 'https://other.example.test' }))).status, 403);
  assert.equal(state.authCalls, 0);
  for (const payload of [{}, { id: '' }, { id: 'actual-lead', actorId: state.actorId }, { id: 'actual-lead', force: true }, { id: 'actual-lead', deleteCustomer: true }]) {
    assert.equal((await POST(request({ ...input(), payload }))).status, 400);
  }
  assert.equal(state.calls.length, 0);
});

test('SQL role, dependency and stale-revision rejection reaches the caller without fallback deletion', async () => {
  for (const [code, status] of [['PT403', 403], ['PT404', 404], ['PT409', 409]]) {
    state.error = { code, message: 'The current database state prevents this deletion.' };
    const response = await POST(request()); assert.equal(response.status, status);
    assert.equal((await response.json()).error, state.error.message);
  }
  assert.equal(state.calls.length, 3); assert.ok(state.calls.every(call => call.name === 'crm_lead_delete'));
  state.authError = new CRMError('Sign in again.', 401);
  assert.equal((await POST(request())).status, 401); assert.equal(state.calls.length, 3);
});
