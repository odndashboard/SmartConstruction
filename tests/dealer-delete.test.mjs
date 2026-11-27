import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deleteDealerLead as removeFromClient, DealerLeadRequestError } from '../lib/dealer-leads-client.ts';
import { deleteDealerLeadSchema } from '../lib/dealer-leads-validation.ts';

const root = new URL('../', import.meta.url), fixtureKey = Symbol.for('smart-construction.dealer-delete-test');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  'server-only': moduleUrl('export {};'),
  './auth': moduleUrl(`export async function authenticate(){const s=globalThis[Symbol.for('smart-construction.dealer-delete-test')];s.authCalls++;if(s.authError)throw s.authError;return {userId:s.actorId};}`),
  './operations-server': moduleUrl(`export async function operationsRpc(name,args){const s=globalThis[Symbol.for('smart-construction.dealer-delete-test')];s.calls.push({name,args});if(name==='crm_dealer_leads_read'){if(s.readError)throw s.readError;return s.data;}if(s.rpcError)throw s.rpcError;return s.result;}`),
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only' || (context.parentURL?.endsWith('/lib/dealer-leads-server.ts') && mocks[specifier])) return { url: mocks[specifier], shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { DELETE } = await import('../app/api/dealer-leads/route.ts');
const { CRMError } = await import('../lib/server-actions.ts');
const priorOrigin = process.env.APP_URL;
const origin = 'https://crm.example.test'; process.env.APP_URL = origin;
let state;
beforeEach(() => {
  const actorId = '10000000-0000-4000-8000-000000000001';
  const data = { revision: 8, user: { userId: actorId, name: 'Synthetic Dealer', role: 'DEALER' }, leads: [], assignedSites: [] };
  state = { actorId, data, result: { data, message: 'Lead deleted.' }, authCalls: 0, calls: [], authError: null, rpcError: null, readError: null };
  globalThis[fixtureKey] = state;
});
after(() => { hooks.deregister(); delete globalThis[fixtureKey]; if (priorOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorOrigin; });
const mutation = () => ({ requestId: 'delete-own-enquiry-1', expectedRevision: 7, leadId: 'own-lead' });
function request(body = mutation(), headers = {}) { return new Request(`${origin}/api/dealer-leads`, { method: 'DELETE', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); }

test('dealer deletion accepts only the confirmed lead, revision and receipt identity', () => {
  assert.deepEqual(deleteDealerLeadSchema.parse(mutation()), mutation());
  for (const expectedRevision of [-1, 1.5, NaN, Infinity, '7', Number.MAX_SAFE_INTEGER + 1]) assert.equal(deleteDealerLeadSchema.safeParse({ ...mutation(), expectedRevision }).success, false);
  for (const extra of [{ actorId: state.actorId }, { role: 'OWNER' }, { action: 'lead_delete' }, { payload: {} }, { all: true }]) assert.equal(deleteDealerLeadSchema.safeParse({ ...mutation(), ...extra }).success, false);
});

test('dealer DELETE checks origin/body and passes authenticated identity to the atomic dealer-only RPC', async () => {
  assert.equal((await DELETE(request(mutation(), { origin: 'https://other.example.test' }))).status, 403);
  assert.equal((await DELETE(request(mutation(), { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await DELETE(request('x'.repeat(16_385)))).status, 413);
  assert.equal((await DELETE(request({ ...mutation(), actorId: 'other' }))).status, 400);
  assert.equal(state.authCalls, 0); assert.equal(state.calls.length, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await DELETE(request()); assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.deepEqual(await response.json(), state.result);
  }
  assert.deepEqual(state.calls, Array(2).fill({ name: 'crm_dealer_lead_delete', args: { p_actor_id: state.actorId, p_expected_revision: 7, p_request_id: mutation().requestId, p_lead_id: 'own-lead' } }));
});

test('deleted-result snapshots remain scoped and never expose another user or privileged fields', async () => {
  state.result = { data: { ...state.data, customers: [{ email: 'private@example.invalid' }], user: { ...state.data.user, email: 'private@example.invalid' } }, message: 'Lead deleted.' };
  let response = await DELETE(request()); assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /customers|email|private@example/);
  state.result.data.user.userId = '10000000-0000-4000-8000-000000000002';
  response = await DELETE(request()); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /10000000-0000-4000-8000-000000000002|private@example/);
});

test('protected or foreign lead rejection preserves active dealer access; role revocation is marked explicitly', async () => {
  state.rpcError = new CRMError('This enquiry cannot be deleted.', 403);
  let response = await DELETE(request()); assert.equal(response.status, 403); assert.equal((await response.json()).accessRevoked, undefined);
  assert.equal(state.calls.at(-1).name, 'crm_dealer_leads_read');
  state.readError = new CRMError('Dealer access required.', 403);
  response = await DELETE(request()); assert.equal(response.status, 403); assert.equal((await response.json()).accessRevoked, true);
  state.authError = new CRMError('Sign in.', 401); state.calls = [];
  response = await DELETE(request()); assert.equal(response.status, 401); assert.equal((await response.json()).accessRevoked, true); assert.equal(state.calls.length, 0);
});

test('dealer deletion transport retries only the same DELETE receipt after a lost response', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/dealer-leads'); assert.equal(options.method, 'DELETE'); assert.equal(options.credentials, 'same-origin');
    calls.push(JSON.parse(options.body)); if (calls.length === 1) throw new TypeError('Response lost');
    return Response.json(state.result);
  });
  await assert.rejects(removeFromClient(mutation()), error => error instanceof DealerLeadRequestError && error.uncertain && !error.accessRevoked);
  assert.equal(calls.length, 1);
  assert.deepEqual(await removeFromClient(mutation()), state.result); assert.deepEqual(calls, [mutation(), mutation()]);
});

test('deletion errors distinguish definitive action failure, revoked access and malformed uncertain success', async t => {
  let response; t.mock.method(globalThis, 'fetch', async () => response);
  for (const status of [400, 403, 404, 409]) {
    response = Response.json({ error: 'Protected enquiry.' }, { status });
    await assert.rejects(removeFromClient(mutation()), error => error instanceof DealerLeadRequestError && error.status === status && !error.uncertain && !error.accessRevoked);
  }
  response = Response.json({ error: 'Dealer access changed.', accessRevoked: true }, { status: 403 });
  await assert.rejects(removeFromClient(mutation()), error => error instanceof DealerLeadRequestError && error.accessRevoked);
  for (const value of [Response.json(null), Response.json({ data: state.data }), Response.json({ data: { user: state.data.user }, message: 'Deleted' }), new Response('Bad gateway', { status: 502 })]) {
    response = value; await assert.rejects(removeFromClient(mutation()), error => error instanceof DealerLeadRequestError && error.uncertain);
  }
});
