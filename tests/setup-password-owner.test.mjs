import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_ENV, OPERATOR_COMPLETE_EXIT, runOperatorCli } from '../scripts/setup-password-owner.mjs';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT = 'abcdefghijklmnopqrst';
const COMMIT = 'a'.repeat(40);

function fixture(overrides = {}) {
  const payload = {
    expectedProjectRef: PROJECT, expectedCommit: COMMIT,
    operationId: 'test-operation-0001', email: 'Operator@Example.invalid',
    name: 'Test Operator', password: 'fixture-password-never-used',
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    ...overrides,
  };
  const env = {
    VERCEL: '1', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_SHA: COMMIT,
    NEXT_PUBLIC_SUPABASE_URL: `https://${PROJECT}.supabase.co`,
    SUPABASE_SECRET_KEY: 'fixture-server-credential',
    [INPUT_ENV]: JSON.stringify(payload),
  };
  const user = {
    id: ID, email: payload.email.toLowerCase(), user_metadata: { name: payload.name },
    email_confirmed_at: new Date(NOW).toISOString(), is_anonymous: false,
  };
  const owner = { userId: ID, name: payload.name, email: user.email, role: 'OWNER', active: true };
  const workspace = { user: owner, members: [owner], customers: [], leads: [], followups: [], quotations: [], workorders: [] };
  const calls = [];
  const output = [];
  const client = {
    auth: { admin: {
      listUsers: async (input) => { calls.push(['listUsers', input]); return { data: { users: [] }, error: null }; },
      createUser: async (input) => { calls.push(['createUser', input]); return { data: { user }, error: null }; },
      getUserById: async (id) => { calls.push(['getUserById', id]); return { data: { user }, error: null }; },
    } },
    rpc: async (name, input) => {
      calls.push([name, input]);
      return { data: name === 'crm_bootstrap_status' ? false : name === 'crm_bootstrap_owner' ? owner : workspace, error: null };
    },
  };
  const options = {
    args: ['--execute', '--operator-only'], env, now: () => NOW,
    clientFactory: (url, key, config) => {
      calls.push(['clientFactory', { url, correctKey: key === env.SUPABASE_SECRET_KEY, config }]);
      return client;
    },
    output: line => output.push(line),
  };
  return { payload, env, user, owner, workspace, calls, output, client, options };
}

async function expectFailure(f, code) {
  assert.equal(await runOperatorCli(f.options), 1);
  assert.deepEqual(f.output, [`OWNER_SETUP_FAILURE code=${code}`]);
  assert.equal(f.output.join('').includes(f.payload.password), false);
  assert.equal(f.output.join('').includes(f.env.SUPABASE_SECRET_KEY), false);
  assert.equal(Object.hasOwn(f.env, INPUT_ENV), false);
}

test('confirmed exact account becomes the sole Owner; operator success still exits nonzero', async () => {
  const f = fixture();
  assert.equal(await runOperatorCli(f.options), OPERATOR_COMPLETE_EXIT);
  assert.notEqual(OPERATOR_COMPLETE_EXIT, 0);
  assert.deepEqual(f.output, [`OWNER_SETUP_SUCCESS user_id=${ID}`]);
  const create = f.calls.find(([name]) => name === 'createUser')[1];
  assert.deepEqual(create, { email: 'operator@example.invalid', password: f.payload.password, email_confirm: true, user_metadata: { name: 'Test Operator' } });
  assert.deepEqual(f.calls.find(([name]) => name === 'crm_bootstrap_owner'), ['crm_bootstrap_owner', { p_user_id: ID }]);
  assert.deepEqual(f.calls.find(([name]) => name === 'crm_workspace_read'), ['crm_workspace_read', { p_actor_id: ID, p_full_audit: false }]);
  assert.equal(Object.hasOwn(f.env, INPUT_ENV), false);
  const config = f.calls[0][1].config;
  assert.deepEqual(config.auth, { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  assert.throws(() => config.global.fetch('https://example.invalid/steal', {}), /UNEXPECTED_REQUEST_ORIGIN/);
});

test('no activation, wrong project/commit/environment, expired or long-lived input never creates a client', async () => {
  const scenarios = [
    [f => { f.options.args = []; }, 'EXPLICIT_FLAGS_REQUIRED'],
    [f => { f.options.args = ['--execute', '--execute']; }, 'EXPLICIT_FLAGS_REQUIRED'],
    [f => { f.env.VERCEL_ENV = 'preview'; }, 'PRODUCTION_OPERATOR_BUILD_REQUIRED'],
    [f => { f.env.NEXT_PUBLIC_SUPABASE_URL += '/auth/v1'; }, 'SUPABASE_URL_MISMATCH'],
    [f => { f.env.VERCEL_GIT_COMMIT_SHA = 'b'.repeat(40); }, 'COMMIT_MISMATCH'],
    [f => { f.env[INPUT_ENV] = '{invalid'; }, 'INPUT_INVALID'],
    [f => { f.env[INPUT_ENV] = JSON.stringify({ ...f.payload, expiresAt: new Date(NOW).toISOString() }); }, 'INPUT_EXPIRED_OR_LIFETIME_INVALID'],
    [f => { f.env[INPUT_ENV] = JSON.stringify({ ...f.payload, expiresAt: new Date(NOW + 31 * 60_000).toISOString() }); }, 'INPUT_EXPIRED_OR_LIFETIME_INVALID'],
  ];
  for (const [change, code] of scenarios) {
    const f = fixture(); change(f);
    await expectFailure(f, code);
    assert.deepEqual(f.calls, []);
  }
});

test('any existing CRM membership or ambiguous status refuses to touch Auth', async () => {
  for (const status of [true, null, {}, { has_members: false }]) {
    const f = fixture();
    f.client.rpc = async () => ({ data: status, error: null });
    await expectFailure(f, 'WORKSPACE_NOT_EMPTY_OR_STATUS_INVALID');
    assert.equal(f.calls.some(([name]) => ['listUsers', 'createUser'].includes(name)), false);
  }
});

test('an exact existing Auth email on a later page refuses creation without reset or delete', async () => {
  const f = fixture();
  f.client.auth.admin.listUsers = async ({ page }) => ({ data: { users: page === 1
    ? Array.from({ length: 200 }, (_, i) => ({ email: `other-${i}@example.invalid` }))
    : [{ email: f.payload.email.toUpperCase() }] }, error: null });
  await expectFailure(f, 'AUTH_ACCOUNT_ALREADY_EXISTS');
  assert.equal(f.calls.some(([name]) => name === 'createUser'), false);
  assert.equal(f.calls.some(([name]) => name === 'crm_bootstrap_owner'), false);
});

test('mismatched or unconfirmed created identity is never bootstrapped', async () => {
  for (const changed of [
    { email: 'someone-else@example.invalid' }, { email_confirmed_at: null },
    { id: 'not-a-uuid' }, { user_metadata: { name: 'Another Person' } },
    { is_anonymous: true }, { banned_until: new Date(NOW + 60_000).toISOString() },
  ]) {
    const f = fixture();
    f.client.auth.admin.createUser = async () => ({ data: { user: { ...f.user, ...changed } }, error: null });
    await expectFailure(f, 'CREATED_USER_MISMATCH_REVIEW_STATE');
    assert.equal(f.calls.some(([name]) => name === 'crm_bootstrap_owner'), false);
  }
});

test('independent getUserById identity verification must match created UUID', async () => {
  const f = fixture();
  f.client.auth.admin.getUserById = async () => ({ data: { user: { ...f.user, id: OTHER_ID } }, error: null });
  await expectFailure(f, 'VERIFIED_USER_MISMATCH_REVIEW_STATE');
  assert.equal(f.calls.some(([name]) => name === 'crm_bootstrap_owner'), false);
});

test('a concurrent membership prevents grant and does not reset/delete created account', async () => {
  const f = fixture();
  let checks = 0;
  f.client.rpc = async (name) => {
    assert.equal(name, 'crm_bootstrap_status');
    return { data: ++checks === 3, error: null };
  };
  await expectFailure(f, 'WORKSPACE_NOT_EMPTY_OR_STATUS_INVALID');
  assert.equal(f.calls.some(([name]) => name === 'createUser'), true);
  assert.equal(f.calls.some(([name]) => name === 'crm_bootstrap_owner'), false);
});

test('bootstrap rejection, including business records found by its atomic guard, is never success', async () => {
  const f = fixture();
  const rpc = f.client.rpc;
  f.client.rpc = async (name, input) => name === 'crm_bootstrap_owner'
    ? { data: null, error: { message: `untrusted ${f.payload.password}` } } : rpc(name, input);
  await expectFailure(f, 'OWNER_GRANT_FAILED_REVIEW_STATE');
  assert.equal(f.calls.some(([name]) => name === 'crm_workspace_read'), false);
});

test('post-grant Owner and workspace identities are independently verified', async () => {
  const f = fixture();
  f.workspace.members = [{ ...f.owner, userId: OTHER_ID }];
  await expectFailure(f, 'WORKSPACE_RESULT_MISMATCH_REVIEW_STATE');
});

test('SDK rejection and arbitrary thrown errors never render messages, stacks, or credentials', async () => {
  for (const throws of [false, true]) {
    const f = fixture();
    f.client.auth.admin.createUser = async () => {
      const unsafe = `${f.payload.password} ${f.env.SUPABASE_SECRET_KEY}`;
      if (throws) throw new Error(unsafe);
      return { data: null, error: { message: unsafe } };
    };
    await expectFailure(f, 'AUTH_CREATE_FAILED_REVIEW_STATE');
  }
});

test('known credential, rate-limit and password errors produce only fixed diagnostic codes', async () => {
  for (const [remote, code] of [
    [{ status: 401 }, 'SERVER_CREDENTIAL_REJECTED'],
    [{ status: 403 }, 'SERVER_ACCESS_REJECTED'],
    [{ status: 429 }, 'AUTH_RATE_LIMITED_REVIEW_STATE'],
    [{ code: 'over_request_rate_limit' }, 'AUTH_RATE_LIMITED_REVIEW_STATE'],
    [{ code: 'weak_password' }, 'PASSWORD_POLICY_REJECTED'],
  ]) {
    const f = fixture();
    f.client.auth.admin.createUser = async () => ({ data: null, error: { ...remote, message: f.payload.password } });
    await expectFailure(f, code);
  }
});
