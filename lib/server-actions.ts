/** Pure, validated business mutations. Persistence and authenticated identity live in server.ts. */
import { z } from 'zod';
import { computeQuote, validateRegistration, parseMoney, todayIST, financialYear, STATE_OPTIONS } from './finance.ts';
import { createDemoData } from './demo.ts';
import { DOCUMENT_KEYS, DOCUMENT_NAMES, type WorkDocumentKey } from './work-documents.ts';
import { WORK_LABELS, WORK_TRANSITIONS } from './work-order-status.ts';
import { REQUIRED_QUOTE_CATEGORIES, MAX_QUOTE_ITEMS, QUOTE_ITEM_SCHEMA_VERSION, validateRequiredQuoteItems } from './quotation-categories.ts';
import type { WorkspaceData, Role, Lead, LeadStatus, Quotation, WorkOrder, WorkStatus, QuoteItemInput, Company } from './types';

export class CRMError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'CRMError'; this.status = status; }
}
const text = (max = 200) => z.string().trim().max(max);
const required = (max = 200) => text(max).min(1, 'This field is required.');
const blank = (max = 200) => text(max).default('');
const id = required(120);
const emailValue = z.union([z.string().trim().email().max(254), z.literal('')]);
const email = emailValue.default('');
// Form fields arrive as strings; reject coercions such as booleans, hex and
// scientific notation, while retaining zero and decimal kW as JSON numbers.
const expectedKw = z.union([
  z.number().finite().nonnegative(),
  z.string().trim().refine(value => value === '' || /^(?:\d+\.?\d*|\.\d+)$/.test(value), 'Enter a nonnegative number of kW.')
    .transform(value => value === '' ? null : Number(value))
    .refine(value => value === null || Number.isFinite(value), 'Enter a finite number of kW.'),
  z.null(),
]).optional();
const state = z.string().refine(v => !v || STATE_OPTIONS.some(s => s.value === v), 'Choose a valid Indian state.').default('');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Enter a valid calendar date.');
const optionalDate = z.union([date, z.literal('')]).default('');
const role = z.enum(['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'DEALER']);
const leadStatus = z.enum(['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']);
const workStatus = z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
const owner = blank(200);
const identity = z.object({ id }).strict();
const item = z.object({
  category: z.enum(REQUIRED_QUOTE_CATEGORIES).optional(),
  id, description: required(2000), hsnSac: text(8).optional(), quantity: required(30), unit: required(24),
  unitPrice: required(30), discount: text(30).optional(), gstRate: text(30).default(''),
}).strict();
// This dynamic action registry retains action-specific runtime validation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The dispatcher selects a heterogeneous schema by a validated action string; every payload is parsed by its strict schema before use.
const schemas: Record<string, z.ZodType<any>> = {
  customer_save: z.object({ id: id.optional(), name: required(), contact: blank(), phone: blank(40), email, address: blank(2000), stateCode: state, gstin: blank(15) }).strict(),
  lead_save: z.object({ id: id.optional(), customerId: id.optional(), title: required(), contact: blank(), phone: blank(40), email: emailValue.optional(), expectedKw,
    location: blank(), siteAddress: blank(2000), stateCode: state, value: text(30).default('0'), status: leadStatus.optional(),
    source: blank(100), owner, priority: z.enum(['High', 'Medium', 'Low']).default('Medium'), notes: blank(10000) }).strict(),
  lead_status: z.object({ id, status: leadStatus, lostReason: blank(3000) }).strict(),
  followup_save: z.object({ id: id.optional(), leadId: id, title: required(), dueAt: z.string().datetime({ offset: true }),
    channel: z.enum(['Call', 'WhatsApp', 'Email', 'Site visit', 'Other']), owner, notes: blank(5000) }).strict(),
  followup_complete: z.object({ id, outcome: required(5000) }).strict(),
  followup_cancel: identity,
  quote_save: z.object({ id: id.optional(), leadId: id, title: required(), validUntil: date, placeOfSupply: state, gstEnabled: z.boolean().optional(),
    itemSchemaVersion: z.literal(QUOTE_ITEM_SCHEMA_VERSION).optional(),
    siteAddress: blank(2000), terms: blank(12000), items: z.array(item).max(MAX_QUOTE_ITEMS) }).strict(),
  quote_issue: identity,
  quote_accept: z.object({ id, acceptanceNote: required(5000) }).strict(),
  quote_decline: identity,
  quote_expire: identity,
  quote_reopen: identity,
  quote_revise: identity,
  quote_convert: identity,
  workorder_paper_filing: z.object({ id, document: z.enum(DOCUMENT_KEYS), documentStatus: z.enum(['PENDING','RECEIVED']) }).strict(),
  workorder_save: z.union([
    z.object({ id, status: workStatus }).strict(),
    z.object({ id, owner, startDate: optionalDate, endDate: optionalDate, status: workStatus }).strict(),
  ]),
  milestone_add: z.object({ workorderId: id, title: required(), dueDate: optionalDate }).strict(),
  milestone_complete: z.object({ workorderId: id, milestoneId: id }).strict(),
  company_save: z.object({ name: required(), legalName: blank(), address: blank(2000), gstin: blank(15), stateCode: state,
    phone: blank(40), email, website: blank(500).refine(v => !v || /^https?:\/\//i.test(v), 'Website must begin with https:// or http://.'), terms: blank(12000) }).strict(),
  member_role: z.object({ userId: id, role }).strict(),
  member_active: z.object({ userId: id, active: z.boolean() }).strict(),
  load_demo: z.object({}).strict(),
  clear_demo: z.object({}).strict(),
};
const SALES: Role[] = ['OWNER', 'MANAGER', 'SALES'];
const APPROVE: Role[] = ['OWNER', 'MANAGER'];
const DELIVERY: Role[] = ['OWNER', 'MANAGER', 'OPERATIONS'];
const FOLLOW: Role[] = ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS'];
const permission: Record<string, Role[]> = {
  customer_save: SALES, lead_save: SALES, lead_status: APPROVE,
  followup_save: FOLLOW, followup_complete: FOLLOW, followup_cancel: FOLLOW,
  quote_save: SALES, quote_revise: SALES,
  quote_issue: APPROVE, quote_accept: APPROVE, quote_decline: APPROVE, quote_expire: APPROVE, quote_reopen: APPROVE, quote_convert: APPROVE,
  workorder_paper_filing: DELIVERY, workorder_save: DELIVERY, milestone_add: DELIVERY, milestone_complete: DELIVERY,
  company_save: ['OWNER'], member_role: ['OWNER'], member_active: ['OWNER'], load_demo: ['OWNER'], clear_demo: ['OWNER'],
};
function get<T extends { id: string }>(list: T[], value: string, label: string): T {
  const found = list.find(record => record.id === value);
  if (!found) throw new CRMError(`${label} was not found. Refresh the workspace.`, 404);
  return found;
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new CRMError(message); }
function clone<T>(value: T): T { return structuredClone(value); }
function checkOwner(data: WorkspaceData, value: string) {
  assert(!value || data.members.some(member => member.userId === value && member.active), 'Assign work to an active team member.');
}
function checkLeadTransition(lead: Pick<Lead, 'status' | 'lostReason'>, target: LeadStatus, lostReason: string) {
  assert(lead.status !== 'WON' || target === 'WON', 'A won lead cannot be reopened through a status change.');
  assert(lead.status !== 'LOST' || target === 'NEW' || target === 'LOST', 'Reopen a lost lead as New enquiry first.');
  assert(target !== 'LOST' || lostReason.trim().length > 0, 'Record a reason before marking this lead lost.');
}
function assertOpenOrder(order: WorkOrder) {
  assert(order.status !== 'COMPLETED' && order.status !== 'CANCELLED', 'Closed work orders cannot be edited.');
}
function nextNumber(data: WorkspaceData, kind: 'Q' | 'WO', now: Date): string {
  const year = financialYear(now); const key = `${kind}/${year}`;
  const value = (data.sequences[key] ?? 0) + 1;
  assert(Number.isSafeInteger(value) && value <= 999999999, 'Document numbering limit reached. Contact the administrator.');
  data.sequences[key] = value;
  return `SC/${kind}/${year}/${String(value).padStart(6, '0')}`;
}
function audit(data: WorkspaceData, action: string, type: string, entityId: string, description: string, now: string) {
  data.activity.unshift({ id: crypto.randomUUID(), actor: data.user.name, action, entityType: type, entityId, description, createdAt: now });
}
function calculate(items: QuoteItemInput[], supplierState: string, placeOfSupply: string, gstEnabled = true) {
  try { return computeQuote(items, supplierState, placeOfSupply, gstEnabled); }
  catch (error) { throw new CRMError(error instanceof Error ? error.message : 'Check quotation values.'); }
}
function validateQuoteCategories(items: QuoteItemInput[]) {
  try { validateRequiredQuoteItems(items); }
  catch (error) { throw new CRMError(error instanceof Error ? error.message : 'Complete the required quotation work items.'); }
}
function validateGst(gstin: string, stateCode: string, required = false) {
  try { validateRegistration(gstin, stateCode, required); }
  catch (error) { throw new CRMError(error instanceof Error ? error.message : 'Check registration details.'); }
}
function inputMoney(value: string) {
  try { return parseMoney(value); }
  catch (error) { throw new CRMError(error instanceof Error ? error.message : 'Check amount.'); }
}
function quoteInputs(quote: Quotation): QuoteItemInput[] {
  return quote.items.map(({ id, category, description, hsnSac, quantity, unit, unitPrice, discount, gstRate }) => ({ id, ...(category === undefined ? {} : { category }), description, hsnSac, quantity, unit, unitPrice, discount, gstRate }));
}

/** A won enquiry can start delivery planning without implying a priced or
 * accepted contract. Later acceptance attaches the genuine commercial snapshot
 * to that same order, preserving its number and all delivery progress. */
function ensureWonWorkOrder(data: WorkspaceData, lead: Lead, action: string, now: Date, acceptedQuote?: Quotation): WorkOrder {
  assert(lead.status === 'WON', 'Only a won lead can create a work order.');
  const stamp = now.toISOString();
  const quote = acceptedQuote ?? data.quotations.filter(row => row.leadId === lead.id && row.status === 'ACCEPTED')
    .sort((a, b) => (a.acceptedAt ?? '').localeCompare(b.acceptedAt ?? '') || a.id.localeCompare(b.id))[0];
  const belongsToLead = (order: WorkOrder) => (order.leadId ?? order.snapshot?.leadId) === lead.id;
  const exact = quote ? data.workorders.find(order => order.quoteId === quote.id) : undefined;
  if (exact) return exact;
  const linkedOrder = data.workorders.find(belongsToLead);
  const unpriced = data.workorders.find(order => belongsToLead(order) && !order.quoteId && !order.snapshot);
  const existing = unpriced ?? (acceptedQuote ? undefined : linkedOrder);
  if (existing) {
    if (quote && !existing.quoteId && !existing.snapshot) {
      assert(quote.status === 'ACCEPTED' && quote.leadId === lead.id, 'An accepted quotation for this lead is required.');
      Object.assign(existing, { quoteId: quote.id, snapshot: clone(quote), title: quote.title,
        customerName: quote.customer?.name ?? existing.customerName, siteAddress: quote.siteAddress, updatedAt: stamp });
      audit(data, action, 'workorder', existing.id, `Linked accepted quotation ${quote.number} to work order ${existing.number}`, stamp);
    }
    return existing;
  }
  const customer = get(data.customers, lead.customerId, 'Customer');
  const record: WorkOrder = { id: crypto.randomUUID(), leadId: lead.id, quoteId: quote?.id ?? null,
    number: nextNumber(data, 'WO', now), title: quote?.title ?? lead.title,
    customerName: quote?.customer?.name ?? customer.name, siteAddress: quote?.siteAddress ?? lead.siteAddress,
    owner: lead.owner, startDate: '', endDate: '', status: 'PLANNED', snapshot: quote ? clone(quote) : null,
    expectedKw: lead.expectedKw ?? null, automaticForLead: action !== 'quote_convert' && !linkedOrder,
    milestones: [], isDemo: lead.isDemo, createdAt: stamp, updatedAt: stamp };
  data.workorders.push(record);
  audit(data, action, 'workorder', record.id, `Created planned work order ${record.number}${quote ? ` from accepted quotation ${quote.number}` : ' for won lead'}`, stamp);
  return record;
}

export function assertActionRole(data: WorkspaceData, action: string): void {
  if (!Object.hasOwn(schemas, action)) throw new CRMError('Unknown workspace action.');
  if (!data.user.active || !permission[action]?.includes(data.user.role)) throw new CRMError('Your role does not permit this action.', 403);
}

/** Receives an isolated cloned snapshot and changes it only after authorization. */
export function applyAction(data: WorkspaceData, action: string, rawPayload: unknown, now = new Date()): string {
  assertActionRole(data, action);
  const parsed = schemas[action].safeParse(rawPayload);
  if (!parsed.success) throw new CRMError(parsed.error.issues.map(issue => `${issue.path.join('.') || 'Request'}: ${issue.message}`).slice(0, 4).join(' '));
  const p = parsed.data; // Validated by the action-specific strict schema above.
  const stamp = now.toISOString(); const today = todayIST(now);
  switch (action) {
    case 'customer_save': {
      validateGst(p.gstin, p.stateCode);
      const existing = p.id ? get(data.customers, p.id, 'Customer') : undefined;
      const record = { ...p, id: existing?.id ?? crypto.randomUUID(), isDemo: existing?.isDemo ?? false, createdAt: existing?.createdAt ?? stamp };
      if (existing) Object.assign(existing, record); else data.customers.push(record);
      audit(data, action, 'customer', record.id, `${existing ? 'Updated' : 'Added'} customer ${record.name}`, stamp);
      return 'Customer saved.';
    }
    case 'lead_save': {
      const existing = p.id ? get(data.leads, p.id, 'Lead') : undefined;
      const customerId = p.customerId ?? existing?.customerId;
      // Customer records remain the quotation/billing anchor. New enquiries can
      // create that anchor atomically using only the contact information given.
      const customer = customerId ? get(data.customers, customerId, 'Customer') : {
        id: crypto.randomUUID(), name: p.contact || p.title, contact: p.contact, phone: p.phone,
        email: p.email ?? '', address: '', stateCode: p.stateCode, gstin: '', isDemo: false, createdAt: stamp,
      };
      const status: LeadStatus = p.status ?? existing?.status ?? 'NEW';
      if (status !== (existing?.status ?? 'NEW') && !APPROVE.includes(data.user.role)) {
        throw new CRMError('Only an Admin or Manager can change a lead status.', 403);
      }
      checkOwner(data, p.owner);
      checkLeadTransition(existing ?? { status: 'NEW', lostReason: '' }, status, existing?.lostReason ?? '');
      if (existing && existing.customerId !== customer.id) {
        assert(existing.isDemo === customer.isDemo, 'Example and real customer records cannot be mixed.');
        assert(!data.quotations.some(q => q.leadId === existing.id && q.status !== 'DRAFT'), 'A lead with issued quotations cannot move to another customer.');
      }
      const record: Lead = { ...p, customerId: customer.id, email: p.email ?? existing?.email ?? '',
        expectedKw: p.expectedKw === undefined ? existing?.expectedKw ?? null : p.expectedKw,
        status, id: existing?.id ?? crypto.randomUUID(), value: inputMoney(p.value),
        lostReason: status === 'LOST' ? existing?.lostReason ?? '' : '', isDemo: customer.isDemo,
        createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
      if (!customerId) data.customers.push(customer);
      if (existing) Object.assign(existing, record); else data.leads.push(record);
      if (record.status === 'WON' && APPROVE.includes(data.user.role)) ensureWonWorkOrder(data, existing ?? record, action, now);
      audit(data, action, 'lead', record.id, `${existing ? 'Updated' : 'Added'} lead ${record.title}`, stamp);
      return 'Lead saved.';
    }
    case 'lead_status': {
      const lead = get(data.leads, p.id, 'Lead');
      checkLeadTransition(lead, p.status, p.lostReason || lead.lostReason);
      lead.status = p.status; lead.lostReason = p.status === 'LOST' ? p.lostReason || lead.lostReason : ''; lead.updatedAt = stamp;
      if (lead.status === 'WON') ensureWonWorkOrder(data, lead, action, now);
      audit(data, action, 'lead', lead.id, `Lead moved to ${lead.status.toLowerCase().replaceAll('_', ' ')}`, stamp);
      return 'Lead status updated.';
    }
    case 'followup_save': {
      const lead = get(data.leads, p.leadId, 'Lead');
      const existing = p.id ? get(data.followups, p.id, 'Follow-up') : undefined;
      checkOwner(data, p.owner);
      if (existing) { assert(existing.status === 'OPEN', 'Only open follow-ups can be edited.'); assert(existing.isDemo === lead.isDemo, 'Example and real records cannot be mixed.'); }
      const record = { ...p, id: existing?.id ?? crypto.randomUUID(), dueAt: new Date(p.dueAt).toISOString(), status: 'OPEN' as const,
        outcome: '', isDemo: lead.isDemo, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
      if (existing) Object.assign(existing, record); else data.followups.push(record);
      audit(data, action, 'followup', record.id, `${existing ? 'Rescheduled' : 'Added'} follow-up ${record.title}`, stamp);
      return 'Follow-up saved.';
    }
    case 'followup_complete':
    case 'followup_cancel': {
      const followup = get(data.followups, p.id, 'Follow-up');
      assert(followup.status === 'OPEN', 'Only open follow-ups can be changed.');
      followup.status = action === 'followup_complete' ? 'DONE' : 'CANCELLED';
      if (action === 'followup_complete') { followup.outcome = p.outcome; followup.completedAt = stamp; }
      followup.updatedAt = stamp;
      audit(data, action, 'followup', followup.id, action === 'followup_complete' ? 'Follow-up completed with outcome' : 'Follow-up cancelled', stamp);
      return action === 'followup_complete' ? 'Follow-up completed.' : 'Follow-up cancelled.';
    }
    case 'quote_save': {
      const lead = get(data.leads, p.leadId, 'Lead');
      assert(lead.status !== 'LOST', 'Reopen the lost lead before creating a quotation.');
      const existing = p.id ? get(data.quotations, p.id, 'Quotation') : undefined;
      if (existing) { assert(existing.status === 'DRAFT', 'Issued quotations are immutable. Create a revision.'); assert(existing.leadId === lead.id, 'A quotation cannot move to another lead.'); }
      assert(new Set(p.items.map((line: QuoteItemInput) => line.id)).size === p.items.length, 'Every work item must have a unique ID.');
      validateQuoteCategories(p.items);
      // Older open clients submit explicit positive rates without the new flag.
      // Edits always retain the saved treatment unless the user changes it.
      const gstEnabled = p.gstEnabled ?? (existing ? existing.gstEnabled !== false : p.items.some((line: QuoteItemInput) => Number(line.gstRate) > 0));
      const inputs: QuoteItemInput[] = p.items.map((line: QuoteItemInput) => {
        const saved = existing?.items.find(item => item.id === line.id);
        return { ...line, hsnSac: line.hsnSac ?? saved?.hsnSac ?? '', discount: line.discount ?? saved?.discount ?? '0' };
      });
      const calculated = calculate(inputs, data.company.stateCode, p.placeOfSupply, gstEnabled);
      const record: Quotation = { ...p, ...calculated, itemSchemaVersion: QUOTE_ITEM_SCHEMA_VERSION, gstEnabled, id: existing?.id ?? crypto.randomUUID(), number: null, status: 'DRAFT',
        revision: existing?.revision ?? 1, ...(existing?.revisionOf ? { revisionOf: existing.revisionOf } : {}),
        acceptanceNote: '', isDemo: lead.isDemo, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
      if (existing) Object.assign(existing, record); else data.quotations.push(record);
      audit(data, action, 'quotation', record.id, `${existing ? 'Updated' : 'Created'} draft quotation ${record.title}`, stamp);
      return 'Draft quotation saved.';
    }
    case 'quote_issue': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'DRAFT', 'Only a draft quotation can be issued.');
      validateQuoteCategories(quote.items);
      const lead = get(data.leads, quote.leadId, 'Lead');
      assert(lead.status !== 'LOST', 'Reopen the lost lead before issuing its quotation.');
      const customer = get(data.customers, lead.customerId, 'Customer');
      assert(data.company.legalName && data.company.address, 'Add the genuine company legal name and registered address in Settings first.');
      const gstEnabled = quote.gstEnabled !== false;
      validateGst(data.company.gstin, data.company.stateCode, gstEnabled); validateGst(customer.gstin, customer.stateCode);
      assert(customer.address, 'Add the customer billing address before issue.');
      assert(quote.siteAddress, 'Add the project address before issue.');
      assert(!gstEnabled || quote.placeOfSupply, 'Add the project place of supply before issue.');
      assert(quote.validUntil >= today, 'The quotation validity date has passed. Update the draft.');
      assert(quote.items.length > 0, 'Add at least one work item.');
      const calculated = calculate(quoteInputs(quote), data.company.stateCode, quote.placeOfSupply, gstEnabled);
      assert(!calculated.totals.needsConfig, 'Configure the supplier and project states before issue.');
      Object.assign(quote, calculated, { itemSchemaVersion: QUOTE_ITEM_SCHEMA_VERSION, supplier: clone(data.company), customer: clone(customer), number: nextNumber(data, 'Q', now),
        status: 'ISSUED', issuedAt: stamp, updatedAt: stamp });
      if (lead.status !== 'WON') { lead.status = 'QUOTED'; lead.updatedAt = stamp; }
      audit(data, action, 'quotation', quote.id, `Issued quotation ${quote.number}`, stamp);
      return 'Quotation issued. Its prices and details are now locked.';
    }
    case 'quote_accept': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'ISSUED', 'Only a current issued quotation can be accepted.');
      assert(quote.validUntil >= today, 'The quotation has expired. Create and issue a revision.');
      const lead = get(data.leads, quote.leadId, 'Lead');
      assert(lead.status !== 'LOST', 'Reopen the lost lead before recording acceptance.');
      quote.status = 'ACCEPTED'; quote.acceptanceNote = p.acceptanceNote; quote.acceptedAt = stamp; quote.updatedAt = stamp;
      lead.status = 'WON'; lead.lostReason = ''; lead.updatedAt = stamp;
      const order = ensureWonWorkOrder(data, lead, action, now, quote);
      audit(data, action, 'quotation', quote.id, `Recorded customer acceptance for ${quote.number}`, stamp);
      return `Quotation accepted, lead marked won and work order ${order.number} ready.`;
    }
    case 'quote_decline': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'ISSUED', 'Only an issued quotation can be declined.');
      quote.status = 'DECLINED'; quote.updatedAt = stamp;
      audit(data, action, 'quotation', quote.id, `Quotation ${quote.number} declined`, stamp);
      return 'Quotation marked declined.';
    }
    case 'quote_expire':
    case 'quote_reopen': {
      const quote = get(data.quotations, p.id, 'Quotation');
      if (action === 'quote_expire') {
        assert(quote.status === 'ISSUED', 'Only an issued quotation can be marked expired.');
        quote.status = 'EXPIRED';
      } else {
        assert(quote.status === 'EXPIRED', 'Only an expired quotation can be reopened.');
        assert(quote.validUntil >= today, 'The quotation validity date has passed. Create and issue a revision.');
        quote.status = 'ISSUED';
      }
      quote.updatedAt = stamp;
      audit(data, action, 'quotation', quote.id, action === 'quote_expire' ? `Marked quotation ${quote.number} expired` : `Reopened quotation ${quote.number} for approval`, stamp);
      return action === 'quote_expire' ? 'Quotation marked expired.' : 'Quotation reopened for approval.';
    }
    case 'quote_revise': {
      const original = get(data.quotations, p.id, 'Quotation');
      assert(['ISSUED', 'DECLINED', 'EXPIRED'].includes(original.status), 'Only issued, declined or expired quotations can be revised.');
      assert(!data.quotations.some(q => q.revisionOf === original.id), 'A newer revision already exists.');
      const inputs = quoteInputs(original).map(line => ({ ...line, id: crypto.randomUUID() }));
      const gstEnabled = original.gstEnabled !== false;
      const calculated = calculate(inputs, data.company.stateCode, original.placeOfSupply, gstEnabled);
      const extended = todayIST(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
      const revised: Quotation = { id: crypto.randomUUID(), leadId: original.leadId, number: null, title: original.title,
        validUntil: original.validUntil > extended ? original.validUntil : extended, placeOfSupply: original.placeOfSupply,
        siteAddress: original.siteAddress, terms: original.terms, ...calculated, gstEnabled,
        ...(original.itemSchemaVersion ? { itemSchemaVersion: original.itemSchemaVersion } : {}), status: 'DRAFT', revision: original.revision + 1,
        revisionOf: original.id, acceptanceNote: '', isDemo: original.isDemo, createdAt: stamp, updatedAt: stamp };
      original.status = 'SUPERSEDED'; original.updatedAt = stamp; data.quotations.push(revised);
      audit(data, action, 'quotation', revised.id, `Created revision ${revised.revision} of ${original.number}`, stamp);
      return 'New draft revision created. The previous quotation is superseded.';
    }
    case 'quote_convert': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'ACCEPTED', 'Accept the quotation before creating a work order.');
      const existing = data.workorders.find(order => order.quoteId === quote.id);
      if (existing) return `Work order ${existing.number} already exists.`;
      const lead = get(data.leads, quote.leadId, 'Lead');
      const record = ensureWonWorkOrder(data, lead, action, now, quote);
      return `Work order ${record.number} ready.`;
    }
    case 'workorder_paper_filing': {
      const order = get(data.workorders, p.id, 'Work order');
      assert(!order.isDemo && order.status !== 'CANCELLED', 'Choose a real work order that has not been cancelled.');
      const key = p.document as WorkDocumentKey;
      assert((order.paperDocuments?.[key] ?? 'PENDING') !== p.documentStatus, 'This document already has that status.');
      order.paperDocuments = { ...order.paperDocuments, [key]: p.documentStatus };
      order.updatedAt = stamp;
      audit(data, action, 'workorder', order.id, `${order.number}: ${DOCUMENT_NAMES[key]} marked ${p.documentStatus.toLowerCase()}`, stamp);
      return 'Document status saved.';
    }
    case 'workorder_save': {
      const order = get(data.workorders, p.id, 'Work order');
      const previous = order.status;
      const statusOnly = !('owner' in p);
      if (!(statusOnly && previous === 'COMPLETED' && p.status === 'ACTIVE')) assertOpenOrder(order);
      const status: WorkStatus = p.status;
      assert(status === previous || WORK_TRANSITIONS[previous].includes(status), 'That work-order status change is not allowed.');
      assert(p.status !== 'COMPLETED' || order.milestones.every(m => m.status === 'DONE'), 'Complete the pending milestones before closing this work order.');
      if (!statusOnly) {
        checkOwner(data, p.owner);
        assert(!p.startDate || !p.endDate || p.endDate >= p.startDate, 'End date cannot precede start date.');
        Object.assign(order, { owner: p.owner, startDate: p.startDate, endDate: p.endDate });
      }
      order.status = status;
      order.updatedAt = stamp;
      const description = status === previous ? `Updated work order ${order.number}` : `${order.number}: ${WORK_LABELS[previous]} → ${WORK_LABELS[status]}`;
      audit(data, action, 'workorder', order.id, description, stamp);
      return 'Work order updated.';
    }
    case 'milestone_add': {
      const order = get(data.workorders, p.workorderId, 'Work order'); assertOpenOrder(order);
      assert(order.milestones.length < 100, 'A work order supports up to 100 milestones.');
      order.milestones.push({ id: crypto.randomUUID(), title: p.title, dueDate: p.dueDate, status: 'PENDING' }); order.updatedAt = stamp;
      audit(data, action, 'workorder', order.id, `Added milestone ${p.title}`, stamp);
      return 'Milestone added.';
    }
    case 'milestone_complete': {
      const order = get(data.workorders, p.workorderId, 'Work order'); assertOpenOrder(order);
      const milestone = get(order.milestones, p.milestoneId, 'Milestone');
      assert(milestone.status === 'PENDING', 'This milestone is already completed.');
      milestone.status = 'DONE'; milestone.completedAt = stamp; order.updatedAt = stamp;
      audit(data, action, 'workorder', order.id, `Completed milestone ${milestone.title}`, stamp);
      return 'Milestone completed.';
    }
    case 'company_save': {
      validateGst(p.gstin, p.stateCode);
      data.company = { ...p, currency: 'INR', timeZone: 'Asia/Kolkata' } as Company;
      for (const quote of data.quotations.filter(q => q.status === 'DRAFT')) {
        Object.assign(quote, calculate(quoteInputs(quote), data.company.stateCode, quote.placeOfSupply, quote.gstEnabled !== false), { updatedAt: stamp });
      }
      audit(data, action, 'company', '1', 'Updated company registration and contact settings', stamp);
      return 'Company settings saved. Issued documents remain unchanged.';
    }
    case 'member_role': {
      const target = data.members.find(member => member.userId === p.userId);
      assert(target && target.active, 'Choose an active team member.');
      assert(target.userId !== data.user.userId || p.role === 'OWNER', 'You cannot remove your own owner role.');
      assert(target.role !== 'OWNER' || p.role === 'OWNER' || data.members.filter(m => m.active && m.role === 'OWNER').length > 1, 'The workspace must retain an owner.');
      target.role = p.role;
      audit(data, action, 'member', target.userId, `Changed ${target.name}'s role to ${p.role.toLowerCase()}`, stamp);
      return 'Team role updated.';
    }
    case 'member_active': {
      const target = data.members.find(member => member.userId === p.userId);
      assert(target, 'Choose an existing team member.');
      assert(target.userId !== data.user.userId || p.active, 'You cannot disable your own account.');
      assert(p.active || target.role !== 'OWNER' || !target.active || data.members.filter(m => m.active && m.role === 'OWNER').length > 1, 'The workspace must retain an active owner.');
      if (target.active === p.active) return p.active ? 'Team member is already active.' : 'Team member is already disabled.';
      target.active = p.active;
      audit(data, action, 'member', target.userId, `${p.active ? 'Enabled' : 'Disabled'} ${target.name}'s CRM access`, stamp);
      return p.active ? 'Team member enabled.' : 'Team member disabled. Their existing session can no longer access CRM data.';
    }
    case 'load_demo': {
      if (data.customers.some(c => c.isDemo) || data.leads.some(l => l.isDemo)) return 'Example records are already loaded.';
      const demo = createDemoData(now);
      data.customers.push(...demo.customers); data.leads.push(...demo.leads); data.followups.push(...demo.followups);
      data.quotations.push(...demo.quotations); data.workorders.push(...demo.workorders); data.activity.unshift(...demo.activity);
      audit(data, action, 'workspace', '1', 'Loaded clearly labelled example records', stamp);
      return 'Example records loaded. Company registration settings were not changed.';
    }
    case 'clear_demo': {
      // Keep any ancestor referenced by a real record, even if old imported data has mixed flags.
      const keepQuotes = new Set(data.quotations.filter(q => !q.isDemo).map(q => q.id));
      for (const order of data.workorders.filter(o => !o.isDemo && o.quoteId)) keepQuotes.add(order.quoteId!);
      let grew = true;
      while (grew) { grew = false; for (const quote of data.quotations) if (keepQuotes.has(quote.id) && quote.revisionOf && !keepQuotes.has(quote.revisionOf)) { keepQuotes.add(quote.revisionOf); grew = true; } }
      const keepLeads = new Set(data.leads.filter(l => !l.isDemo).map(l => l.id));
      for (const order of data.workorders.filter(o => !o.isDemo && o.leadId)) keepLeads.add(order.leadId!);
      for (const followup of data.followups.filter(f => !f.isDemo)) keepLeads.add(followup.leadId);
      for (const quote of data.quotations.filter(q => keepQuotes.has(q.id))) keepLeads.add(quote.leadId);
      const keepCustomers = new Set(data.customers.filter(c => !c.isDemo).map(c => c.id));
      for (const lead of data.leads.filter(l => keepLeads.has(l.id))) keepCustomers.add(lead.customerId);
      data.workorders = data.workorders.filter(o => !o.isDemo);
      data.quotations = data.quotations.filter(q => !q.isDemo || keepQuotes.has(q.id));
      data.followups = data.followups.filter(f => !f.isDemo);
      data.leads = data.leads.filter(l => !l.isDemo || keepLeads.has(l.id));
      data.customers = data.customers.filter(c => !c.isDemo || keepCustomers.has(c.id));
      data.activity = data.activity.filter(a => !a.id.startsWith('demo_'));
      audit(data, action, 'workspace', '1', 'Cleared example records; real records retained', stamp);
      return 'Example records cleared. Your real records are preserved.';
    }
    default: throw new CRMError('Unknown workspace action.');
  }
}
