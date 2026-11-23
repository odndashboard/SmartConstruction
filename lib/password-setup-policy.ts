// Server cryptography isolated from cookies so its security boundaries can be tested.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PASSWORD_SETUP_TTL_SECONDS = 15 * 60;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSE = 'smart-construction:password-setup:v1:';

export function createPasswordSetupGrant(userId: string, sessionId: string, secret: string, now = Date.now()): string {
  if (!ID.test(userId) || !ID.test(sessionId) || !secret) throw new Error('Password setup could not be prepared.');
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, userId, sessionId, issuedAt, expiresAt: issuedAt + PASSWORD_SETUP_TTL_SECONDS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(PURPOSE + payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyPasswordSetupGrant(token: string | undefined, userId: string, sessionId: string, secret: string, now = Date.now()): boolean {
  if (!token || token.length > 1024 || !secret || !ID.test(userId) || !ID.test(sessionId)) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return false;
  const expected = createHmac('sha256', secret).update(PURPOSE + parts[0]).digest();
  const received = Buffer.from(parts[1], 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  try {
    const grant: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return false;
    const value = grant as Record<string, unknown>;
    const time = Math.floor(now / 1000);
    return Object.keys(value).length === 5 && value.v === 1 && value.userId === userId && value.sessionId === sessionId
      && typeof value.issuedAt === 'number' && Number.isSafeInteger(value.issuedAt)
      && typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt)
      && value.expiresAt === value.issuedAt + PASSWORD_SETUP_TTL_SECONDS
      && value.issuedAt <= time + 30 && value.expiresAt > time;
  } catch { return false; }
}
