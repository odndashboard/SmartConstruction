# Stock, attendance and expenses

These modules extend the existing Smart Construction CRM. They share the same employee accounts, mobile and desktop interface, and live website used by the Android application. The existing `OWNER` role is the administrator for these modules. A `MANAGER` is an employee for attendance and expense privacy.

## Access rules

| Action | Owner/admin | Manager, Sales, Operations | Viewer |
| --- | --- | --- | --- |
| View stock and its movement history | Yes | Yes | Yes |
| Create a stock item; record stock in/out | Yes | Yes | No |
| Edit existing stock details; correct a balance; archive an empty item | Yes | No | No |
| View attendance | Entire team | Own records | Own records |
| Check in and check out | Own account | Own account | No |
| Correct attendance or mark leave/absence | Any team member | No | No |
| Enter an expense | Own account | Own account | No |
| View expenses | All employees | Own entries only | Own entries only |
| Approve, reject or mark an expense paid | Yes | No | No |
| View company expense totals | Yes | No | No |
| View team activity and audit history | Yes | No | No |

Every operation requires an active, confirmed CRM membership. Removing a member blocks these modules as well as the original CRM. A role selected in the interface or passed in a request never establishes authority.

## Stock

Each material has a stock code, name, unit, location and reorder level. Quantities support up to three decimal places. Stock balances use integer thousandths in storage and calculations.

The inventory shows **Received**, **Used**, **Adjustments** and **Remaining** for each material. Received/used/adjusted figures come from the complete movement ledger, including opening stock, independently of the selected history month. Received minus used plus adjustments equals the remaining balance. These cumulative quantities use exact integer strings so a long history does not lose precision. Different units are never added into one misleading total.

Stock in and stock out append an immutable movement record. A stock-out transaction cannot make the balance negative. An Owner's adjustment sets an absolute corrected balance and requires a reason. An opening balance creates its own movement in the same transaction as the item.

An item can be archived only when its balance is zero. Its past movements are retained. Units cannot be changed after stock has moved, since that would change the meaning of historical quantities. The module tracks quantities, not inventory valuation.

## Attendance

Employees check in and out for themselves. The database records the actual time and assigns the work date in `Asia/Kolkata`. A member has at most one attendance record per work date and one open shift at a time. An overnight shift can be checked out after midnight.

An Owner can correct attendance, record a half day, or mark absence/leave. Corrections require a reason and retain an audit trail. Future dates and timestamps are rejected. Leave and absence records have no check-in or check-out time. The module records attendance; it does not calculate payroll or collect GPS/biometric data.

## Expenses

Employees enter the date, description, category, INR amount and optional site, bill/reference and notes. Amounts are positive, use at most two decimal places, and are stored as integer paise. Company aggregates are returned as exact integer strings so large sums do not lose precision in JavaScript.

New entries are **Submitted**. The submitting employee can edit or withdraw a submitted or rejected entry. Editing a rejected entry resubmits it for review. Employees cannot choose a different submitter, approve themselves through a request field, or change another employee's amount.

Only the Owner can move an entry from **Submitted** to **Approved** or **Rejected**, and from **Approved** to **Paid**. Rejection requires a note explaining the decision. Paid and withdrawn entries remain historical records. An Owner reviews another employee's entry rather than rewriting its submitted details.

Receipt image uploads are not part of this release; the bill/reference field can record the supporting document reference.

## Privacy and exports

The SQL read and export functions filter attendance and expenses for the authenticated employee. This applies to Managers too. Non-Owner responses contain no company expense summary, other employees' expense rows or company-wide expense counts.

Operations audit records are stored separately from the original CRM activity records. Expense amounts, review notes and attendance corrections never enter that original feed. Both original activity history and the new operations audit are now private to the Owner: non-Owner workspace reads and exports return an empty legacy activity array, and their operations export omits audit data entirely.

Monthly views return at most 500 history records per collection and include the exact permitted count. The interface indicates when a view is truncated. Stock balances always show current quantities, independently of the selected history month. Full JSON exports contain all permitted records without the monthly display limit.

The existing `/api/export` JSON format is now `schemaVersion: 2`, with an `operations` object added. Stock remains shared; attendance and expenses are scoped to the caller. CSV exports also support `module=stock`, `module=attendance` and `module=expenses`, with the same SQL permissions and spreadsheet formula protection.

## Admin-only Team activity

The separate **Team activity** navigation tab is visible only to the Owner. Its SQL endpoint also rejects every other role, including Manager. It combines saved CRM changes with stock, attendance and expense changes, showing who performed the action and when in India time.

Filters select the month, employee and module. The history uses stable pages of 100 records, with an exact matching count. Inactive employees remain available in the historical employee filter; this does not restore their access. Original example events without an attributable employee can appear in the unfiltered view, but are not attributed to a selected employee.

Operations entries preserve before/after details and correction or review reasons. Original CRM entries retain their existing descriptions; this release does not invent before/after snapshots for older changes. The history records saved application actions, not employee screen viewing, location or background device activity. Full Owner JSON exports include both audit sources.

## Implementation

- `GET /api/operations?month=YYYY-MM` returns a permitted monthly view.
- `POST /api/operations` accepts a strict action-specific payload, expected revision and unique request ID.
- `GET /api/team-activity` accepts month, employee, module and page filters and requires the current Owner role in SQL.
- `lib/operations-types.ts` defines the UI/API record contract.
- `lib/operations-validation.ts` validates payloads before the database call.
- `lib/operations-server.ts` obtains the actor from verified authentication, then calls the restricted database functions.
- `components/OperationsPanel.tsx` implements the three responsive module screens.
- `components/TeamActivityPanel.tsx` implements the private administrator activity screen.

The new tables live in the existing private `crm` schema with RLS enabled and no direct application-role grants. Only the server's service-role client can execute the public operations and team activity RPCs. Each RPC validates the active member, and SQL enforces row ownership and allowed state transitions. The original workspace read function is also updated to keep legacy activity private to the Owner; core document data and mutation behavior remain compatible.

An independent operations revision serializes stock, attendance and expense changes. A request ID is bound to its actor, action and payload hash. Replaying a successful request returns the current authorized view without recording the entry twice. A stale revision returns a conflict and requires a refresh. Balance changes, audit entries, revision updates and replay receipts commit atomically.

## Deployment and verification

Apply the additive operations migration after the original CRM migration, then deploy the application. The migration does not reseed, erase or rewrite existing CRM records. No new provider credentials are required. The Android APK loads the live website, so refreshing its workspace picks up these modules without replacing the APK.

Run `npm test`, targeted ESLint, and `npm run build` before deployment. Database tests execute the actual migrations and RPCs using PGlite, including role privacy, direct access denial, invalid transitions, stock bounds, attendance uniqueness, replay handling and rollback. PGlite uses one connection; its tests do not simulate multiple hosted PostgreSQL connections.

Check the deployed database function privileges and RLS, then verify authenticated operations reads and unauthenticated rejection at the live API. Test fixtures belong in the local database or isolated visual harness; do not populate production with example attendance, stock or expenses.
