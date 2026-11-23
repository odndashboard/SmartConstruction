/** Pure, validated business mutations. Persistence and authenticated identity live in server.ts. */
import { z } from 'zod';
import { computeQuote, validateRegistration, parseMoney, todayIST, financialYear, STATE_OPTIONS } from './finance.ts';
import { createDemoData } from './demo.ts';
import type { WorkspaceData, Role, Lead, LeadStatus, Quotation, WorkOrder, WorkStatus, QuoteItemInput, Company } from './types';

export class CRMError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'CRMError'; this.status = status; }
}
const text = (max = 200) => z.string().trim().max(max);
const required = (max = 200) => text(max).min(1, 'This field is required.');
const blank = (max = 200) => text(max).default('');
const id = required(120);
const email = z.union([z.string().trim().email().max(254), z.literal('')]).default('');
const state = z.string().refine(v => !v || STATE_OPTIONS.some(s => s.value === v), 'Choose a valid Indian state.').default('');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'Enter a valid calendar date.');
const optionalDate = z.union([date, z.literal('')]).default('');
const role = z.enum(['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'VIEWER']);
const leadStatus = z.enum(['NEW', 'CONTACTED', 'SITE_VISIT', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST']);
const workStatus = z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
const owner = blank(200);
const identity = z.object({ id }).strict();
const item = z.object({
  id, description: required(2000), hsnSac: text(8).default(''), quantity: required(30), unit: required(24),
  unitPrice: required(30), discount: text(30).default('0'), gstRate: required(30),
}).strict();
const schemas: Record<string, z.ZodTypeAny> = {
  customer_save: z.object({ id: id.optional(), name: required(), contact: blank(), phone: blank(40), email, address: blank(2000), stateCode: state, gstin: blank(15) }).strict(),
  lead_save: z.object({ id: id.optional(), customerId: id, title: required(), contact: blank(), phone: blank(40), email,
    location: blank(), siteAddress: blank(2000), stateCode: state, value: text(30).default('0'), status: leadStatus.default('NEW'),
    source: blank(100), owner, priority: z.enum(['High', 'Medium', 'Low']).default('Medium'), notes: blank(10000) }).strict(),
  lead_status: z.object({ id, status: leadStatus, lostReason: blank(3000) }).strict(),
  followup_save: z.object({ id: id.optional(), leadId: id, title: required(), dueAt: z.string().datetime({ offset: true }),
    channel: z.enum(['Call', 'WhatsApp', 'Email', 'Site visit', 'Other']), owner, notes: blank(5000) }).strict(),
  followup_complete: z.object({ id, outcome: required(5000) }).strict(),
  followup_cancel: identity,
  quote_save: z.object({ id: id.optional(), leadId: id, title: required(), validUntil: date, placeOfSupply: state,
    siteAddress: blank(2000), terms: blank(12000), items: z.array(item).max(100) }).strict(),
  quote_issue: identity,
  quote_accept: z.object({ id, acceptanceNote: required(5000) }).strict(),
  quote_decline: identity,
  quote_revise: identity,
  quote_convert: identity,
  workorder_save: z.object({ id, owner, startDate: optionalDate, endDate: optionalDate, status: workStatus }).strict(),
  milestone_add: z.object({ workorderId: id, title: required(), dueDate: optionalDate }).strict(),
  milestone_complete: z.object({ workorderId: id, milestoneId: id }).strict(),
  company_save: z.object({ name: required(), legalName: blank(), address: blank(2000), gstin: blank(15), stateCode: state,
    phone: blank(40), email, website: blank(500).refine(v => !v || /^https?:\/\//i.test(v), 'Website must begin with https:// or http://.'), terms: blank(12000) }).strict(),
  member_role: z.object({ userId: id, role }).strict(),
  load_demo: z.object({}).strict(),
  clear_demo: z.object({}).strict(),
};
const SALES: Role[] = ['OWNER', 'MANAGER', 'SALES'];
const APPROVE: Role[] = ['OWNER', 'MANAGER'];
const DELIVERY: Role[] = ['OWNER', 'MANAGER', 'OPERATIONS'];
const FOLLOW: Role[] = ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS'];
const permission: Record<string, Role[]> = {
  customer_save: SALES, lead_save: SALES, lead_status: SALES,
  followup_save: FOLLOW, followup_complete: FOLLOW, followup_cancel: FOLLOW,
  quote_save: SALES, quote_revise: SALES,
  quote_issue: APPROVE, quote_accept: APPROVE, quote_decline: APPROVE, quote_convert: APPROVE,
  workorder_save: DELIVERY, milestone_add: DELIVERY, milestone_complete: DELIVERY,
  company_save: ['OWNER'], member_role: ['OWNER'], load_demo: ['OWNER'], clear_demo: ['OWNER'],
};
const workTransitions: Record<WorkStatus, WorkStatus[]> = {
  PLANNED: ['ACTIVE', 'CANCELLED'], ACTIVE: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'], COMPLETED: [], CANCELLED: [],
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
  assert(target !== 'WON' || lead.status === 'WON', 'Won status is recorded by accepting a quotation.');
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
function calculate(items: QuoteItemInput[], supplierState: string, placeOfSupply: string) {
  try { return computeQuote(items, supplierState, placeOfSupply); }
  catch (error) { throw new CRMError(error instanceof Error ? error.message : 'Check quotation values.'); }
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
  return quote.items.map(({ id, description, hsnSac, quantity, unit, unitPrice, discount, gstRate }) => ({ id, description, hsnSac, quantity, unit, unitPrice, discount, gstRate }));
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
      const customer = get(data.customers, p.customerId, 'Customer');
      const existing = p.id ? get(data.leads, p.id, 'Lead') : undefined;
      checkOwner(data, p.owner);
      checkLeadTransition(existing ?? { status: 'NEW', lostReason: '' }, p.status, existing?.lostReason ?? '');
      if (existing && existing.customerId !== customer.id) {
        assert(existing.isDemo === customer.isDemo, 'Example and real customer records cannot be mixed.');
        assert(!data.quotations.some(q => q.leadId === existing.id && q.status !== 'DRAFT'), 'A lead with issued quotations cannot move to another customer.');
      }
      const record: Lead = { ...p, id: existing?.id ?? crypto.randomUUID(), value: inputMoney(p.value),
        lostReason: p.status === 'LOST' ? existing?.lostReason ?? '' : '', isDemo: customer.isDemo,
        createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
      if (existing) Object.assign(existing, record); else data.leads.push(record);
      audit(data, action, 'lead', record.id, `${existing ? 'Updated' : 'Added'} lead ${record.title}`, stamp);
      return 'Lead saved.';
    }
    case 'lead_status': {
      const lead = get(data.leads, p.id, 'Lead');
      checkLeadTransition(lead, p.status, p.lostReason || lead.lostReason);
      lead.status = p.status; lead.lostReason = p.status === 'LOST' ? p.lostReason || lead.lostReason : ''; lead.updatedAt = stamp;
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
      const calculated = calculate(p.items, data.company.stateCode, p.placeOfSupply);
      const record: Quotation = { ...p, ...calculated, id: existing?.id ?? crypto.randomUUID(), number: null, status: 'DRAFT',
        revision: existing?.revision ?? 1, ...(existing?.revisionOf ? { revisionOf: existing.revisionOf } : {}),
        acceptanceNote: '', isDemo: lead.isDemo, createdAt: existing?.createdAt ?? stamp, updatedAt: stamp };
      if (existing) Object.assign(existing, record); else data.quotations.push(record);
      audit(data, action, 'quotation', record.id, `${existing ? 'Updated' : 'Created'} draft quotation ${record.title}`, stamp);
      return 'Draft quotation saved.';
    }
    case 'quote_issue': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'DRAFT', 'Only a draft quotation can be issued.');
      const lead = get(data.leads, quote.leadId, 'Lead');
      assert(lead.status !== 'LOST', 'Reopen the lost lead before issuing its quotation.');
      const customer = get(data.customers, lead.customerId, 'Customer');
      assert(data.company.legalName && data.company.address, 'Add the genuine company legal name and registered address in Settings first.');
      validateGst(data.company.gstin, data.company.stateCode, true); validateGst(customer.gstin, customer.stateCode);
      assert(customer.address, 'Add the customer billing address before issue.');
      assert(quote.siteAddress && quote.placeOfSupply, 'Add the project address and place of supply before issue.');
      assert(quote.validUntil >= today, 'The quotation validity date has passed. Update the draft.');
      assert(quote.items.length > 0, 'Add at least one work item.');
      assert(quote.items.every(line => /^\d{4,8}$/.test(line.hsnSac)), 'Each item requires a reviewed 4–8 digit HSN/SAC code.');
      const calculated = calculate(quoteInputs(quote), data.company.stateCode, quote.placeOfSupply);
      assert(!calculated.totals.needsConfig, 'Configure the supplier and project states before issue.');
      Object.assign(quote, calculated, { supplier: clone(data.company), customer: clone(customer), number: nextNumber(data, 'Q', now),
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
      audit(data, action, 'quotation', quote.id, `Recorded customer acceptance for ${quote.number}`, stamp);
      return 'Quotation accepted and lead marked won.';
    }
    case 'quote_decline': {
      const quote = get(data.quotations, p.id, 'Quotation');
      assert(quote.status === 'ISSUED', 'Only an issued quotation can be declined.');
      quote.status = 'DECLINED'; quote.updatedAt = stamp;
      audit(data, action, 'quotation', quote.id, `Quotation ${quote.number} declined`, stamp);
      return 'Quotation marked declined.';
    }
    case 'quote_revise': {
      const original = get(data.quotations, p.id, 'Quotation');
      assert(['ISSUED', 'DECLINED', 'EXPIRED'].includes(original.status), 'Only issued, declined or expired quotations can be revised.');
      assert(!data.quotations.some(q => q.revisionOf === original.id), 'A newer revision already exists.');
      const inputs = quoteInputs(original).map(line => ({ ...line, id: crypto.randomUUID() }));
      const calculated = calculate(inputs, data.company.stateCode, original.placeOfSupply);
      const extended = todayIST(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000));
      const revised: Quotation = { id: crypto.randomUUID(), leadId: original.leadId, number: null, title: original.title,
        validUntil: original.validUntil > extended ? original.validUntil : extended, placeOfSupply: original.placeOfSupply,
        siteAddress: original.siteAddress, terms: original.terms, ...calculated, status: 'DRAFT', revision: original.revision + 1,
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
      const record: WorkOrder = { id: crypto.randomUUID(), quoteId: quote.id, number: nextNumber(data, 'WO', now),
        title: quote.title, customerName: quote.customer?.name ?? '', siteAddress: quote.siteAddress, owner: '', startDate: '', endDate: '',
        status: 'PLANNED', snapshot: clone(quote), milestones: [], isDemo: quote.isDemo, createdAt: stamp, updatedAt: stamp };
      data.workorders.push(record); audit(data, action, 'workorder', record.id, `Created work order ${record.number}`, stamp);
      return `Work order ${record.number} created.`;
    }
    case 'workorder_save': {
      const order = get(data.workorders, p.id, 'Work order'); assertOpenOrder(order); checkOwner(data, p.owner);
      assert(p.status === order.status || workTransitions[order.status].includes(p.status), 'That work-order status change is not allowed.');
      assert(!p.startDate || !p.endDate || p.endDate >= p.startDate, 'End date cannot precede start date.');
      assert(p.status !== 'COMPLETED' || order.milestones.every(m => m.status === 'DONE'), 'Complete the pending milestones before closing this work order.');
      Object.assign(order, { owner: p.owner, startDate: p.startDate, endDate: p.endDate, status: p.status, updatedAt: stamp });
      audit(data, action, 'workorder', order.id, `Updated work order ${order.number}`, stamp);
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
        Object.assign(quote, calculate(quoteInputs(quote), data.company.stateCode, quote.placeOfSupply), { updatedAt: stamp });
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
      for (const order of data.workorders.filter(o => !o.isDemo)) keepQuotes.add(order.quoteId);
      let grew = true;
      while (grew) { grew = false; for (const quote of data.quotations) if (keepQuotes.has(quote.id) && quote.revisionOf && !keepQuotes.has(quote.revisionOf)) { keepQuotes.add(quote.revisionOf); grew = true; } }
      const keepLeads = new Set(data.leads.filter(l => !l.isDemo).map(l => l.id));
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
