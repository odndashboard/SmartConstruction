# Deploy and onboard employees using Chrome

Only the administrator needs provider accounts. Employees receive the final CRM URL and their own private activation link.

## 1. Connect the GitHub repository to Vercel

A Vercel project has already been prepared: [smart-construction-crm](https://vercel.com/odnprints-6693s-projects/smart-construction-crm). Open that existing project and use **Settings → Git** to connect `odndashboard/SmartConstruction`; do not create a second project for this installation. See [DEPLOYMENT_STATUS.md](DEPLOYMENT_STATUS.md) for its current setup state.

For a separate installation in another account, use **Add New → Project** and import the repository.

If it is missing from the list, use Vercel's GitHub access/installation control and grant the **Vercel GitHub App** access to this repository under `odndashboard`. Granting the ChatGPT GitHub App access is a separate permission and does not grant Vercel access.

Use the **Next.js** framework preset, the repository root, install command `npm ci`, and build command `npm run build`. Do not select static export or a `dist` output directory. Record the stable production domain Vercel assigns to the project.

## 2. Prepare the intended Supabase project

Open the Supabase project you want to use for the CRM. Use a new/dedicated database if the current project belongs to another application.

In the project's SQL Editor, open and run the entire file in `supabase/migrations/` ending in `_crm.sql`. The migration is one transaction. It creates the private `crm` schema and restricted public RPC functions; it does not seed sample customers or public access policies.

The Supabase Data API must be enabled with `public` exposed so the server can call those RPC functions. **Do not expose the `crm` schema** and do not grant anon/authenticated access to its tables or RPCs.

In Authentication settings, keep email/password sign-in enabled and disable public signups. Set a minimum password length of at least 12 characters. Configure the Site URL to the stable CRM origin and add the exact `/auth/confirm` URL to the allowed redirect list. If using a staging deployment, configure its exact origin separately.

The app creates manual invitation/recovery links; Supabase's default email service is not a production employee mail service. Do not promise that an invitation was emailed when using this version.

## 3. Set Vercel environment variables

In Vercel **Project → Settings → Environment Variables**, add:

| Key | Where its value comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project's Connect panel / API configuration |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable API key |
| `SUPABASE_SECRET_KEY` | Supabase secret API key — server only |
| `APP_URL` | Exact stable production origin, such as `https://your-crm.vercel.app` |

Use Production scope for the live database. Use a separate staging Supabase project for Preview/Development when testing changes. Older projects may use the legacy anon/service-role aliases documented in `.env.example`.

Enter the secret directly into Vercel; do not put it in GitHub or send it through chat. Redeploy after changing environment variables because the public configuration is embedded at build time.

## 4. Create and designate your Owner account

In Supabase **Authentication → Users**, use **Add user / Create user** to create your own account with your real email and a password that you choose privately. Use the dashboard's confirmation option for this administrator-created account. Copy its exact user UUID.

Run the following in that project's SQL Editor, replacing the placeholder with your own user UUID. This is an administrator operation, performed once. The transaction assumes the SQL Editor's database administrator can set the built-in `service_role` role. It cannot be run by a website visitor.

```sql
begin;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.crm_bootstrap_owner('PASTE_YOUR_AUTH_USER_UUID'::uuid);
commit;
```

The function refuses to bootstrap if any CRM membership already exists. It does not choose an account based on who visits first. If the function reports that the workspace is already initialized, sign in as the existing Owner rather than clearing tables.

Open the CRM domain and sign in with your own email/password. Confirm your role is **Owner**, then complete the company details in Settings. This establishes the administrator before admitting employees.

If a terminal is available, `npm run owner:setup -- --email ... --name ...` provides a private activation-link alternative to the dashboard account creation step.

## 5. Add your employees

1. Open **Settings → Team** as Owner.
2. Add the employee's real name and email and choose the appropriate role.
3. Copy their private activation link and share it directly with that employee. Treat it as a temporary credential; do not post it to a group or commit it anywhere.
4. The employee opens the link, explicitly confirms it, and chooses a password of at least 12 characters.
5. After activation they use the normal CRM URL and email/password on mobile or computer. They can bookmark the site or use their browser's Add to Home Screen option where available.

For an expired link or forgotten password, the Owner can generate a fresh recovery link from Team. No outgoing email is sent by this operation. Disable an employee in Team when their access should end; reassignment of their existing work is a separate business action.

Recommended starting roles: you as Owner, a trusted supervisor as Manager, enquiry staff as Sales, and site coordinators as Operations. Viewer can read and export all workspace records. All active roles have full workspace visibility.

## 6. Verify before staff use real records

Use synthetic records for this check. Sign in as the Owner and as a separate employee in another browser profile. Verify that the employee can use only their role's actions, that they cannot change team access, and that disabling their membership immediately blocks the next API read/write. Verify sign-out and opening a fresh activation link on another device.

Create a lead, complete a follow-up with an outcome, prepare a quotation with your verified GST configuration, accept it and convert it into one work order. Retry the conversion to confirm a second work order is not created. Confirm data is shared across two devices and survives refresh.

Test two overlapping edits and the stale-change conflict; do not assume a successful build proves hosted database behavior. Confirm the public production URL can reach the CRM login without requiring a Vercel login. Preview deployment protection is separate from employee authentication.

Choose and verify a Supabase backup/recovery arrangement appropriate to the provider plan. A CRM JSON export is a useful business snapshot, but is not a complete backup of Supabase Auth accounts, configuration or credentials.

## Existing Site records

If the old ChatGPT Site contains business records, use [MIGRATION.md](MIGRATION.md) before switching the team over. A new deployment starts with the new database; existing Site data is not copied automatically.
