import assert from 'node:assert/strict';
import test from 'node:test';
import { changeOwnPassword, changePasswordSchema, setupPasswordSchema } from '../lib/password-policy.ts';
import { createPasswordSetupGrant, PASSWORD_SETUP_TTL_SECONDS, verifyPasswordSetupGrant } from '../lib/password-setup-policy.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const SESSION = '00000000-0000-4000-8000-000000000003';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const KEY = 'test-only-signing-value-never-a-real-credential';
const input = { currentPassword: 'old-fixture-password', password: 'new-fixture-password', confirmPassword: 'new-fixture-password' };

test('password settings enforce confirmation, length, current password, and reject target identity fields', () => {
  assert.equal(changePasswordSchema.safeParse(input).success, true);
  for (const invalid of [
    { ...input, currentPassword: '' }, { ...input, password: 'too-short', confirmPassword: 'too-short' },
    { ...input, password: 'a'.repeat(129), confirmPassword: 'a'.repeat(129) },
    { ...input, confirmPassword: 'different-fixture-value' },
    { ...input, password: input.currentPassword, confirmPassword: input.currentPassword },
    { ...input, email: 'another@example.invalid' }, { ...input, userId: OTHER },
  ]) assert.equal(changePasswordSchema.safeParse(invalid).success, false);
  assert.equal(setupPasswordSchema.safeParse({ password: input.password, confirmPassword: input.password }).success, true);
  assert.equal(setupPasswordSchema.safeParse({ password: input.password, confirmPassword: 'wrong' }).success, false);
});

function workflow() {
  const calls: string[] = [];
  let count = 0;
  const member = { userId: USER, email: 'owner@example.invalid', active: true };
  const dependencies = {
    currentMember: async () => { calls.push('member'); count++; return member; },
    reauthenticate: async (email: string, password: string) => {
      calls.push('reauthenticate'); assert.equal(email, member.email); assert.equal(password, input.currentPassword); return member;
    },
    update: async (password: string) => { calls.push('update'); assert.equal(password, input.password); return member; },
  };
  return { calls, dependencies, member, count: () => count };
}

test('own password change uses server identity and rechecks membership after reauthentication', async () => {
  const flow = workflow();
  await changeOwnPassword(input, flow.dependencies);
  assert.deepEqual(flow.calls, ['member', 'reauthenticate', 'member', 'update']);
});

test('invalid current password and a reauthenticated different identity never update a password', async () => {
  const wrongPassword = workflow();
  wrongPassword.dependencies.reauthenticate = async () => { throw new Error('incorrect current password'); };
  await assert.rejects(changeOwnPassword(input, wrongPassword.dependencies), /incorrect current password/);
  assert.equal(wrongPassword.calls.includes('update'), false);
  for (const changed of [{ userId: OTHER }, { email: 'different@example.invalid' }]) {
    const flow = workflow();
    flow.dependencies.reauthenticate = async () => ({ ...flow.member, ...changed });
    await assert.rejects(changeOwnPassword(input, flow.dependencies), /identity changed/);
    assert.equal(flow.calls.includes('update'), false);
  }
});

test('inactive membership and concurrent removal block password change before update', async () => {
  const removed = workflow(); removed.member.active = false;
  await assert.rejects(changeOwnPassword(input, removed.dependencies), /active workspace access/);
  assert.deepEqual(removed.calls, ['member']);
  const concurrent = workflow();
  concurrent.dependencies.reauthenticate = async () => { concurrent.member.active = false; return concurrent.member; };
  await assert.rejects(changeOwnPassword(input, concurrent.dependencies), /active workspace access/);
  assert.equal(concurrent.calls.includes('update'), false);
});

test('password provider failures and mismatched update responses are never reported as success', async () => {
  const rejected = workflow();
  rejected.dependencies.update = async () => { throw new Error('provider rejected password'); };
  await assert.rejects(changeOwnPassword(input, rejected.dependencies), /provider rejected/);
  const mismatched = workflow();
  mismatched.dependencies.update = async () => ({ ...mismatched.member, userId: OTHER });
  await assert.rejects(changeOwnPassword(input, mismatched.dependencies), /response could not be verified/);
});

test('recovery grant is valid only for the exact verified user and session', () => {
  const grant = createPasswordSetupGrant(USER, SESSION, KEY, NOW);
  assert.equal(verifyPasswordSetupGrant(grant, USER, SESSION, KEY, NOW), true);
  assert.equal(verifyPasswordSetupGrant(grant, OTHER, SESSION, KEY, NOW), false);
  assert.equal(verifyPasswordSetupGrant(grant, USER, OTHER, KEY, NOW), false);
  assert.equal(verifyPasswordSetupGrant(grant, USER, SESSION, `${KEY}-different`, NOW), false);
  assert.equal(verifyPasswordSetupGrant(undefined, USER, SESSION, KEY, NOW), false);
});

test('forged payloads, truncated signatures, malformed grants and oversized cookies fail closed', () => {
  const grant = createPasswordSetupGrant(USER, SESSION, KEY, NOW);
  const [payload, signature] = grant.split('.');
  const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), expiresAt: NOW / 1000 + 86400 })).toString('base64url');
  for (const tampered of [`${modified}.${signature}`, `${payload}.${signature.slice(0, -1)}`, `${grant}.extra`, 'invalid', 'x'.repeat(1025)]) {
    assert.equal(verifyPasswordSetupGrant(tampered, USER, SESSION, KEY, NOW), false);
  }
  assert.throws(() => createPasswordSetupGrant('invalid-id', SESSION, KEY, NOW));
});

test('recovery grant expires at 15 minutes and rejects grants created far in the future', () => {
  const grant = createPasswordSetupGrant(USER, SESSION, KEY, NOW);
  assert.equal(verifyPasswordSetupGrant(grant, USER, SESSION, KEY, NOW + (PASSWORD_SETUP_TTL_SECONDS - 1) * 1000), true);
  assert.equal(verifyPasswordSetupGrant(grant, USER, SESSION, KEY, NOW + PASSWORD_SETUP_TTL_SECONDS * 1000), false);
  assert.equal(verifyPasswordSetupGrant(grant, USER, SESSION, KEY, NOW - 31_000), false);
});
