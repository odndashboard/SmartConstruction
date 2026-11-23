/** Check configuration without printing key values. Does not contact providers. */
import { existsSync } from 'node:fs';

const issues = [];
const present = (value) => Boolean(value && !/YOUR_|SUBSTITUTE_|example\.(com|invalid)/i.test(value));
const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
function legacyKeyRole(value) {
  try {
    const parts = value?.split('.');
    return parts?.length === 3 ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role : undefined;
  } catch { return undefined; }
}
if (!present(publicKey)) issues.push('Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or the legacy anon key).');
if (!present(secretKey)) issues.push('Set SUPABASE_SECRET_KEY (or the legacy service role key), server only.');
if (publicKey && secretKey && publicKey === secretKey) issues.push('The public and server keys must be different.');
if (publicKey?.startsWith('sb_secret_') || legacyKeyRole(publicKey) === 'service_role') {
  issues.push('A secret key is incorrectly configured as a public key. Remove it and rotate it.');
}
if (secretKey?.startsWith('sb_publishable_') || legacyKeyRole(secretKey) === 'anon') {
  issues.push('The server key must be a secret or legacy service role key, not a public key.');
}
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'APP_URL']) {
  try {
    const raw = process.env[key];
    if (!present(raw)) throw new Error();
    const url = new URL(raw);
    const local = !process.env.VERCEL && process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error();
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error();
  } catch { issues.push(`Set ${key} to a valid HTTPS origin (HTTP is allowed only for localhost).`); }
}
if (!process.env.VERCEL && !existsSync('.vercel/project.json')) {
  issues.push('Link this checkout to its Vercel project before starting development or applying migrations.');
}
if (issues.length) {
  console.error('Configuration is incomplete:\n' + issues.map((issue) => `- ${issue}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log('Required configuration is present. No secret values were printed.');
  console.log('This verifies configuration only; database migration and authenticated sign-in still need verification.');
}
