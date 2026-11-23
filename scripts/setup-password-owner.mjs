/**
 * Explicit, one-time operator build. Never call from an application route,
 * install hook, or ordinary build. The temporary JSON input is supplied as a
 * Production Secret, never as CLI arguments or a repository file.
 *
 * This command ALWAYS exits nonzero: exit 78 after verified success, 1 after
 * failure. An operator build must never publish a serving application artifact.
 * Clear the temporary Secret and deploy the ordinary source after completion.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

export const INPUT_ENV = 'CRM_OWNER_SETUP_JSON';
export const OPERATOR_COMPLETE_EXIT = 78;
const MAX_TTL_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYLOAD_KEYS = ['expectedProjectRef', 'expectedCommit', 'operationId', 'email', 'name', 'password', 'expiresAt'];

class OperatorError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function ensure(condition, code) {
  if (!condition) throw new OperatorError(code);
}
function checkExpiry(expiresAt, now) {
  const remaining = Date.parse(expiresAt) - now();
  ensure(Number.isFinite(remaining) && remaining > 0 && remaining <= MAX_TTL_MS, 'INPUT_EXPIRED_OR_LIFETIME_INVALID');
}
async function request(run, code) {
  let response;
  try { response = await run(); } catch (error) { throw safeRequestError(error, code); }
  if (response?.error) throw safeRequestError(response.error, code);
  ensure(response && Object.hasOwn(response, 'data'), code);
  return response.data;
}
function safeRequestError(error, fallback) {
  // Only known codes/statuses influence these fixed diagnostics. The remote
  // message, response, request and stack are never rendered.
  if (error?.status === 401 || ['bad_jwt', 'invalid_api_key'].includes(error?.code)) return new OperatorError('SERVER_CREDENTIAL_REJECTED');
  if (error?.status === 403 || error?.code === 'not_admin') return new OperatorError('SERVER_ACCESS_REJECTED');
  if (error?.status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit'].includes(error?.code)) return new OperatorError('AUTH_RATE_LIMITED_REVIEW_STATE');
  if (error?.code === 'weak_password') return new OperatorError('PASSWORD_POLICY_REJECTED');
  return new OperatorError(fallback);
}

function readInput(args, env, now) {
  const raw = env[INPUT_ENV];
  // Prevent child processes from inheriting the input. This does not erase
  // Vercel's encrypted deployment snapshot; platform cleanup is still required.
  delete env[INPUT_ENV];
  ensure(args.length === 2 && new Set(args).size === 2 && args.includes('--execute') && args.includes('--operator-only'), 'EXPLICIT_FLAGS_REQUIRED');
  ensure(env.VERCEL === '1' && env.VERCEL_ENV === 'production', 'PRODUCTION_OPERATOR_BUILD_REQUIRED');
  ensure(typeof raw === 'string' && raw.length > 0 && raw.length <= 8192, 'INPUT_REQUIRED');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new OperatorError('INPUT_INVALID'); }
  ensure(payload && typeof payload === 'object' && !Array.isArray(payload), 'INPUT_INVALID');
  ensure(Object.keys(payload).length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every(key => typeof payload[key] === 'string'), 'INPUT_INVALID');
  ensure(/^[a-z0-9]{20}$/.test(payload.expectedProjectRef), 'PROJECT_REF_INVALID');
  ensure(/^[a-f0-9]{40}$/.test(payload.expectedCommit) && env.VERCEL_GIT_COMMIT_SHA === payload.expectedCommit, 'COMMIT_MISMATCH');
  ensure(/^[A-Za-z0-9_-]{16,120}$/.test(payload.operationId), 'OPERATION_ID_INVALID');
  ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.expiresAt), 'EXPIRY_INVALID');
  checkExpiry(payload.expiresAt, now);
  payload.email = payload.email.trim().toLowerCase();
  payload.name = payload.name.trim();
  ensure(payload.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email), 'EMAIL_INVALID');
  ensure(payload.name.length > 0 && payload.name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(payload.name), 'NAME_INVALID');
  // Do not trim or otherwise change the operator-supplied password.
  ensure(payload.password.length >= 12 && payload.password.length <= 128, 'PASSWORD_LENGTH_INVALID');
  const url = `https://${payload.expectedProjectRef}.supabase.co`;
  ensure(env.NEXT_PUBLIC_SUPABASE_URL === url || env.NEXT_PUBLIC_SUPABASE_URL === `${url}/`, 'SUPABASE_URL_MISMATCH');
  ensure(typeof env.SUPABASE_SECRET_KEY === 'string' && env.SUPABASE_SECRET_KEY.trim().length > 0 && !env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_'), 'SERVER_CREDENTIAL_REQUIRED');
  return { payload, url };
}

function isExactConfirmedUser(user, payload, now, expectedId) {
  return user && typeof user.id === 'string' && UUID.test(user.id)
    && (!expectedId || user.id === expectedId)
    && typeof user.email === 'string' && user.email.toLowerCase() === payload.email
    && user.user_metadata?.name === payload.name
    && typeof user.email_confirmed_at === 'string' && Number.isFinite(Date.parse(user.email_confirmed_at))
    && user.is_anonymous !== true && !user.deleted_at
    && (!user.banned_until || (Number.isFinite(Date.parse(user.banned_until)) && Date.parse(user.banned_until) <= now()));
}
function isExactOwner(member, payload, userId) {
  return member && member.userId === userId && typeof member.email === 'string' && member.email.toLowerCase() === payload.email
    && member.name === payload.name && member.role === 'OWNER' && member.active === true;
}

/** Dependency injection is for isolated tests; production uses the pinned SDK. */
export async function provisionPasswordOwner({ args, env, now = Date.now, clientFactory = createClient }) {
  const { payload, url } = readInput(args, env, now);
  try {
    const client = clientFactory(url, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, init) => {
          const destination = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
          ensure(destination.origin === url, 'UNEXPECTED_REQUEST_ORIGIN');
          return fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) });
        },
      },
    });
    const requireNoMembers = async () => {
      const status = await request(() => client.rpc('crm_bootstrap_status'), 'BOOTSTRAP_STATUS_FAILED');
      // The installed RPC returns a boolean. Null/objects are never interpreted
      // as an empty workspace. The grant RPC also checks business tables while
      // holding its workspace lock, so a concurrent bootstrap cannot win twice.
      ensure(status === false, 'WORKSPACE_NOT_EMPTY_OR_STATUS_INVALID');
    };
    await requireNoMembers();
    let checkedAllUsers = false;
    for (let page = 1; page <= 50; page++) {
      const data = await request(() => client.auth.admin.listUsers({ page, perPage: 200 }), 'AUTH_LIST_FAILED');
      ensure(data && Array.isArray(data.users) && data.users.every(user => user && typeof user === 'object'), 'AUTH_LIST_INVALID');
      ensure(!data.users.some(user => typeof user.email === 'string' && user.email.toLowerCase() === payload.email), 'AUTH_ACCOUNT_ALREADY_EXISTS');
      if (data.users.length < 200) { checkedAllUsers = true; break; }
    }
    ensure(checkedAllUsers, 'AUTH_LIST_LIMIT_REACHED');
    await requireNoMembers();
    checkExpiry(payload.expiresAt, now);
    const created = await request(() => client.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true,
      user_metadata: { name: payload.name },
    }), 'AUTH_CREATE_FAILED_REVIEW_STATE');
    payload.password = '';
    ensure(isExactConfirmedUser(created?.user, payload, now), 'CREATED_USER_MISMATCH_REVIEW_STATE');
    const userId = created.user.id;
    const verified = await request(() => client.auth.admin.getUserById(userId), 'AUTH_VERIFY_FAILED_REVIEW_STATE');
    ensure(isExactConfirmedUser(verified?.user, payload, now, userId), 'VERIFIED_USER_MISMATCH_REVIEW_STATE');
    await requireNoMembers();
    checkExpiry(payload.expiresAt, now);
    const owner = await request(() => client.rpc('crm_bootstrap_owner', { p_user_id: userId }), 'OWNER_GRANT_FAILED_REVIEW_STATE');
    ensure(isExactOwner(owner, payload, userId), 'OWNER_RESULT_MISMATCH_REVIEW_STATE');
    const workspace = await request(() => client.rpc('crm_workspace_read', { p_actor_id: userId, p_full_audit: false }), 'WORKSPACE_VERIFY_FAILED_REVIEW_STATE');
    ensure(isExactOwner(workspace?.user, payload, userId)
      && Array.isArray(workspace?.members) && workspace.members.length === 1 && isExactOwner(workspace.members[0], payload, userId)
      && ['customers', 'leads', 'followups', 'quotations', 'workorders'].every(key => Array.isArray(workspace[key]) && workspace[key].length === 0),
    'WORKSPACE_RESULT_MISMATCH_REVIEW_STATE');
    return { userId };
  } finally {
    payload.password = '';
  }
}

export async function runOperatorCli({ args = process.argv.slice(2), env = process.env, now, clientFactory, output = console.log } = {}) {
  try {
    const result = await provisionPasswordOwner({ args, env, now, clientFactory });
    output(`OWNER_SETUP_SUCCESS user_id=${result.userId}`);
    return OPERATOR_COMPLETE_EXIT;
  } catch (error) {
    // Never render SDK errors, request bodies, arbitrary messages or stacks.
    output(`OWNER_SETUP_FAILURE code=${error instanceof OperatorError ? error.code : 'UNEXPECTED_FAILURE_REVIEW_STATE'}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runOperatorCli();
}
