# Deploy and onboard employees using Chrome

Only the administrator needs provider accounts. Employees receive the final CRM URL and their own private activation link.

## 1. Use the intended Vercel project

Use [smart-construction-dashboard](https://vercel.com/dash-board10/smart-construction-dashboard) in **DashBoard (`dash-board10`)**. It is linked to `odndashboard/SmartConstruction` with production branch `main`. The assigned production origin is `https://smart-construction-dashboard.vercel.app`. See [DEPLOYMENT_STATUS.md](DEPLOYMENT_STATUS.md) for the verified deployment and remaining setup work.

Leave the older `smart-construction-crm` project under `odnprints-6693s-projects` untouched. Use the existing Dashboard project for this installation.

For future Git relinking, use **Settings → Git**. Vercel's GitHub App must have access to the repository under `odndashboard`; access granted to the ChatGPT GitHub App is a separate permission.

Use the **Next.js** framework preset, **Node 24.x**, the repository root, install command `npm ci`, and build command `npm run build`. Keep the default Next.js output.

## 2. Verify the intended Supabase project and configure Auth

The selected database is **ODN → Smart Construction dashboard**, project [`ynyepmlpwpndpxwzqtcb`](https://supabase.com/dashboard/project/ynyepmlpwpndpxwzqtcb).

The SQL in `supabase/migrations/202611230001_crm.sql` has already been applied, recorded remotely as migration name `crm`, version `20261123115055`. **Do not run the initialization file again.** It is not idempotent. Retain the repository-to-remote version mapping in [DEPLOYMENT_STATUS.md](DEPLOYMENT_STATUS.md) when comparing future migration history.

For a separate installation, inspect the existing `crm` schema, CRM functions, and migration history first. Apply the entire initialization file once only when that CRM has not been initialized. Verify existing objects instead of dropping or recreating them.

The Supabase Data API must be enabled with `public` exposed so the server can call the restricted RPC functions. **Keep `crm` unexposed** and do not grant direct table access to `anon`, `authenticated`, or `service_role`. The existing RPC grants are deliberate.

In Authentication settings:

- Keep email/password sign-in enabled.
- Disable public registration and anonymous sign-in.
- Require passwords of at least 12 characters.
- Set the Site URL to `https://smart-construction-dashboard.vercel.app`.
- Allow the exact redirect `https://smart-construction-dashboard.vercel.app/auth/confirm`.

Configure a separate staging installation's origin and database independently.

The app generates manual invitation/recovery links. This version does not automatically email employee invitations; share each private link directly with its intended recipient.

## 3. Set Vercel environment variables

Open the intended project's [Vercel environment settings](https://vercel.com/dash-board10/smart-construction-dashboard/settings/environment-variables). All four Production variables below are configured, and a redeployment has verified that the login form is available. Keep the server key as a Production Secret when maintaining these settings:

| Key | Where its value comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project's Connect panel / API configuration |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable API key |
| `SUPABASE_SECRET_KEY` | Supabase secret API key — server only |
| `APP_URL` | Exact stable production origin, such as `https://your-crm.vercel.app` |

Use Production scope for the live database. Use a separate staging Supabase project for Preview/Development when testing changes. Older projects may use the legacy anon/service-role aliases documented in `.env.example`.

Enter the secret directly into Vercel; do not put it in GitHub or send it through chat. Redeploy after changing environment variables because the public configuration is embedded at build time.

## 4. Create and designate your Owner account

**This installation now has its designated, confirmed Owner. Production password login and Owner access have been verified. Do not rerun initialization.** The account-creation instructions below apply to a separately initialized installation or to an operator's documented recovery procedure.

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

An explicitly authorized password setup can use `scripts/setup-password-owner.mjs --execute --operator-only` inside a dedicated, non-serving Vercel Production administration build. This separate script requires an expiring `CRM_OWNER_SETUP_JSON` Production Secret and binds the operation to the expected project and exact source commit. It refuses an existing Owner or matching Auth account and never sends mail. Its deliberate success exit code is 78, so verify the success marker and database identity rather than interpreting the deployment's ERROR state as provisioning failure. Clear the temporary input and return to ordinary `main` source after execution. Do not put the command in normal build/install hooks or expose it through an HTTP route; do not automatically retry after a partial account creation.

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
