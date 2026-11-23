# CRM implementation contract — Vercel / Supabase

## Identity and access

- Supabase verifies the session server-side with `auth.getUser()`; cookie contents alone are not accepted as identity.
- CRM access additionally requires an active membership. Email/password authentication never creates membership automatically.
- Bootstrap selects one explicit `auth.users.id` through an operator-only, service-role RPC. There is no bootstrap HTTP route.
- Only an active Owner may add staff, change roles, generate staff recovery links, or disable access. Preserve the last active Owner and prevent self-deactivation.
- All active members share read/export visibility. Assignments are not row-level privacy boundaries.
- Never forward a browser-supplied actor ID to privileged persistence. Derive it from the verified session.

## Storage and atomicity

Business tables live in the private `crm` schema. They have RLS enabled and no anon/authenticated grants or permissive client policies. The browser never queries business tables directly. Public RPC wrappers are executable only by `service_role`, and also verify the server role claim. Use a distinct server-only Supabase admin client with no user-session cookies.

Every business mutation:

1. Verifies same-origin JSON submission and body limits.
2. Verifies identity and current active membership.
3. Checks an existing request receipt before reapplying business state transitions.
4. Validates the action-specific payload and role in TypeScript.
5. Acquires the singleton workspace lock in Postgres, rechecks current membership/action permissions and receipt, then compares the expected revision.
6. Writes related records, immutable document snapshots, counters, audit events, new revision and receipt in one transaction.

Failure rolls back the entire transaction. A reused request ID with a different actor, action or payload hash is rejected. A stale revision produces a refresh conflict. SQL migrations are operator actions, never request-time DDL.

## HTTP contract

`GET /api/workspace` returns `WorkspaceData` from `lib/types.ts`.

`POST /api/workspace` receives `{action,payload,expectedRevision,requestId}` and returns `{data,message}` or `{error}` with an appropriate status. Preserve the same request ID when retrying the same pending change after a network failure.

Business actions: `customer_save`, `lead_save`, `lead_status`, `followup_save`, `followup_complete`, `followup_cancel`, `quote_save`, `quote_issue`, `quote_accept`, `quote_decline`, `quote_revise`, `quote_convert`, `workorder_save`, `milestone_add`, `milestone_complete`, `company_save`, `member_role`, `member_active`, `load_demo`, `clear_demo`.

`GET /api/export` is authenticated and uses the same active-membership guard. All private responses and activation-link responses must be uncached.

## Financial invariants

- Retain exact paise arithmetic and safe-integer limits.
- Never substitute a universal GST rate or an invented registration.
- Issued quotations freeze the commercial parties, scope, rates and amounts.
- One accepted quotation produces at most one work order.
- Work orders retain the accepted quotation snapshot.
- Business record IDs, document numbers and historical snapshots must survive any explicit data migration.

## Deployment

Standard Next.js build/start on Vercel; no Cloudflare bindings, dispatch-auth headers, Vinext shims or in-memory production persistence. Required environment values are described in `.env.example`. An unconfigured deployment must fail closed with a setup-pending screen.

Never commit secrets, invitation links, real business exports, `.env.local`, `.vercel/`, or `private/`. The existing ChatGPT Site remains a separate deployment until data migration and employee acceptance testing are explicitly complete.
