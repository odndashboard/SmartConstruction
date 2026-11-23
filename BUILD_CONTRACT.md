# Smart construction hosted CRM — working contract

Existing Django starter remains at /workspace/scratch/21176348a36c/smart-construction-crm.
This hosted app runs React/Vinext + managed D1 with dispatch ChatGPT sign-in.
Preserve business rules and UI concept; do not attempt to run Python on Workers.
Root owns Site identity/manifest/build/publish, lib/types.ts, lib/finance.ts,
lib/demo.ts, tests, app/page.tsx/layout.tsx, project docs.
Backend owns db/schema.ts, lib/server.ts, app/api/workspace/route.ts and app/api/export/route.ts.
UI owns components/CRMApp.tsx and app/globals.css plus own component helpers if needed.
No dependency changes while install runs. Existing lucide-react, zod available.

## Interface

GET /api/workspace returns WorkspaceData (types in lib/types.ts) and bootstraps first
member OWNER only under verified signed-in private-Site access. Missing identity 401.
Seed demo on explicit POST action load_demo only. First UI can present local example
preview data via createDemoData(), clearly marked Preview, with button Load example
workspace that persists. Prefer default initialized empty app: clear invitation to load
examples; root will load example workspace for visual QA only into local preview.

POST /api/workspace accepts {action, payload, expectedRevision:number, requestId:string}.
Returns {data:WorkspaceData,message:string} on success; error {error:string}, 400/403/409.
Use Content-Type application/json, verify Origin vs request URL host (allow trusted
same-origin only), verify user identity for every operation. GET no-store. No spoofed
identity headers introduced by app. Use existing getChatGPTUser server helper.

AppData synced across devices in D1. Use relational parent IDs + JSON payload records
and global optimistic revision with atomic D1.batch guard to avoid stale overwrites.
The guard must fail SQL CHECK in same batch before any writes if revision differs.
Do not execute BEGIN on D1. Schemas/migrations only at build, not request-time DDL.
Persist audit records; write all changed entity rows in same atomic batch as revision,
sequences, and audit. Quote.number unique, workorder.quoteId unique.

## Actions (payload)

customer_save: {id?:string,name,contact,phone,email,address,stateCode,gstin}
lead_save: {id?:string,customerId,title,contact,phone,email,location,siteAddress,stateCode,
 value:string rupees,status,source,owner,priority,notes} status NEW/CONTACTED/SITE_VISIT/QUOTED/NEGOTIATION/WON/LOST
lead_status: {id,status,lostReason?}; WON only via accepted quote; LOST needs reason.
followup_save: {id?:string,leadId,title,dueAt:ISO,channel,owner,notes}; status OPEN by default.
followup_complete: {id,outcome}; outcome required, OPEN only.
followup_cancel: {id}; OPEN only.
quote_save: {id?:string,leadId,title,validUntil:YYYY-MM-DD,placeOfSupply,siteAddress,terms,items:QuoteItemInput[]}
quote_issue: {id}; needs actual company legalName/gstin/stateCode/address and at least1item.
quote_accept: {id,acceptanceNote}; ISSUED unexpired only; updates lead WON.
quote_decline: {id}; ISSUED only.
quote_revise: {id}; ISSUED/DECLINED/EXPIRED creates newdraft, supersedesold, accepted blocked.
quote_convert: {id}; ACCEPTED -> one WO, repeat returns existing.
workorder_save: {id,owner,startDate,endDate,status}; PLANNED/ACTIVE/ON_HOLD/COMPLETED/CANCELLED allowed transitions.
milestone_add: {workorderId,title,dueDate}; creates ordered milestone.
milestone_complete: {workorderId,milestoneId}; no closed WO edits.
company_save: Company fields except currency,timeZone server-fixed INR Asia/Kolkata.
member_role: {userId,role}; OWNER only, prevent removing lastowner/self owner.
load_demo: {} owner only idempotent; explicit labels and perrecord isDemo true.
clear_demo: {} owner only; remove only example records, preserve real records.

Roles: OWNER/MANAGER/SALES/OPERATIONS/VIEWER. All active members read.
Sales+manager+owner customers/leads/drafts; owner+manager issue/accept/convert;
operations+manager+owner workorders; all exceptviewer followups; owner company/team.
New admitted site visitors default VIEWER; Site audience remains owner-private at launch.

## Financial and snapshot rules

Currency inputs decimal strings, scaled BigInt for calculation, output integer paise
within safe integer range. Explicit line gstRate string; no default 18 or inferredclassification.
Model quantity up to3decimals, unitPrice/discount/gstRate2decimals. Line discount beforetax.
Tax mode determined registration state versus property placeOfSupply, UTGST04/26/31/35/38.
Only ordinary domestic forwardcharge supported, no specialregimes presented as supported.
Draft can exist without registrationstate: totals must show needsConfig and taxes unpriced;
never silently choose a jurisdiction. computeQuote helper root implements available.
At issue require exactvalidcompanyregistrationformat+stateprefix, customerbillingaddress,
site state/address, reviewed HSN/SAC and rate, validity>=today. Number startsSC/Q/FY/000001.
Snapshot company/customer/title/site/items/taxbreakdown at issue, frozen afterissue.
WO snapshots acceptedquote (no future master edits change prices/parties/title).
Audit who/when; permissions server-side. Globalrevision rejectstale updates. Idempotent conversion.

## UI

Component default export CRMApp(). Fetch owndata onmount; loadingstate then realdata.
Headerprofile comes authenticated data.user. No fake authenticationlogin or fake profilechooser.
Nav Dashboard, Leads, Follow-ups, Quotations, Work orders, Customers, Settings.
Clean navy sidebar, off-white/white surfaces, amberaccent, sage success, nophotos.
Companybrand smart construction + geometric building mark. Body16px, labels14px.
Desktop desktopreference dense butgenerous topbarsearch and +Newlead, summarycards,
leadkanban5stages, today'sfollowups, pendingquotes, workorders. Mobile stackedcards,
responsive navigation. Functional list/search/filter/kanbantoggle, detailed drawers/forms,
quoteeditor w/live amounts andGSTbreakdown, print quotation, milestones, toasts, errors.
Settings holds genuine company setup and teamroles; no sampleGSTIN passed as realsettings.
Export actualcurrentrecords JSON/CSV via authenticated GET export or clientgeneratedCSV.
All visiblebuttons performmeaningfulactions, remove nonexistentsettingslinks.
Use forms in modals/drawers with labels, ESCclose, focusmanagement, disabledsaving,
safe validationerrors. Save/refetch or response data updates allpanels; localStorage only
viewpreference not CRMdata. Demo data clearly marked and optional. For actual firstpage
emptydata use friendly empty states not meaninglesszeros wall; load examples button works.
