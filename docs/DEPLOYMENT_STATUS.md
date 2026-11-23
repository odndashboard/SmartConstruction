# Deployment status — 23 November 2026

**The CRM is deployed in the intended Vercel team, its database is initialized, and its production login form is available. Owner account creation and authenticated employee verification remain pending.**

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

## Verification after the private key was saved

- All four required Production environment variable names are present. `SUPABASE_SECRET_KEY` is stored as a Vercel Production Secret (`sensitive`); its value was not retrieved or printed.
- Redeployment `dpl_5TyVnMas9HWDoRG4Ltw3g4h7uRgJ` reached **READY** with target **production**, using source commit `9285d807d38708c71aed49e6ca6111698fb893cf`.
- A fresh unauthenticated HTTPS request to `https://smart-construction-dashboard.vercel.app/login` returned **HTTP 200** on the CRM domain, with email and password fields and without the setup-pending message.
- Reaching the production login page does not require a Vercel account. No deployment-protection settings were changed for this check.
- Supabase still has zero Auth users, zero CRM members, and zero active Owners.
- Supabase's public Auth settings report email sign-in enabled, anonymous sign-in disabled, email confirmation required, and **public registration still enabled**.
- The public Auth settings endpoint does not expose minimum password length, Site URL, or redirect allowlist; those settings remain unverified.

The login-form check establishes that the application configuration gate passes. It does not verify the server key's permissions through a real authenticated CRM session or establish working employee access.

## First verified deployment

- Source commit: `81cf414081e660c7a069a6c907539278b4d620eb`.
- Deployment ID: `dpl_8JYLvyZDtXBf9SSJJocYef7Wgghs`.
- Deployment URL: `https://smart-construction-dashboard-1weyx9qer-dash-board10.vercel.app`.
- Vercel reported **READY**, with target **production**, Next.js, and Node **24.x**.
- An authenticated Vercel fetch of the production address returned **HTTP 200** and the expected setup-pending page.
- Vercel deployment protection remains enabled with `all_except_custom_domains`.

This verifies the hosted build and setup-page response. Real authentication and access without a Vercel account remain unverified.

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

The available Supabase methods do not edit hosted Auth configuration or create Auth users. The Chrome connection remains unavailable to this conversation. Complete those provider settings in the Supabase dashboard; keep passwords and private key values out of chat, source control, logs, and preview environments.

## Remaining work

1. Disable public registration in Supabase Auth. Verify email/password remains enabled, anonymous sign-in remains disabled, the minimum password length is at least 12, Site URL is `https://smart-construction-dashboard.vercel.app`, and the exact allowed redirect is `https://smart-construction-dashboard.vercel.app/auth/confirm`.
2. Create the explicitly designated Owner through Supabase Auth and bootstrap its exact UUID using [DEPLOYMENT.md](DEPLOYMENT.md). The Owner email has not been designated; provider account identities are not an Owner selection.
3. Verify Owner/employee login, activation and password flows, permissions, disabled-member access, shared persistence, quotation-to-work-order conversion, concurrent edits, and mobile/desktop behavior.
4. Onboard real employees after those checks pass. Preserve access to the CRM login without requiring a Vercel account.

## Previous installation and records

The older [smart-construction-crm project under odnprints-6693s-projects](https://vercel.com/odnprints-6693s-projects/smart-construction-crm) was left untouched. It is not the intended employee deployment.

No real employees were created and no invitations were sent. No original ChatGPT Site records were copied; follow [MIGRATION.md](MIGRATION.md) if records must be retained.

All active CRM roles can read and export the workspace; assignments do not restrict visibility. Complete the actual company GSTIN and state details before issuing real GST quotations.
