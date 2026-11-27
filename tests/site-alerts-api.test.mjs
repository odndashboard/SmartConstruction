import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { alertData } from './fixtures/site-alerts.ts';

const root = new URL('../', import.meta.url);
const fixtureKey = Symbol.for('smart-construction.alerts-api-test');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  'server-only': moduleUrl('export {};'),
  './auth': moduleUrl(`export async function authenticate(signal){const s=globalThis[Symbol.for('smart-construction.alerts-api-test')];s.authCalls++;s.authSignal=signal;if(s.authError)throw s.authError;return {userId:s.data.user.userId};}`),
  './operations-server': moduleUrl(`export async function operationsRpc(name,args,signal){const s=globalThis[Symbol.for('smart-construction.alerts-api-test')];s.calls.push({name,args,signal});if(s.rpcError)throw s.rpcError;return name.endsWith('_read')?s.data:{data:s.data,message:'Alert saved.'};}`),
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only' || (context.parentURL?.endsWith('/lib/site-alerts-server.ts') && mocks[specifier])) return { url: mocks[specifier], shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import('../app/api/alerts/route.ts');
const { CRMError } = await import('../lib/server-actions.ts');
const priorOrigin = process.env.APP_URL;
process.env.APP_URL = 'https://crm.example.test';
let state;
beforeEach(() => { state = { data: alertData(), authCalls: 0, calls: [], authError: null, rpcError: null }; globalThis[fixtureKey] = state; });
after(() => { hooks.deregister(); delete globalThis[fixtureKey]; if (priorOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorOrigin; });
const origin = 'https://crm.example.test';
function request(body, headers = {}) { return new Request(`${origin}/api/alerts`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); }
function mutation() { return { action: 'material_alert_create', requestId: 'api-alert-request', expectedRevision: 4, payload: { workOrderId: 'work-active', assigneeId: state.data.user.userId, itemName: 'Synthetic cable' }, query: { status: 'ALL', search: 'copper', page: 2 } }; }

test('alerts GET authenticates once and performs one filtered lean RPC with cancellation and private response headers', async () => {
  state.data.user.email = 'private@example.invalid'; state.data.assignees[0].email = 'private@example.invalid';
  const response = await GET(new Request(`${origin}/api/alerts?workOrderId=work-active&status=ALL&page=2&search=copper%25`));
  assert.equal(response.status, 200); assert.equal(state.authCalls, 1); assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].name, 'crm_material_alerts_read');
  assert.deepEqual(state.calls[0].args, { p_actor_id: state.data.user.userId, p_work_order_id: 'work-active', p_status: 'ALL', p_page: 2, p_search: 'copper%' });
  assert.ok(state.authSignal instanceof AbortSignal); assert.ok(state.calls[0].signal instanceof AbortSignal);
  assert.match(response.headers.get('cache-control'), /private.*no-store/); assert.ok(response.headers.get('server-timing'));
  assert.doesNotMatch(await response.text(), /email|private@example/);
});

test('invalid filters, signed-out reads and denied dealer reads never disclose alert data', async () => {
  for (const query of ['role=OWNER', 'page=0', 'page=1&page=2', 'workOrderId=../other']) assert.equal((await GET(new Request(`${origin}/api/alerts?${query}`))).status, 400);
  assert.equal(state.authCalls, 0);
  state.authError = new CRMError('Sign in.', 401);
  const signedOut = await GET(new Request(`${origin}/api/alerts`)); assert.equal(signedOut.status, 401); assert.equal((await signedOut.json()).accessRevoked, true); assert.equal(state.calls.length, 0);
  state.authError = null; state.rpcError = new CRMError('This role cannot access alerts.', 403);
  const denied = await GET(new Request(`${origin}/api/alerts`)); assert.equal(denied.status, 403); assert.equal((await denied.json()).accessRevoked, true);
});

test('alerts POST applies origin, JSON, streamed byte limits and strict identity validation before any database mutation', async () => {
  assert.equal((await POST(request(mutation(), { origin: 'https://other.example.test' }))).status, 403);
  assert.equal((await POST(request(mutation(), { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await POST(request('a'.repeat(16_385)))).status, 413);
  assert.equal((await POST(request({ ...mutation(), actorId: state.data.user.userId }))).status, 400);
  assert.equal((await POST(request({ ...mutation(), payload: { ...mutation().payload, status: 'RESOLVED' } }))).status, 400);
  assert.equal(state.authCalls, 0); assert.equal(state.calls.length, 0);
});

test('POST forwards authenticated actor, normalized payload and stable receipt hash while preserving exact retry identity', async () => {
  const body = mutation();
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await POST(request(body))).status, 200);
  assert.equal(state.authCalls, 2); assert.equal(state.calls.length, 2);
  const first = state.calls[0]; assert.equal(first.name, 'crm_material_alerts_mutate');
  assert.equal(first.args.p_actor_id, state.data.user.userId); assert.equal(first.args.p_request_id, body.requestId);
  assert.equal(first.args.p_expected_revision, 4); assert.equal(first.args.p_search, 'copper'); assert.equal(first.args.p_page, 2);
  assert.deepEqual(first.args.p_payload, { ...body.payload, itemId: null, note: '', quantity: null, unit: '' });
  assert.match(first.args.p_payload_hash, /^[a-f0-9]{64}$/); assert.deepEqual(state.calls[0].args, state.calls[1].args);
});

test('forbidden resolve is an action error; actual authentication loss is explicitly marked as revoked', async () => {
  state.rpcError = new CRMError('Only the assignee may resolve this alert.', 403);
  const denied = await POST(request(mutation())); assert.equal(denied.status, 403); assert.equal((await denied.json()).accessRevoked, false);
  state.rpcError = null; state.authError = new CRMError('Your access ended.', 403);
  const expired = await POST(request(mutation())); assert.equal(expired.status, 403); assert.equal((await expired.json()).accessRevoked, true);
});
