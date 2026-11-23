# Deployment status — 23 November 2026

**The CRM is deployed in the intended Vercel team. Its explicitly designated Owner account has been created, confirmed, and verified through a real production login. Employee onboarding checks and the remaining provider Auth settings are still pending.**

## Owner account creation and access verified

- Supabase now contains one Auth user, one active CRM member, and one active **OWNER**. The exact designated email and display name were independently matched; account confirmation is complete.
- The account was created through Supabase's server-side Auth Admin API using the password explicitly supplied by the user. The existing guarded `crm_bootstrap_owner` RPC assigned its exact UUID. No invitation or recovery email was sent.
- A fresh HTTPS session on the production CRM verified: unauthenticated workspace access **401**, password sign-in **200**, authenticated workspace read **200**, role **OWNER**, active membership, dashboard route **200**, sign-out **200**, and workspace access **401** after sign-out.
- Login and workspace responses use no-store caching. The workspace is revision **1**, with one member and no business records.
- This verifies password authentication and server-side Owner access. It does not claim browser visual/mobile acceptance or employee-role workflow testing.

### Operator execution and cleanup

The generic `scripts/setup-password-owner.mjs` is separate from application routes and normal build/install commands. It requires both explicit flags, a Production context, the expected project/commit, and an expiring input. It refuses existing membership or a matching pre-existing Auth account and verifies the created identity before and after granting the Owner role.

The isolated operator source was commit `b2966b3d2e4e8ca9b883ec02349fdcf17a36aad7`; it was never made the `main` branch. Deployment `dpl_B9HLxyraLs67iFt9YA6hcS5ofj4F` emitted the verified success marker and intentionally exited **78**, leaving an **ERROR** deployment without a serving application build. This expected status prevents the temporary password input from being included in a live application deployment.

The temporary Production Secret `CRM_OWNER_SETUP_JSON` was replaced with the noncredential value `DISABLED`. The server key was not retrieved or printed, no credentials were committed, and normal `main` source retains `npm run build`. Historical deployment snapshots are immutable; replacement does not prove erasure of the encrypted input from the non-serving operator deployment. Deleting that historical deployment and the now-disabled variable through the Vercel dashboard is the fuller cleanup option; those delete methods were unavailable in the connected tools.

The updated test suite passed **71 tests**, including 11 focused operator tests, with clean targeted lint. No application workflow code or database schema was changed during Owner provisioning.

## Verified destination

| Component | Verified destination |
|---|---|
| Repository | [odndashboard/SmartConstruction](https://github.com/odndashboard/SmartConstruction), production branch `main` |
| Vercel team | **DashBoard — `dash-board10`** |
| Vercel project | [smart-construction-dashboard](https://vercel.com/dash-board10/smart-construction-dashboard) |
| Project ID | `prj_3NKVhtMYQg2FZOT6Htt4IkFP8O3G` |
| Production address | [smart-construction-dashboard.vercel.app](https://smart-construction-dashboard.vercel.app) |
| Supabase | **ODN → Smart Construction dashboard** |
| Supabase project | [`ynyepmlpwpndpxwzqtcb`](https://supabase.com/dashboard/project/ynyepmlpwpndpxwzqtcb), `ACTIVE_HEALTHY` |

The user approved the Vercel team grant. Both Dashboard connections are verified. The Vercel project is linked to the intended GitHub repository.

## Earlier verification after the private key was saved

- All four required Production environment variable names are present. `SUPABASE_SECRET_KEY` is stored as a Vercel Production Secret (`sensitive`); its value was not retrieved or printed.
- Redeployment `dpl_5TyVnMas9HWDoRG4Ltw3g4h7uRgJ` reached **READY** with target **production**, using source commit `9285d807d38708c71aed49e6ca6111698fb893cf`.
- A fresh unauthenticated HTTPS request to `https://smart-construction-dashboard.vercel.app/login` returned **HTTP 200** on the CRM domain, with email and password fields and without the setup-pending message.
- Reaching the production login page does not require a Vercel account. No deployment-protection settings were changed for this check.
- Before Owner provisioning, Supabase had zero Auth users, zero CRM members, and zero active Owners.
- Supabase's public Auth settings report email sign-in enabled, anonymous sign-in disabled, email confirmation required, and **public registration still enabled**.
- The public Auth settings endpoint does not expose minimum password length, Site URL, or redirect allowlist; those settings remain unverified.

This earlier login-form check established that the application configuration gate passes. The later Owner session verification above also exercised the server key and private CRM RPCs; employee access acceptance remains pending.

## First verified deployment

- Source commit: `81cf414081e660c7a069a6c907539278b4d620eb`.
- Deployment ID: `dpl_8JYLvyZDtXBf9SSJJocYef7Wgghs`.
- Deployment URL: `https://smart-construction-dashboard-1weyx9qer-dash-board10.vercel.app`.
- Vercel reported **READY**, with target **production**, Next.js, and Node **24.x**.
- An authenticated Vercel fetch of the production address returned **HTTP 200** and the expected setup-pending page.
- Vercel deployment protection remains enabled with `all_except_custom_domains`.

This initial check verified the hosted build and setup-page response. Public login and an authenticated Owner session were subsequently verified above.

The application code is unchanged from the previously validated implementation: 60 passing tests, clean lint, a successful Next.js 16.4.6 production build, and zero reported production dependency vulnerabilities. Those local checks were not repeated for documentation-only changes.

## Supabase migration completed

The selected project had no CRM schema, CRM functions, migrations, or Auth users before initialization. The existing [CRM SQL migration](../supabase/migrations/202611230001_crm.sql) was applied successfully.

| Migration identifier | Recorded value |
|---|---|
| Repository file | `supabase/migrations/202611230001_crm.sql` |
| Source blob | `52996302b7d00eb29faf4a7b8b741e3218ef8e53` |
| Remote migration name | `crm` |
| Remote migration version | `20261123115055` |

**The initialization SQL has already run and is not idempotent.** Preserve this mapping when comparing repository files with remote migration history. Reconcile the different version identifiers deliberately before adopting CLI migration workflows; do not rerun initialization or automatically repair history.

Live SQL verification confirmed:

- Nine private `crm` tables, each with row-level security enabled.
- No direct CRM schema/table privileges for `anon`, `authenticated`, or `service_role`.
- Seven public CRM RPCs with `SECURITY DEFINER`, empty `search_path`, and execution allowed only for `service_role` among application roles.
- Workspace defaults: **smart construction**, **INR**, **Asia/Kolkata**, revision **0**.
- Zero business records, CRM members, and Auth users.
- Owner bootstrap status: **false**.

Security advisors reported nine informational `rls_enabled_no_policy` notices and no warning or error findings. The notices match the private server-only design: direct table access is deliberately denied, and the server uses restricted RPCs.

## Production environment configuration

| Variable | Verified status |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Present; selected project's verified URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Present; modern publishable key |
| `APP_URL` | Present; `https://smart-construction-dashboard.vercel.app` |
| `SUPABASE_SECRET_KEY` | Present; Production Secret (`sensitive`), value not read |

The production redeployment after the private key was saved loaded the updated configuration and rendered the login form. Future environment changes also require a new deployment.

The connected Supabase methods do not edit hosted Auth configuration or create Auth users. The designated Owner was instead created through the supported Auth Admin API inside the existing Vercel server environment, as recorded above. The Chrome connection remains unavailable to this conversation. Complete remaining provider Auth settings in the Supabase dashboard; keep private keys and account credentials out of source control, logs, and preview environments.

## Remaining work

1. Disable public registration in Supabase Auth. Verify email/password remains enabled, anonymous sign-in remains disabled, the minimum password length is at least 12, Site URL is `https://smart-construction-dashboard.vercel.app`, and the exact allowed redirect is `https://smart-construction-dashboard.vercel.app/auth/confirm`.
2. Verify employee activation and password flows, permissions, disabled-member access, shared persistence, quotation-to-work-order conversion, concurrent edits, and mobile/desktop behavior. Owner password login and sign-out already passed.
3. Onboard real employees after those checks pass through Settings → Team & roles. Preserve access to the CRM login without requiring a Vercel account.

## Previous installation and records

The older [smart-construction-crm project under odnprints-6693s-projects](https://vercel.com/odnprints-6693s-projects/smart-construction-crm) was left untouched. It is not the intended employee deployment.

No real employees were created and no invitations were sent. No original ChatGPT Site records were copied; follow [MIGRATION.md](MIGRATION.md) if records must be retained.

All active CRM roles can read and export the workspace; assignments do not restrict visibility. Complete the actual company GSTIN and state details before issuing real GST quotations.
