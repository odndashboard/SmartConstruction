# Preserve existing Site records during the move

The prior ChatGPT-hosted CRM and the Vercel/Supabase CRM use separate databases and authentication identities. Publishing code or linking GitHub does not transfer records.

## Before switching the team

Open the original private Site as an authorized owner and download its full **JSON export**. Keep it securely outside the public repository. Check whether it contains real customers, leads, follow-ups, quotations, work orders and audit events. Do not assume the old database is empty because the new one is empty.

If there are no records to retain, set up the new Owner and employees, verify the new deployment, and begin using the new workspace. Keep the original Site available until the new workflow is accepted.

If there are records to retain, prepare an explicit one-time import before admitting employees to the new business database. An operator should:

1. Take an export/backup of both source and destination and pause edits for the transfer window.
2. Verify the source export format and every customer/lead/quotation/work-order relationship.
3. Create the intended Supabase employee accounts. Map each old ChatGPT member ID to its correct Supabase user UUID; do not guess identity from display names. Resolve departing/unmapped assignees explicitly with the owner.
4. Preserve record IDs, issued document numbers, financial totals, frozen supplier/customer details, accepted work-order snapshots, historical dates and audit events.
5. Apply the import transactionally into an empty destination business dataset. Do not overwrite a partially used workspace or silently combine unrelated records.
6. Compare module counts, assigned owners, document number counters and financial totals, and inspect several issued documents on both systems.
7. Switch the staff URL only after the owner confirms the imported records and employee permissions.

This repository deliberately has no public upload endpoint that accepts arbitrary workspace snapshots and no automatic destructive reset of the source database. The supplied migration creates the new schema; it does **not** import existing Site data. A data-specific import must be prepared and verified from the actual authorized export.
