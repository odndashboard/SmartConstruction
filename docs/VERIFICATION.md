# Verification record — 23 November 2026

## Checked locally

| Check | Result |
|---|---|
| `npm run lint` | Passed; no errors or warnings |
| `npm test` | 60 passed, 0 failed, 0 skipped |
| `npm run build` | Passed, including Next.js TypeScript validation |
| `npm audit --omit=dev` | 0 reported production dependency vulnerabilities |
| `git diff --check` | Passed |
| Operator script syntax / `--help` | Passed; no provider mutations executed |

Runtime: Node.js 24.22.3. Application: Next.js 16.4.6, React 19.2.6, Zod 4.6.7, Supabase JS 2.119.2, Supabase SSR 0.12.7.

## Test scope

- 20 financial tests cover paise arithmetic, component rounding, jurisdiction selection, registration/input boundaries and Indian financial-year dates.
- 21 business tests cover role permissions, strict input schemas, quotation issue/accept/revision, one-time work-order conversion, follow-up outcomes, delivery transitions, example data and employee activation.
- 6 authentication-policy tests cover public-key configuration, HTTPS origins, same-origin requests, private fragment links and malformed or redirected links.
- 13 database integration tests execute the complete migration and real PostgreSQL RPCs using PGlite. They cover execution grants, RLS, explicit owner bootstrap, active-membership checks, receipts, atomic rollback, stale revisions, immutable snapshots and duplicate conversion prevention.

The database harness creates synthetic Auth users and roles. It does not contact the live Supabase project. Its single PostgreSQL connection cannot prove hosted multi-connection contention behavior.

## Still required after provider setup

The real Supabase project has not been configured by these local checks. Employee activation, password login, cookie refresh, revocation on a second device, and overlapping live requests must be exercised against the actual configured deployment. A setup-pending page is expected until environment variables and the SQL migration are present.

No employee invitations were sent, no real Auth users were created, and no existing ChatGPT Site business data was imported. See `DEPLOYMENT.md` and `MIGRATION.md` before staff begin using real records.

Dependency audit results describe the advisory database at the time of the check; they are not a guarantee against future vulnerabilities.
