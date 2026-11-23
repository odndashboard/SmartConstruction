# Sites, stock, attendance, expenses and customer payments

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
| Create/archive construction sites; assign employees | Yes | No | No |
| Configure shift rules and approve overtime | Yes | No | No |
| View monthly attendance calendar and summary | Entire team | Own records | Own records |
| Transfer stock and return unused material | Yes | Yes | No |
| Submit material requests | Any active site | Own assigned site | No |
| Review/fulfil material requests; manage purchase orders | Yes | No | No |
| Attach/remove receipts on editable own expenses | Yes | Yes | No |
| View saved expense receipts | All employees | Own expenses | Own expenses |
| Record/view/export customer payment balances | Yes | No | No |

Every operation requires an active, confirmed CRM membership. Removing a member blocks these modules as well as the original CRM. A role selected in the interface or passed in a request never establishes authority.

## Stock

Each material has a stock code, name, unit, optional storage note and reorder level. Separate construction-site records determine the actual location of stock. Quantities support up to three decimal places. Stock balances use integer thousandths in storage and calculations.

The inventory shows **Received**, **Used**, **Adjustments** and **Remaining** for each material. Received/used/adjusted figures come from the complete movement ledger, including opening stock, independently of the selected history month. Used is net of unused material returned; returned quantities are also displayed separately. Returns do not increase the received or adjustment totals. Received minus used plus adjustments equals the remaining balance. These cumulative quantities use exact integer strings so a long history does not lose precision. Different units are never added into one misleading total.

Stock in and stock out append an immutable movement record. A stock-out transaction cannot make the balance negative. An Owner's adjustment sets an absolute corrected balance and requires a reason. An opening balance creates its own movement in Main store in the same transaction as the item.

An item can be archived only when its balance is zero. Its past movements are retained. Units cannot be changed after stock has moved, since that would change the meaning of historical quantities. The module tracks quantities, not inventory valuation.

### Locations, transfers and returns

**Main store** is a protected system location. Create working construction sites in **Attendance → Sites & assignments**; these same sites appear in Stock. Existing balances are attributed to Main store during migration without inventing an extra purchase or stock-in movement.

Stock in/out applies to a specific location. Location balances reconcile to the company quantity. A transfer moves unused material between two locations atomically: it reduces the source and increases the destination, with no change to company received, used or remaining. A stock-out records consumption or issue. If material from that issue is returned unused, record a **Return** against the original stock-out. Cumulative returns cannot exceed the original issued amount. Return entries preserve the original issue and the reason.

The Owner can correct a location's absolute balance with a reason. No operation may make a location or company balance negative. Archived sites cannot receive new transactions. Archiving is blocked while the site has stock, active assignments or open requests/purchase orders.

### Material requests and purchase orders

Employees request an item and quantity for their assigned site, with an optional needed-by date. They see their own requests. The Owner sees all requests, approves or rejects them, and can fulfil approved quantities in parts from a different stock location. Each fulfilment produces an atomic stock transfer. Cancelling a partially fulfilled request preserves the fulfilled portion and its history.

Owner-only purchase orders record the supplier, delivery location, expected date, reference and item quantities. Receiving a delivery increases stock at that location; partial receipts remain open and over-receipt is rejected. A multi-line receipt is atomic. Cancelling an order closes only the outstanding portion. This is quantity procurement: supplier prices, GST purchase accounting and supplier payments are not calculated here, and receiving an order does not create an expense automatically.

## Sites and attendance

The Owner creates construction sites, optionally links them to real work orders, and assigns each employee one current site. Employees check in to their assigned active site; the Owner can choose an active construction site or Office/no linked site. Employees check in and out for themselves. The database records the actual time and assigns the work date in `Asia/Kolkata`. A member has at most one attendance record per work date and one open shift at a time. An overnight shift can be checked out after midnight.

An Owner can correct attendance, record a half day, or mark absence/leave. Corrections require a reason and retain an audit trail. Future dates and timestamps are rejected. Leave and absence records have no check-in or check-out time. The module records attendance; it does not calculate payroll or collect GPS/biometric data.

### Shift rules, overtime and calendar

In **Attendance → Shift rules**, the Owner configures start/finish times, whether the shift crosses midnight, a fixed unpaid break and a lateness grace period. The rules start unconfigured: the app does not invent working hours. The current rule is frozen into each new attendance record so later rule changes do not rewrite previous days.

For a completed timed record, worked minutes equal elapsed whole minutes less the fixed unpaid break, with a floor of zero. Expected minutes equal the scheduled shift length less that break. Lateness is the amount after the scheduled start and grace period. Eligible overtime is worked minus expected, with a floor of zero. The Owner approves up to the eligible overtime and supplies a reason. A correction resets overtime approval for review. Unconfigured records show actual duration without an invented expected shift or overtime allowance; open shifts have no final worked/late/overtime calculation.

The calendar and summary include every permitted attendance record in the selected month, independent of the legacy history list's 500-row display limit. The Owner can filter employees; employees see their own calendar and summary. Blank dates mean **Not recorded**, not absent. The summary reports recorded statuses, worked time, lateness and eligible/approved overtime. It does not calculate payroll, wages or overtime pay.

## Expenses

Employees enter the date, description, category, INR amount and optional site, bill/reference and notes. Amounts are positive, use at most two decimal places, and are stored as integer paise. Company aggregates are returned as exact integer strings so large sums do not lose precision in JavaScript.

New entries are **Submitted**. The submitting employee can edit or withdraw a submitted or rejected entry. Editing a rejected entry resubmits it for review. Employees cannot choose a different submitter, approve themselves through a request field, or change another employee's amount.

Only the Owner can move an entry from **Submitted** to **Approved** or **Rejected**, and from **Approved** to **Paid**. Rejection requires a note explaining the decision. Paid and withdrawn entries remain historical records. An Owner reviews another employee's entry rather than rewriting its submitted details.

### Private receipt uploads

Save the expense first, then expand its receipt section and select **Attach receipt**. Each expense supports up to five JPG, PNG, WebP or PDF files, each up to 3 MiB. Images can be previewed; all receipts can be downloaded. Android app 1.1.0 adds a system file picker and secure native receipt downloads; older app versions can use **Open in browser**.

Only the submitting employee can attach or remove evidence while their expense is Submitted or Rejected. The Owner can read any employee's saved receipt but cannot rewrite another employee's evidence. Approval, payment or withdrawal prevents further attachment changes. Removing a receipt revokes access before object cleanup.

The storage bucket is private, with no direct anon/authenticated read or write policies. The server checks current identity, active membership and expense ownership before upload/download/removal; downloads recheck access after storage IO. Files are size-limited, content-signature checked, hashed and served with private no-store headers. Signed public URLs are never returned. Upload reservations bind the request ID to the actor, expense and exact file identity, so retrying an uncertain upload cannot create duplicates or replace a different object. Pending reservations count toward the quota for 20 minutes and never appear as published receipts.

## Customer payments

The **Payments** navigation tab is Owner-only, including API reads, writes, exports and activity history. Select a real work order; its frozen accepted quotation total determines the contract amount.

The Owner can add due-date instalments and record actual customer receipts with a date, method (cash, bank, UPI, cheque or other), reference and notes. The app tracks contract amount, scheduled amount, received, outstanding, overdue and unallocated advance. Payments are a record of money received outside the app; this module does not charge a customer or initiate a bank transfer.

Net receipts automatically allocate to active instalments in earliest-due-date order, then creation order. Unallocated amounts are advances beyond the scheduled instalments. Overdue includes only unpaid active instalments due before today in India time. Scheduled instalments and net receipts cannot exceed the work-order contract amount. Future-dated receipts and new receipts/plans for cancelled work orders are rejected.

Recorded payments are immutable. An Owner can void an incorrect payment with a reason; the original and void history remain visible and balances recalculate. Cancelling an instalment retains it in history. Changes are included in the Owner's Team activity tab. All monetary arithmetic uses exact integer paise; aggregate values are returned as integer strings.

## Privacy and exports

The SQL read and export functions filter attendance and expenses for the authenticated employee. This applies to Managers too. Non-Owner responses contain no company expense summary, other employees' expense rows or company-wide expense counts.

Operations audit records are stored separately from the original CRM activity records. Expense amounts, review notes and attendance corrections never enter that original feed. Both original activity history and the new operations audit are now private to the Owner: non-Owner workspace reads and exports return an empty legacy activity array, and their operations export omits audit data entirely.

The original monthly stock-movement, attendance-history and expense lists return at most 500 records per collection and include the exact permitted count. The new monthly calendar remains complete. The interface indicates when a view is truncated. Stock balances always show current quantities, independently of the selected history month. Full JSON exports contain all permitted records without the monthly display limit.

The `/api/export` JSON format is `schemaVersion: 3`, with `operations.extension` containing sites, assignments, the complete permitted attendance calendar, location balances, transfers, returns, permitted requests/orders/payments and receipt metadata. Receipt file bytes are downloaded separately through their authenticated endpoints. Stock remains shared; attendance and expenses are scoped to the caller. CSV exports also support `module=stock`, `module=attendance`, `module=expenses`, `module=site_stock` and Owner-only `module=payments`, with the same SQL permissions and spreadsheet formula protection.

## Admin-only Team activity

The separate **Team activity** navigation tab is visible only to the Owner. Its SQL endpoint also rejects every other role, including Manager. It combines saved CRM changes with stock, attendance and expense changes, showing who performed the action and when in India time. It also records site assignments, shift changes, overtime decisions, receipts, transfers, returns, material requests, purchase orders and customer payments.

Filters select the month, employee and module. The history uses stable pages of 100 records, with an exact matching count. Inactive employees remain available in the historical employee filter; this does not restore their access. Original example events without an attributable employee can appear in the unfiltered view, but are not attributed to a selected employee.

Operations entries preserve before/after details and correction or review reasons. Original CRM entries retain their existing descriptions; this release does not invent before/after snapshots for older changes. The history records saved application actions, not employee screen viewing, location or background device activity. Full Owner JSON exports include both audit sources.

## Implementation

- `GET /api/operations?month=YYYY-MM` returns a permitted monthly view.
- `POST /api/operations` accepts a strict action-specific payload, expected revision and unique request ID.
- `GET /api/team-activity` accepts month, employee, module and page filters and requires the current Owner role in SQL.
- `lib/operations-types.ts` defines the UI/API record contract.
- `lib/operations-validation.ts` validates payloads before the database call.
- `lib/operations-server.ts` obtains the actor from verified authentication, then calls the restricted database functions.
- `components/OperationsPanel.tsx` coordinates the module screens, mutations, retries and revisions.
- `components/AttendanceAdvanced.tsx`, `StockAdvanced.tsx`, `PaymentsPanel.tsx` and `ExpenseReceipts.tsx` implement the additional workflows.
- `lib/operations-extensions.ts` and `lib/operations-extensions-validation.ts` define the shared feature contract and strict action schemas.
- `POST /api/expense-receipts` handles a bounded multipart upload; `GET`/`DELETE /api/expense-receipts/[id]` check private access and removal rules.
- `components/TeamActivityPanel.tsx` implements the private administrator activity screen.

The new tables live in the existing private `crm` schema with RLS enabled and no direct application-role grants. Only the server's service-role client can execute the public operations and team activity RPCs. Each RPC validates the active member, and SQL enforces row ownership and allowed state transitions. The original workspace read function is also updated to keep legacy activity private to the Owner; core document data and mutation behavior remain compatible.

An independent operations revision serializes stock, attendance, expenses, sites, shift rules, procurement and customer payments. Database guards keep old and new movement paths consistent, including deferred location/company reconciliation checks. A request ID is bound to its actor, action and payload hash. Replaying a successful request returns the current authorized view without recording the entry twice. A stale revision returns a conflict and requires a refresh. Balance changes, audit entries, revision updates and replay receipts commit atomically.

## Deployment and verification

Apply migrations in order: `202611230001_crm.sql`, `20261123173951_operations.sql`, then `20261123182424_operations_extensions.sql`, and deploy the application. Supabase migration history may use hosted application timestamps while keeping the same migration names. Existing projects apply only the missing extension migration. The migration does not reseed, erase or rewrite existing CRM records. No new provider credentials are required. The Android APK loads the live website, so refreshing picks up the new screens. Install Android 1.1.0 for the native receipt file picker and downloads. The application ID and signing key remain the same for an in-place update.

Run `npm test`, targeted ESLint, and `npm run build` before deployment. Database tests execute the actual migrations and RPCs using PGlite, including role privacy, direct access denial, invalid transitions, stock bounds and reconciliation, partial fulfilment/deliveries, return bounds, attendance uniqueness and frozen shifts, complete calendars, FIFO payments, receipt access and race handling, replay handling and rollback. PGlite uses one connection; its tests do not simulate multiple hosted PostgreSQL connections.

Check the deployed database function privileges and RLS, then verify authenticated operations reads and unauthenticated rejection at the live API. Test fixtures belong in the local database or isolated visual harness; do not populate production with example attendance, stock or expenses.
