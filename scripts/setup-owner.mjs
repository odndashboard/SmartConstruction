/**
 * Operator-only, one-time owner setup. There is deliberately no HTTP equivalent.
 * It never sends email and never invents, receives, or prints a user's password.
 */
import { parseArgs } from 'node:util';
import { mkdir, open } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const { values } = parseArgs({ options: {
    email: { type: 'string' }, name: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  }});
  if (values.help) {
    console.log('npm run owner:setup -- --email owner@your-company.in --name "Owner name"');
    console.log('Requires the SQL migration and Supabase server credentials. Creates one explicitly designated owner.');
    console.log('The private activation link is saved under private/; no email is sent.');
    return;
  }
  const email = (values.email || '').trim().toLowerCase();
  const name = (values.name || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Provide the owner’s real email using --email.');
  if (!name || name.length > 200) throw new Error('Provide the owner’s name using --name (up to 200 characters).');
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const rawAppUrl = process.env.APP_URL;
  if (!supabaseUrl || !secret || !rawAppUrl || /YOUR_|SUBSTITUTE_/.test(supabaseUrl + secret + rawAppUrl)) {
    throw new Error('Configure Supabase URL, server secret and APP_URL before running owner setup.');
  }
  const appUrl = new URL(rawAppUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname);
  if (appUrl.origin !== rawAppUrl.replace(/\/$/, '') || (appUrl.protocol !== 'https:' && !(local && appUrl.protocol === 'http:'))) {
    throw new Error('APP_URL must be the exact HTTPS application origin; localhost may use HTTP.');
  }
  const client = createClient(supabaseUrl, secret, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const status = await client.rpc('crm_bootstrap_status');
  if (status.error) throw new Error('Cannot check owner setup. Apply the Supabase migration and verify the server key.');
  if (status.data === true || status.data?.has_members === true) {
    throw new Error('An owner is already configured. Use Settings → Team in the CRM for further access changes.');
  }

  // Supabase Auth has no lookup-by-email admin method. Check all pages explicitly;
  // a large unrelated project must not cause duplicate or misidentified accounts.
  let existing;
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error('Cannot inspect existing authentication accounts. Verify the Supabase server key.');
    existing = data.users.find((user) => user.email?.toLowerCase() === email);
    if (existing || data.users.length < 200) break;
  }

  // Reserve a writable private destination before creating an Auth user or
  // granting the one-time owner role. A file-write failure must not strand setup.
  await mkdir('private', { recursive: true, mode: 0o700 });
  const filename = `private/owner-access-${Date.now()}.txt`;
  const file = await open(filename, 'wx', 0o600);
  try {
    const type = existing?.email_confirmed_at ? 'recovery' : 'invite';
    const generated = await client.auth.admin.generateLink({
      type, email,
      options: { data: { name }, redirectTo: `${appUrl.origin}/auth/confirm` },
    });
    if (generated.error || !generated.data.user?.id || !generated.data.properties?.hashed_token) {
      throw new Error('Could not create the owner activation link. Check the Supabase authentication configuration.');
    }
    const userId = generated.data.user.id;
    if (generated.data.user.email?.toLowerCase() !== email || (existing && existing.id !== userId)) {
      throw new Error('The returned authentication account did not match the designated owner. No membership was granted.');
    }
    const tokenHash = generated.data.properties.hashed_token;
    const link = `${appUrl.origin}/auth/confirm#token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;
    const instructions = 'Use this link only after the setup command reports success.\nOpen it privately, confirm it, and choose your own password.\nDo not share it with another person. Delete this file after use.\n';
    // Keep the bearer link out of shell logs/history, the repository and deployment.
    await file.writeFile(`${instructions}\n${link}\n`);
    await file.sync();
    const bootstrapped = await client.rpc('crm_bootstrap_owner', { p_user_id: userId });
    if (bootstrapped.error) {
      throw new Error('Owner setup was not applied. The workspace may already have an owner; check its membership before retrying. Any newly prepared Auth account has no CRM access without membership.');
    }
    console.log('The designated owner membership is configured.');
    console.log(`Private access instructions saved to ${filename}. No email was sent and no key was printed.`);
  } finally { await file.close(); }
}

main().catch((error) => {
  // Only locally constructed messages above are safe to print; SDK failures are
  // caught before reaching here. Unexpected errors are kept free of credentials.
  const safe = error instanceof Error && !/https?:\/\/|sb_secret_|eyJ/.test(error.message)
    ? error.message : 'Owner setup could not finish. Check configuration without sharing secret values.';
  console.error(safe);
  process.exitCode = 1;
});
