import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSetupLink, configuredAppOrigin, isPublicSupabaseKey, parseAccountFragment, sameWorkspaceOrigin } from '../lib/auth-policy.ts';

test('public Supabase configuration accepts publishable keys and legacy anon keys only', () => {
  const legacy = (payload: unknown) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature`;
  assert.equal(isPublicSupabaseKey('sb_publishable_example_public_key'), true);
  assert.equal(isPublicSupabaseKey(legacy({ role: 'anon', ref: 'example' })), true);
  for (const misplaced of ['sb_secret_example_private_key', legacy({ role: 'service_role' }), legacy({ role: 'authenticated' }), legacy({}), legacy(null), 'not-an-api-key', 'sb_publishable_', 'x.not-valid-json.y']) {
    assert.equal(isPublicSupabaseKey(misplaced), false);
  }
});

test('production account links require a root HTTPS origin without embedded credentials or redirects', () => {
  assert.equal(configuredAppOrigin('https://crm.example.com/', true), 'https://crm.example.com');
  for (const unsafe of ['http://crm.example.com', 'http://localhost:3000', 'https://owner:secret@crm.example.com', 'https://crm.example.com/private', 'https://crm.example.com/?next=https://evil.example', 'https://crm.example.com/#token', 'javascript:alert(1)', '/relative']) {
    assert.throws(() => configuredAppOrigin(unsafe, true));
  }
});

test('development permits HTTP only for explicit local loopback hosts', () => {
  for (const local of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) assert.equal(configuredAppOrigin(local, false), local);
  assert.throws(() => configuredAppOrigin('http://crm.example.com', false));
  assert.throws(() => configuredAppOrigin('http://localhost.evil.example', false));
});

test('account mutations reject cross-origin requests and untrusted request hosts', () => {
  const origin = 'https://crm.example.com';
  assert.equal(sameWorkspaceOrigin(origin, `${origin}/api/auth/login`, origin, 'same-origin'), true);
  assert.equal(sameWorkspaceOrigin(origin, `${origin}/api/auth/login`, origin, null), true);
  for (const source of [null, 'null', 'https://evil.example', 'https://crm.example.com.evil.example', `${origin}/`]) {
    assert.equal(sameWorkspaceOrigin(source, `${origin}/api/team`, origin, 'same-origin'), false);
  }
  assert.equal(sameWorkspaceOrigin(origin, 'https://evil.example/api/team', origin, 'same-origin'), false);
  assert.equal(sameWorkspaceOrigin(origin, `${origin}/api/team`, origin, 'cross-site'), false);
});

test('activation and recovery bearer tokens stay only in fragments and have a fixed destination', () => {
  const token = 'a'.repeat(64);
  for (const type of ['invite', 'recovery'] as const) {
    const url = new URL(accountSetupLink('https://crm.example.com', token, type));
    assert.equal(url.pathname, '/auth/confirm');
    assert.equal(url.search, '');
    assert.deepEqual(parseAccountFragment(url.hash), { token_hash: token, type });
    assert.equal(`${url.origin}${url.pathname}${url.search}`.includes(token), false);
  }
});

test('malformed, duplicate, redirected and unsupported account links are rejected', () => {
  const token = 'b'.repeat(64);
  for (const fragment of ['', '#token_hash=short&type=invite', `#token_hash=${token}&type=signup`, `#token_hash=${token}&type=invite&type=recovery`, `#token_hash=${token}&token_hash=${token}&type=invite`, `#token_hash=${token}&type=invite&next=https://evil.example`, `#token_hash=%3Cscript%3E&type=recovery`]) assert.equal(parseAccountFragment(fragment), null);
  assert.throws(() => accountSetupLink('https://crm.example.com', 'short', 'invite'));
});
