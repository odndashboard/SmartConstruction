# smart construction CRM

A private construction CRM for a team of 5–10, with leads, follow-ups, INR/GST quotations, work orders, site assignments, attendance, stock, private employee expenses and Owner-only customer payment tracking. The responsive interface works in a phone or computer browser. Employees use their own email and password; they do not need a ChatGPT, GitHub, Vercel, or Supabase account.

## Application stack

- **Vercel:** Next.js App Router application and server endpoints.
- **Supabase Auth:** employee email/password sessions and private activation links.
- **Supabase Postgres:** shared business records, memberships, document counters, audit history, and idempotent mutation receipts.
- **TypeScript business rules:** exact integer-paise calculations, server-side role checks, immutable issued quotations, and accepted quotation snapshots in work orders.

This is the Vercel/Supabase edition. The previously published ChatGPT Site is a separate deployment and database. Updating this repository does not move the Site's data or alter its access controls.

## Setup entirely in Chrome

Follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the complete browser workflow. The order is:

1. Give Vercel access to `odndashboard/SmartConstruction` and import this repository as a Next.js project.
2. Select the Supabase project intended for this CRM and run the supplied SQL migration in its SQL Editor.
3. Add the Supabase URL, publishable key, server secret, and stable application origin in Vercel's environment variables. Redeploy after configuring them.
4. Create your own Auth account in Supabase, designate that exact account as the initial Owner using the supplied administrator SQL, and sign in to the CRM.
5. In **Settings → Team**, add each employee, choose a role, and copy their private activation link. Share the link directly with that person. They choose their own password.

No email is sent by the CRM when a link is generated. Manual links work without an SMTP provider. Configuring a production mail service is a separate optional extension.

## Environment variables

Use `.env.example` as a template; never commit a populated file.

| Variable | Visibility | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public configuration | The selected Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public configuration | Supabase public API key |
| `SUPABASE_SECRET_KEY` | **Server only** | Server-side Auth administration and restricted database RPCs |
| `APP_URL` | Server configuration | Exact stable origin, such as your production Vercel domain |

For an older Supabase project, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are supported aliases. The server secret must never use a `NEXT_PUBLIC_` prefix or appear in a client component, browser console, Git commit, screenshot, or chat message.

Missing configuration produces a setup-pending screen. It does not enable demo authentication or a browser-only database.

## Employee access

| Role | Allowed changes |
|---|---|
| Owner / Admin | All CRM actions, lead status, company details, employee roles and access |
| Manager | Sales, lead status, quotations, commercial approval, and work-order delivery |
| Sales | Customer and lead details, follow-ups, draft quotations and revisions; lead status stays unchanged |
| Operations | Follow-ups, existing work orders, and milestones |
| Accountant | Read/export CRM records, stock entries, own attendance and own expenses with receipts |
| Dealer | Submit and track enquiries, delete their own untouched new enquiries, and view progress on assigned sites |

**Core CRM records and stock are shared with active internal staff. Dealers use a separate lead portal.** Sales/work-order assignments show responsibility; they do not hide other employees' customers, quotations or work. Attendance, expenses and receipts are private to the employee and Owner. Company expense totals, customer payment tracking, procurement orders and Team activity are Owner-only; Managers and Accountants remain employees for these privacy rules. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the complete access table and setup steps.

Add Lead links a customer using the lead contact or project title and phone. Billing details can be edited from the lead. Sales can add New enquiries and edit their details. Owners and Managers can mark a lead **Won** from the lead form or **Change status**. Lost requires a reason and reopens as New enquiry. Won is final.

Marking a lead **Won** creates a **Planned** work order using the lead's project details. Accepting a quotation marks its linked lead Won and creates a work order for its approved scope. If the lead already has a work order awaiting approval, the first accepted quotation attaches to that order and keeps its number, owner, dates and milestones. Each additional accepted quotation receives its own work order.

To assign the Accountant role, an Owner opens **Settings → Team** and chooses **Accountant** beside an active employee, or chooses it when creating a new employee account. Adding this role does not change anyone's existing access automatically.

An Owner can disable an employee immediately in **Settings → Team**. The server checks active membership on each request, so an existing authentication session cannot continue reading or changing CRM data after deactivation. Data already downloaded to a device cannot be recalled. At least one active Owner must remain, and users cannot disable themselves through the team controls.

There is no public self-registration screen and no first-visitor-is-owner rule. Initial Owner setup is an explicit operator action restricted to the Supabase server role; additional membership requires an existing active Owner.

## Business behavior

- Company currency is INR and business dates use `Asia/Kolkata`.
- Money is calculated using integer paise and exact intermediate arithmetic.
- New quotations default to **No GST**. Choose **Apply GST** to use the company's registration, place of supply and reviewed line-item rates. Enter a description, unit, quantity and price for Panels, Inverter, Structure, DC Wire, Ac Wire, Earthing Wire, Earthing ROD, Lighting Arrester and Filing. Use ₹0 for an item included in a package price. Extra work items are optional.
- Issuing freezes supplier/customer details and quote amounts. Editing issued commercial terms requires a new revision.
- Owners and Managers can use **Quotations → Change status** to issue a draft as **Awaiting approval**, record customer acceptance, or mark an issued quotation **Expired**. A quotation expired early can return to **Awaiting approval** through its original valid-until date. After that date, use **Create revision** to set a new validity period.
- Marking a lead Won automatically creates its Planned work order, including when the lead has no quotation. The work order shows project details and expected kW; approved totals remain blank until a quotation is accepted.
- Customer acceptance records an acceptance note, marks the lead Won and automatically creates or links that quotation's work order with its approved snapshot.
- In **Work orders → Job items**, the Owner, Manager or Operations team can record material usage while the order is **In progress**. Each confirmed issue deducts the entered quantity from the selected stock item and location. Filing can be completed separately.
- Repeating the Won update or quotation conversion reuses the existing applicable order. An accepted quotation can produce only one work order; its approved commercial snapshot is retained. Every additional accepted quotation automatically receives a separate work order for its own scope without overwriting an earlier order.
- Mutations use a workspace revision and request ID to reject stale edits and safely acknowledge retries.
- Example data is optional, visibly labelled, and loaded only by an Owner's explicit action.
- Owner JSON exports include the full available audit trail; employee exports omit private administrator activity and other employees' attendance/expenses. CSV cells are escaped against spreadsheet formula injection.

## Local development and checks

Use Node.js 24.x. Install dependencies:

```sh
npm ci
```

Link the checkout to the intended Vercel project and pull its **development** environment before starting the server or applying migrations. Use a separate Supabase project for staging/testing; do not point development at the live business database by accident.

```sh
npx vercel link
npx vercel env pull .env.local
npm run check:env
npm run dev
```

Checks that do not require live provider credentials:

```sh
npm test
npm run typecheck
npm run build
npm run lint
```

The SQL tests execute against PostgreSQL through PGlite with synthetic Supabase roles/accounts. They check real SQL syntax, permissions, transaction rollback and stale-revision/receipt behavior. They do not replace testing cookie refresh, real provider settings, and simultaneous requests against the deployed Supabase project.

For operator setup from a terminal, after applying the migration and configuring environment variables:

```sh
npm run owner:setup -- --email owner@your-company.in --name "Owner name"
```

The script designates only the supplied account, refuses to replace an existing owner, and writes a private activation link to an ignored `private/` file. It does not send an email or set a password. The browser-only alternative is documented in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Source map

| Path | Responsibility |
|---|---|
| `components/CRMApp.tsx` | Desktop/mobile dashboard and business workflows |
| `app/login`, `app/auth`, `app/set-password` | Employee sign-in and explicit activation/recovery confirmation |
| `lib/supabase`, `lib/auth.ts`, `proxy.ts` | Cookie sessions, verified identity, separate server-only admin client |
| `lib/server-actions.ts` | Validated business permissions and state transitions |
| `lib/server.ts` | Authenticated reads and atomic Postgres mutations |
| `lib/finance.ts` | INR/GST arithmetic and document calculations |
| `supabase/migrations` | Database tables, constraints, restricted RPCs and access rules |
| `tests` | Business, financial and database regression tests |
| `docs/DEPLOYMENT.md` | Browser deployment and employee onboarding |
| `docs/MIGRATION.md` | Preservation and transfer of existing Site records |
| `docs/OPERATIONS.md` | Sites, shifts, calendar, stock, expenses/receipts and customer payments |
| `android/README.md` | Android app, file uploads, downloads and signed update build |

## Reference documentation

- [Supabase server-side authentication](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Supabase API key types](https://supabase.com/docs/guides/api/api-keys)
- [Supabase Auth link generation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
- [Supabase SMTP limits and configuration](https://supabase.com/docs/guides/auth/auth-smtp)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
