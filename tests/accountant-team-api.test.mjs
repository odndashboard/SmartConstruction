import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the real input schema and account handler without Auth/network IO.
const root = new URL('../', import.meta.url);
const key = Symbol.for('smart-construction.accountant-team-test');
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`;
const fixtures = {
  'server-only': moduleUrl('export {};'),
  '@/lib/server': moduleUrl(`
    export { CRMError } from ${JSON.stringify(new URL('../lib/server-actions.ts', import.meta.url).href)};
    export async function getWorkspace() { return globalThis[Symbol.for('smart-construction.accountant-team-test')].workspace; }
  `),
  '@/lib/supabase/admin': moduleUrl(`
    export function createAdminClient() { const state = globalThis[Symbol.for('smart-construction.accountant-team-test')]; state.clientCalls++; return state.client; }
  `),
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(fixtures, specifier)) return { url: fixtures[specifier], shortCircuit: true };
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, root).href, context);
    if (specifier.startsWith('.') && context.parentURL?.startsWith(root.href) && !context.parentURL.includes('/node_modules/')) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { POST } = await import('../app/api/team/route.ts');
const originalOrigin = process.env.APP_URL;
process.env.APP_URL = 'https://crm.example.invalid';
const OWNER = '00000000-0000-4000-8000-000000000001';
const ACCOUNTANT = '00000000-0000-4000-8000-000000000002';

function reset() {
  const owner = { userId: OWNER, name: 'Owner', email: 'owner@example.invalid', role: 'OWNER', active: true };
  const state = {
    workspace: { user: owner, members: [owner] }, clientCalls: 0, invites: [], grants: [], databaseError: null,
  };
  state.client = {
    auth: { admin: { generateLink: async input => {
      state.invites.push(input);
      return { data: { user: { id: ACCOUNTANT, email: input.email }, properties: { hashed_token: 'synthetic-token-for-accountant-test-only' } }, error: null };
    } } },
    rpc: async (name, args) => {
      state.grants.push({ name, args });
      if (state.databaseError) return { data: null, error: state.databaseError };
      state.workspace.members.push({ userId: args.p_user_id, name: args.p_name, email: args.p_email, role: args.p_role, active: true });
      return { data: {}, error: null };
    },
  };
  globalThis[key] = state;
  return state;
}
beforeEach(reset);
after(() => {
  hooks.deregister(); delete globalThis[key];
  if (originalOrigin === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalOrigin;
});

function addRequest(role = 'ACCOUNTANT') {
  return new Request('https://crm.example.invalid/api/team', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://crm.example.invalid' },
    body: JSON.stringify({ action: 'add', name: 'Test Accountant', email: 'Accountant@Example.invalid', role }),
  });
}

test('owner can create an Accountant account link with the exact role and verified email', async () => {
  const state = globalThis[key];
  const response = await POST(addRequest());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const result = await response.json();
  assert.equal(result.email, 'accountant@example.invalid');
  assert.equal(result.data.members.find(member => member.userId === ACCOUNTANT).role, 'ACCOUNTANT');
  assert.equal(new URL(result.link).origin, 'https://crm.example.invalid');
  assert.deepEqual(state.grants, [{ name: 'crm_add_member', args: {
    p_actor_id: OWNER, p_user_id: ACCOUNTANT, p_name: 'Test Accountant', p_email: 'accountant@example.invalid', p_role: 'ACCOUNTANT',
  } }]);
  assert.equal(state.invites.length, 1);
});

test('nonowners and inactive owners cannot create an Accountant account or link', async () => {
  for (const role of ['MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER', 'OWNER']) {
    const state = reset(); state.workspace.user.role = role;
    if (role === 'OWNER') state.workspace.user.active = false;
    const response = await POST(addRequest());
    assert.equal(response.status, 403, role);
    assert.equal(state.clientCalls, 0);
    assert.equal(state.invites.length, 0);
    assert.equal(state.grants.length, 0);
  }
});

test('owner can create the separate Dealer role and the retired Viewer role is rejected', async () => {
  const state = globalThis[key];
  assert.equal((await POST(addRequest('DEALER'))).status, 200);
  assert.equal(state.grants[0].args.p_role, 'DEALER');
  reset();
  assert.equal((await POST(addRequest('VIEWER'))).status, 400);
  assert.equal(globalThis[key].clientCalls, 0);
});

test('unsupported and Owner roles remain invalid in the employee invitation endpoint', async () => {
  for (const role of ['OWNER', 'ADMIN', 'accountant', 'SUPERUSER']) {
    const state = reset(); const response = await POST(addRequest(role));
    assert.equal(response.status, 400, role);
    assert.equal(state.clientCalls, 0);
  }
});

test('database rejection of the Accountant membership never returns an account setup token', async () => {
  const state = globalThis[key]; state.databaseError = { code: 'PT403' };
  const response = await POST(addRequest());
  assert.equal(response.status, 403);
  const result = await response.json();
  assert.equal(Object.hasOwn(result, 'link'), false);
  assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
  assert.equal(state.workspace.members.length, 1);
});
