import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const fixtureKey = Symbol.for('smart-construction.dealer-api-test');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  'server-only': moduleUrl('export {};'),
  './auth': moduleUrl(`export async function authenticate(signal){const s=globalThis[Symbol.for('smart-construction.dealer-api-test')];s.authCalls++;s.authSignal=signal;if(s.authError)throw s.authError;return {userId:s.actorId};}`),
  './operations-server': moduleUrl(`export async function operationsRpc(name,args,signal){const s=globalThis[Symbol.for('smart-construction.dealer-api-test')];s.calls.push({name,args,signal});if(s.rpcError)throw s.rpcError;return s.data;}`),
};
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only' || (context.parentURL?.endsWith('/lib/dealer-leads-server.ts') && mocks[specifier])) return { url: mocks[specifier], shortCircuit: true };
  if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import('../app/api/dealer-leads/route.ts');
const { CRMError } = await import('../lib/server-actions.ts');
const priorOrigin = process.env.APP_URL;
process.env.APP_URL = 'https://crm.example.test';
let state;
beforeEach(() => {
  const actorId = '10000000-0000-4000-8000-000000000001';
  state = { actorId, data: { revision: 1, assignedSites: [], user: { userId: actorId, name: 'Synthetic Dealer', role: 'DEALER' }, leads: [] }, authCalls: 0, calls: [], authError: null, rpcError: null };
  globalThis[fixtureKey] = state;
});
after(() => { hooks.deregister(); delete globalThis[fixtureKey]; if (priorOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = priorOrigin; });
const origin = 'https://crm.example.test';
function request(body, headers = {}) { return new Request(`${origin}/api/dealer-leads`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); }
function mutation() { return { requestId: 'dealer-api-request', payload: { title: 'Synthetic dealer enquiry', contact: 'Synthetic contact', expectedKw: 0.5 } }; }

test('dealer GET uses one authenticated own-lead RPC and never calls the main CRM or operations snapshot', async () => {
  state.data.user.email = 'private@example.invalid'; state.data.customers = [{ id: 'hidden' }];
  const response = await GET(new Request(`${origin}/api/dealer-leads`));
  assert.equal(response.status, 200); assert.equal(state.authCalls, 1); assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].name, 'crm_dealer_leads_read'); assert.deepEqual(state.calls[0].args, { p_actor_id: state.actorId });
  assert.ok(state.calls[0].signal instanceof AbortSignal); assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.ok(response.headers.get('server-timing')); assert.doesNotMatch(await response.text(), /email|customers|private@example/);
});

test('dealer list rejects supplied actor filters and denies signed-out, removed or wrong-role reads', async () => {
  assert.equal((await GET(new Request(`${origin}/api/dealer-leads?dealerId=other`))).status, 400); assert.equal(state.authCalls, 0);
  state.authError = new CRMError('Sign in.', 401);
  assert.equal((await GET(new Request(`${origin}/api/dealer-leads`))).status, 401); assert.equal(state.calls.length, 0);
  state.authError = null; state.rpcError = new CRMError('Dealer access required.', 403);
  assert.equal((await GET(new Request(`${origin}/api/dealer-leads`))).status, 403);
});

test('dealer POST rejects foreign origins, oversized bodies and privileged fields before authentication or RPC', async () => {
  assert.equal((await POST(request(mutation(), { origin: 'https://other.example.test' }))).status, 403);
  assert.equal((await POST(request(mutation(), { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await POST(request('a'.repeat(16_385)))).status, 413);
  for (const fields of [{ actorId: state.actorId }, { status: 'WON' }, { customerId: 'other' }, { id: 'edit-existing' }, { notes: 'Internal note' }]) {
    assert.equal((await POST(request({ ...mutation(), payload: { ...mutation().payload, ...fields } }))).status, 400);
  }
  assert.equal(state.authCalls, 0); assert.equal(state.calls.length, 0);
});

test('dealer create forwards immutable authenticated origin and the same receipt identity on retries', async () => {
  const body = mutation();
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await POST(request(body))).status, 200);
  assert.equal(state.authCalls, 2); assert.equal(state.calls.length, 2);
  assert.equal(state.calls[0].name, 'crm_dealer_lead_create');
  assert.deepEqual(state.calls[0].args, { p_actor_id: state.actorId, p_request_id: body.requestId, p_payload: body.payload });
  assert.deepEqual(state.calls[1].args, state.calls[0].args);
});

test('dealer GET and POST share the same whitelisted assigned project projection with no additional workspace query', async () => {
  const project = { id: 'lead:assigned-1', title: 'Assigned enquiry', siteAddress: 'Site', siteName: null, siteId: null,
    leadId: 'assigned-1', workOrderId: null, workOrderNumber: null, leadStatus: 'SITE_VISIT', workOrderStatus: null,
    expectedKw: 2.5, completedMilestones: 0, totalMilestones: 0, assignedVia: ['LEAD'] };
  state.data.assignedSites = [{ ...project, contact: 'PRIVATE_CONTACT', phone: 'PRIVATE_PHONE', customer: { email: 'PRIVATE_EMAIL' }, canDelete: true }];
  for (const response of [await GET(new Request(`${origin}/api/dealer-leads`)), await POST(request(mutation()))]) {
    assert.equal(response.status, 200);
    const body = await response.json(); assert.deepEqual(body.assignedSites, [project]); assert.equal(body.revision, 1);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE|canDelete|customer/);
  }
  assert.equal(state.calls.length, 2); assert.equal(state.authCalls, 2);
});

test('dealer reads and saves never expose a valid upstream snapshot belonging to a different authenticated user', async () => {
  state.data = { revision: 1, assignedSites: [], user: { userId: '10000000-0000-4000-8000-000000000002', name: 'Other dealer', role: 'DEALER' }, leads: [{
    id: 'other-lead', title: 'Private other-dealer enquiry', contact: 'Private contact', phone: '', siteAddress: '', expectedKw: 5,
    status: 'NEW', createdAt: '2026-11-27T00:00:00Z', updatedAt: '2026-11-27T00:00:00Z', canDelete: false, deleteBlockedReason: 'Already assigned.',
  }] };
  for (const response of [await GET(new Request(`${origin}/api/dealer-leads`)), await POST(request(mutation()))]) {
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Other dealer|Private|other-lead|10000000-0000-4000-8000-000000000002/);
  }
  assert.ok(state.calls.every(call => call.args.p_actor_id === state.actorId));
});
