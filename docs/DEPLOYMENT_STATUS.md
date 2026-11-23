# Deployment status — 23 November 2026

## Intended destination

- Repository: [odndashboard/SmartConstruction](https://github.com/odndashboard/SmartConstruction), branch `main`.
- Vercel team selected by the user: **`dash-board10`** ([team settings](https://vercel.com/dash-board10/~/settings)).
- Target team ID reported by Vercel: `team_AYTyR9qg0mp8KhJogq2T3x8y`.
- Supabase project selected by the user: **`ynyepmlpwpndpxwzqtcb`** ([SQL Editor](https://supabase.com/dashboard/project/ynyepmlpwpndpxwzqtcb/sql)).
- Goal: employees sign into the CRM with their own email/password on mobile or computer, without ChatGPT, GitHub, Vercel, or Supabase accounts.

This destination supersedes the earlier setup deployment's account references. **No working employee URL under `dash-board10` has been verified.**

## Prepared and verified

- Application source commit: `71ecb4bf3145fdcce1f0e55d38aabab299366e71`.
- Predeployment review confirmed `main` at `698b10ee0d6810239fdce9d363d39366f8f5d2f0`; that commit changes documentation only.
- Local checks previously passed: 60 tests, clean lint, successful Next.js 16.4.6 production build, and zero reported production dependency vulnerabilities.
- The [SQL migration](../supabase/migrations/202611230001_crm.sql), [deployment guide](DEPLOYMENT.md), environment template, and Owner bootstrap script were reviewed again before attempting account setup.
- The selected Supabase project's live database and Auth configuration have not been inspected or changed by this deployment session.

## Confirmed access blockers

The connected Vercel identity is `odnprints-6693`. Its team listing exposes only `odnprints-6693s-projects`.

A project lookup explicitly scoped to `dash-board10` returned **403: not authorized**. Vercel suggested its team-consent flow. That flow was attempted with both the exact team ID returned by Vercel and the user-supplied slug; both attempts returned **404: Team not found**. No consent link was issued and access was not granted.

The Chrome connection available to this conversation also returned: “Browser access requires the originating browser context.” Being signed into Vercel in a separate Chrome window does not establish access for this connection.

No Supabase connection is available in this conversation. The Supabase integration was offered for installation/connection; no successful connection has yet been verified.

To resume, establish Vercel access through an identity authorized for `dash-board10`, and grant Supabase access to `ynyepmlpwpndpxwzqtcb`. Retry the same explicitly scoped requests after connection. Do not substitute another Vercel team.

## Previous setup deployment — leave untouched

The following deployment was prepared under a different account before the intended destination was clarified:

- Vercel project: [smart-construction-crm](https://vercel.com/odnprints-6693s-projects/smart-construction-crm).
- Address: [smart-construction-crm.vercel.app](https://smart-construction-crm.vercel.app).
- Deployment: `dpl_AMfKodeMzr1pW5wXTpjVkGMSQQPb`, previously reported **READY**.
- Its hosted build succeeded; an authenticated Vercel fetch previously returned HTTP 200 and the setup-pending screen.
- Its existing Vercel deployment protection remains as last observed. Employee sign-in and shared business storage were not configured.
- A production `APP_URL` was set there after deployment. That value must not be reused for the new destination.
- Its source was deployed directly through the Vercel API. Automatic GitHub deployments were not established.

Do not delete, transfer, configure, or use this older project as the employee destination without a separate user instruction.

## Resume deployment after access is established

1. Inspect existing projects in `dash-board10` to avoid creating a duplicate. Import or link `odndashboard/SmartConstruction`, branch `main`, from the repository root. Use Next.js, Node 24.x, `npm ci`, and `npm run build`. Record the actual stable production origin.
2. Confirm the selected Supabase project and inspect its existing `crm` objects and `public.crm_*` functions before running SQL. The 545-line migration is one transaction but **is not repeatable/idempotent**. Run it once only if the intended CRM has not been initialized. Never drop existing objects to make it run.
3. Configure the four production variables from the verified project settings: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, server-only `SUPABASE_SECRET_KEY`, and `APP_URL` set to the exact new production HTTPS origin. Legacy aliases are documented in [.env.example](../.env.example). Keep secret values out of chat, GitHub, and logs; do not give preview deployments the production credentials.
4. Apply or verify the schema after project linkage and environment configuration. Expected result: nine private `crm` tables with RLS and seven public RPCs restricted to `service_role`. Keep `crm` unexposed in the Data API.
5. Enable email/password authentication, disable public registration for the intended CRM project, require passwords of at least 12 characters, set the Auth Site URL to the production origin, and allow the exact `<APP_URL>/auth/confirm` redirect. Check for unrelated applications before changing shared Auth settings.
6. Redeploy with the production configuration. Create or identify the explicitly designated Owner Auth user, then bootstrap its exact UUID using [DEPLOYMENT.md](DEPLOYMENT.md). The user has not yet designated the Owner email in this conversation; do not infer it from GitHub or Vercel account identities. If membership already exists, inspect it instead of resetting or rerunning bootstrap.
7. Complete live verification before onboarding staff: Owner and employee login/logout, activation/password changes, role restrictions, disabled-user access with an existing session, lead and follow-up persistence, quotation acceptance into exactly one work order, stale-revision conflicts, and mobile/desktop use.
8. Configure production deployment protection so the stable CRM URL reaches the application's login without a Vercel account. Add real employees only after verification and share each private setup link with its intended employee. The application does not automatically email invitations.

All active CRM members currently read/export the whole workspace; assignments do not restrict record visibility. Confirm actual company GSTIN and state details before issuing real GST quotations.

No real employee accounts have been created or invitations sent by this deployment session. No original ChatGPT Site database records have been copied. If records must be retained, follow [MIGRATION.md](MIGRATION.md) before switching staff.
