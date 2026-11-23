/** Pure account-link and origin checks shared by server handlers and the UI. */
export type AccountLink = { token_hash: string; type: 'invite' | 'recovery' };
export const ACCOUNT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,512}$/;

/**
 * Reject misplaced server credentials in public configuration. This inspects
 * legacy JWT metadata only to classify a configured API key; it never verifies
 * a session or grants authorization. Supabase still verifies every credential.
 */
export function isPublicSupabaseKey(value: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;
  if (value.startsWith('sb_secret_')) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const encoded = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return Boolean(payload && typeof payload === 'object' && !Array.isArray(payload) && 'role' in payload && payload.role === 'anon');
  } catch { return false; }
}

export function configuredAppOrigin(value: string, production: boolean): string {
  const url = new URL(value);
  const local = !production && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Configure a root HTTPS origin.');
  }
  return url.origin;
}

export function sameWorkspaceOrigin(source: string | null, requestUrl: string, expectedOrigin: string, fetchSite: string | null): boolean {
  try { return Boolean(source) && source === expectedOrigin && source === new URL(requestUrl).origin && fetchSite !== 'cross-site'; }
  catch { return false; }
}

export function parseAccountFragment(fragment: string): AccountLink | null {
  const params = new URLSearchParams(fragment.startsWith('#') ? fragment.slice(1) : fragment);
  if ([...params.keys()].length !== 2 || params.getAll('token_hash').length !== 1 || params.getAll('type').length !== 1) return null;
  const hash = params.get('token_hash') || '', type = params.get('type');
  if (!ACCOUNT_TOKEN_PATTERN.test(hash) || (type !== 'invite' && type !== 'recovery')) return null;
  return { token_hash: hash, type };
}

export function accountSetupLink(origin: string, hash: string, type: 'invite' | 'recovery'): string {
  if (!ACCOUNT_TOKEN_PATTERN.test(hash) || !['invite', 'recovery'].includes(type)) throw new Error('Invalid account link.');
  const url = new URL('/auth/confirm', origin);
  url.hash = new URLSearchParams({ token_hash: hash, type }).toString();
  return url.toString();
}
