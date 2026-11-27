'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FollowUp, Lead, LeadStatus, Quotation, WorkspaceData, WorkOrder } from '@/lib/types';
import { LEAD_STAGES } from '@/lib/types';
import { todayIST } from '@/lib/finance';
import { effectiveQuoteStatus } from '@/lib/quotation-status';
import { getFollowupQuotationContext } from '@/lib/followup-quotation';
import { DOCUMENT_KEYS, DOCUMENT_NAMES } from '@/lib/work-documents';
import { WORK_LABELS, WORK_TRANSITIONS } from '@/lib/work-order-status';
import { canRecordWorkOrderPayment } from '@/lib/work-order-payments';
import styles from './SimpleWorkspace.module.css';

export type SimpleWorkspaceTarget = { type: string; id?: string; leadId?: string; workId?: string };
export interface SimpleWorkspaceProps {
  workspace: WorkspaceData;
  busy: boolean;
  open: (target: SimpleWorkspaceTarget) => void;
  onRefresh: () => void | Promise<void>;
}
type View = 'leads' | 'followups' | 'workorders';
type Permissions = { commercial: boolean; approve: boolean; follow: boolean; delivery: boolean; owner: boolean };
const STAFF_ROLES = ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT'];
const LEAD_LABELS: Record<LeadStatus, string> = {
  NEW: 'New enquiry', CONTACTED: 'Contacted', SITE_VISIT: 'Site visit', QUOTED: 'Quoted',
  NEGOTIATION: 'Negotiation', WON: 'Approved / Won', LOST: 'Not approved / Lost',
};
const QUOTE_LABELS = { DRAFT: 'Draft · not issued', ISSUED: 'Awaiting approval', ACCEPTED: 'Accepted', EXPIRED: 'Expired', DECLINED: 'Declined', SUPERSEDED: 'Superseded' };
const PAGE_SIZE = 8;
function permissionFor(workspace: WorkspaceData): Permissions {
  const role = workspace.user.role;
  return { commercial: ['OWNER', 'MANAGER', 'SALES'].includes(role), approve: ['OWNER', 'MANAGER'].includes(role),
    follow: ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS'].includes(role), delivery: ['OWNER', 'MANAGER', 'OPERATIONS'].includes(role), owner: role === 'OWNER' };
}
function dueLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date not available';
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
function matching(search: string, ...values: (string | undefined)[]) { return !search || values.some(value => value?.toLocaleLowerCase().includes(search)); }
function missingDocuments(order: WorkOrder) { return DOCUMENT_KEYS.filter(key => order.paperDocuments?.[key] !== 'RECEIVED'); }
function quoteAction(quote: Quotation, permissions: Permissions): { label: string; type: string } {
  if (permissions.approve && ['DRAFT', 'ISSUED', 'EXPIRED'].includes(quote.status)) return { label: quote.status === 'DRAFT' ? 'Review & issue' : 'Update quotation', type: 'quote_status' };
  if (permissions.commercial && quote.status === 'DRAFT') return { label: 'Edit draft', type: 'quote' };
  return { label: 'View quotation', type: 'quote_detail' };
}

export default function SimpleWorkspace(props: SimpleWorkspaceProps) {
  if (!props.workspace.user.active || !STAFF_ROLES.includes(props.workspace.user.role)) {
    return <section className={styles.empty}><h1>Your workspace</h1><p>{props.workspace.user.role === 'DEALER' ? 'Use your dealer portal to add and follow your own leads.' : 'Your workspace access has changed. Sign in again to continue.'}</p>{props.workspace.user.active && props.workspace.user.role === 'DEALER' && <a href="/dealer">Open dealer portal</a>}</section>;
  }
  return <SimpleWorkspaceContent {...props} />;
}

function SimpleWorkspaceContent({ workspace, busy, open, onRefresh }: SimpleWorkspaceProps) {
  const [view, setView] = useState<View>('leads');
  const [search, setSearch] = useState('');
  const [leadStatus, setLeadStatus] = useState('ALL');
  const [followStatus, setFollowStatus] = useState('OPEN');
  const [workStatus, setWorkStatus] = useState('OPEN');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(() => new Date());
  const refreshingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const permissions = permissionFor(workspace);
  const disabled = busy || refreshing;
  const needle = search.trim().toLocaleLowerCase();
  const related = useMemo(() => {
    const customers = new Map(workspace.customers.map(customer => [customer.id, customer]));
    const leads = new Map(workspace.leads.map(lead => [lead.id, lead]));
    const quotations = new Map<string, Quotation[]>();
    const quoteById = new Map(workspace.quotations.map(quote => [quote.id, quote]));
    const workorders = new Map<string, WorkOrder[]>();
    for (const order of workspace.workorders) {
      const leadId = order.leadId || order.snapshot?.leadId || (order.quoteId ? quoteById.get(order.quoteId)?.leadId : undefined);
      const lead = leadId ? leads.get(leadId) : undefined;
      if (!lead || !!order.isDemo !== !!lead.isDemo) continue;
      const rows = workorders.get(lead.id);
      if (rows) rows.push(order); else workorders.set(lead.id, [order]);
    }
    for (const quote of workspace.quotations) {
      const lead = leads.get(quote.leadId);
      if (!lead || !!quote.isDemo !== !!lead.isDemo) continue;
      const rows = quotations.get(quote.leadId);
      if (rows) rows.push(quote); else quotations.set(quote.leadId, [quote]);
    }
    const openFollowupLeadIds = new Set(workspace.followups.filter(item => item.status === 'OPEN').map(item => item.leadId));
    const followupHistoryLeadIds = new Set(workspace.followups.map(item => item.leadId));
    return { customers, leads, quotations, workorders, openFollowupLeadIds, followupHistoryLeadIds };
  }, [workspace.customers, workspace.leads, workspace.quotations, workspace.followups, workspace.workorders]);
  const visibleLeads = useMemo(() => workspace.leads.filter(lead => (leadStatus === 'ALL' || lead.status === leadStatus)
    && matching(needle, lead.title, lead.contact, lead.phone, lead.siteAddress, related.customers.get(lead.customerId)?.name)), [workspace.leads, leadStatus, needle, related.customers]);
  const visibleFollowups = useMemo(() => workspace.followups.filter(item => (followStatus === 'ALL' || item.status === followStatus)
    && matching(needle, item.title, related.leads.get(item.leadId)?.title)).sort((a, b) => a.dueAt.localeCompare(b.dueAt)), [workspace.followups, followStatus, needle, related.leads]);
  const approvedToSchedule = useMemo(() => workspace.leads.filter(lead => lead.status === 'WON' && !lead.isDemo && !related.followupHistoryLeadIds.has(lead.id)
    && matching(needle, lead.title, lead.contact, lead.phone, lead.siteAddress, related.customers.get(lead.customerId)?.name)), [workspace.leads, needle, related.followupHistoryLeadIds, related.customers]);
  const visibleOrders = useMemo(() => workspace.workorders.filter(order => (workStatus === 'ALL' || workStatus === 'OPEN' && !['COMPLETED', 'CANCELLED'].includes(order.status) || workStatus === order.status)
    && matching(needle, order.title, order.number, order.customerName, order.siteAddress)), [workspace.workorders, workStatus, needle]);
  const count = view === 'leads' ? visibleLeads.length : view === 'followups' ? visibleFollowups.length : visibleOrders.length;
  const openFollowups = workspace.followups.reduce((total, item) => total + Number(item.status === 'OPEN'), 0);
  const openOrders = workspace.workorders.reduce((total, item) => total + Number(!['COMPLETED', 'CANCELLED'].includes(item.status)), 0);
  function selectView(next: View) { setView(next); setLimit(PAGE_SIZE); setClock(new Date()); }
  async function refresh() {
    if (busy || refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true); setError('');
    try { await onRefresh(); } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not refresh. Please try again.'); }
    finally { refreshingRef.current = false; if (mounted.current) { setRefreshing(false); setClock(new Date()); } }
  }
  return <section className={styles.workspace} aria-label="Simple workspace">
    <header className={styles.heading}><div><h1>Your work</h1><p>Leads, next calls and jobs in one place.</p></div><div className={styles.headingActions}>
      <button type="button" className={styles.secondary} disabled={disabled} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
      {permissions.commercial && <button type="button" className={styles.primary} disabled={disabled} onClick={() => open({ type: 'lead' })}>Add lead</button>}
    </div></header>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.views} role="group" aria-label="Choose a task">
      <button type="button" aria-pressed={view === 'leads'} onClick={() => selectView('leads')}>Leads <span>{workspace.leads.length}</span></button>
      <button type="button" aria-pressed={view === 'followups'} onClick={() => selectView('followups')}>Follow-ups <span>{openFollowups}</span></button>
      <button type="button" aria-pressed={view === 'workorders'} onClick={() => selectView('workorders')}>Work orders <span>{openOrders}</span></button>
    </div>
    <div className={styles.filters}><label className={styles.search}><span>Find a project</span><input type="search" value={search} onChange={event => { setSearch(event.target.value); setLimit(PAGE_SIZE); }} placeholder="Project, customer or phone" /></label>
      <label><span>{view === 'leads' ? 'Lead status' : view === 'followups' ? 'Follow-up status' : 'Job status'}</span>
        {view === 'leads' ? <select value={leadStatus} onChange={event => { setLeadStatus(event.target.value); setLimit(PAGE_SIZE); }}><option value="ALL">All leads</option>{LEAD_STAGES.map(stage => <option key={stage.value} value={stage.value}>{LEAD_LABELS[stage.value]}</option>)}</select>
          : view === 'followups' ? <select value={followStatus} onChange={event => { setFollowStatus(event.target.value); setLimit(PAGE_SIZE); }}><option value="OPEN">To do</option><option value="DONE">Completed</option><option value="CANCELLED">Cancelled</option><option value="ALL">All follow-ups</option></select>
            : <select value={workStatus} onChange={event => { setWorkStatus(event.target.value); setLimit(PAGE_SIZE); }}><option value="OPEN">Current jobs</option>{Object.entries(WORK_LABELS).map(([status, label]) => <option key={status} value={status}>{label}</option>)}<option value="ALL">All work orders</option></select>}
      </label></div>
    <div className={styles.sectionHeading}><h2>{view === 'leads' ? 'Leads' : view === 'followups' ? 'Follow-ups' : 'Work orders'} <span>{count}</span></h2>
      {view === 'followups' && permissions.follow && <button type="button" className={styles.textButton} disabled={disabled} onClick={() => open({ type: 'followup' })}>Schedule follow-up</button>}
    </div>
    {view === 'leads' && <p className={styles.hint}>Approved / Won confirms the lead and creates a planned work order. Not approved / Lost closes it with a reason.</p>}
    {view === 'workorders' && <p className={styles.hint}>Check the job, update document statuses and record actual work as it happens.</p>}
    {view === 'followups' && permissions.follow && approvedToSchedule.length > 0 && <details className={styles.scheduleMissing}>
      <summary>Approved leads to schedule ({approvedToSchedule.length})</summary>
      <p className={styles.hint}>No follow-up has been recorded for these approved leads.</p>
      {approvedToSchedule.map(lead => <div className={styles.scheduleRow} key={lead.id}><strong>{lead.title}</strong><button type="button" className={styles.textButton} disabled={disabled} aria-label={`Schedule first follow-up for ${lead.title}`} onClick={() => open({ type: 'followup', leadId: lead.id })}>Schedule follow-up</button></div>)}
    </details>}
    <div className={styles.records}>
      {view === 'leads' && visibleLeads.slice(0, limit).map(lead => <SimpleLead key={lead.id} lead={lead} quotes={related.quotations.get(lead.id) || []} workorders={related.workorders.get(lead.id) || []} customerName={related.customers.get(lead.customerId)?.name} hasOpenFollowup={related.openFollowupLeadIds.has(lead.id)} permissions={permissions} open={open} disabled={disabled} />)}
      {view === 'followups' && visibleFollowups.slice(0, limit).map(item => <SimpleFollowup key={item.id} item={item} now={clock} workspace={workspace} lead={related.leads.get(item.leadId)} permissions={permissions} open={open} disabled={disabled} />)}
      {view === 'workorders' && visibleOrders.slice(0, limit).map(order => <SimpleOrder key={order.id} order={order} workspace={workspace} permissions={permissions} open={open} disabled={disabled} />)}
    </div>
    {!count && <div className={styles.empty}><h3>{needle ? 'No matching projects' : view === 'leads' ? 'No leads in this view' : view === 'followups' ? 'No follow-ups in this view' : 'No work orders in this view'}</h3><p>{needle ? 'Try another project name or clear your search.' : view === 'leads' ? 'Add a lead, or choose another status above.' : view === 'followups' ? 'Schedule the next call or visit when it is agreed.' : 'A planned work order appears when a lead is approved. Each accepted quotation has its own work order.'}</p></div>}
    {count > limit && <button type="button" className={styles.more} onClick={() => setLimit(value => value + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, count - limit)} more · {count - limit} remaining</button>}
  </section>;
}

type RowProps = { permissions: Permissions; open: SimpleWorkspaceProps['open']; disabled: boolean };
function SimpleLead({ lead, quotes, workorders, customerName, hasOpenFollowup, permissions, open, disabled }: RowProps & { lead: Lead; quotes: Quotation[]; workorders: WorkOrder[]; customerName?: string; hasOpenFollowup: boolean }) {
  return <article className={styles.card} aria-label={`Lead: ${lead.title}`}>
    <header className={styles.cardHeader}><button type="button" className={styles.title} disabled={disabled} onClick={() => open({ type: 'lead_detail', id: lead.id })}>{lead.title}</button><span className={styles.badge} data-status={lead.status}>{LEAD_LABELS[lead.status]}</span></header>
    <p className={styles.meta}>{[customerName || lead.contact, lead.phone, lead.expectedKw != null ? `${lead.expectedKw} kW` : ''].filter(Boolean).join(' · ') || 'Contact details not entered'}{lead.isDemo && ' · Example'}</p>
    {lead.status === 'WON' && (workorders.length > 0 ? <div className={styles.linkedJobs}>{workorders.map(order => <button type="button" key={order.id} className={styles.textButton} disabled={disabled} aria-label={`Open work order ${order.number} for ${lead.title}`} onClick={() => open({ type: 'work_detail', id: order.id })}>{workorders.length === 1 ? 'Open work order' : order.number} · {WORK_LABELS[order.status]}</button>)}</div> : <p className={styles.hint}>Confirmed. Won leads cannot be reopened.</p>)}
    {lead.status === 'LOST' && <p className={styles.hint}>{lead.lostReason || 'Lead closed.'}</p>}
    <div className={styles.actions}>
      {permissions.approve && lead.status !== 'WON' && <button type="button" className={styles.primary} disabled={disabled} aria-label={`${lead.status === 'LOST' ? 'Reopen' : 'Change status of'} ${lead.title}`} onClick={() => open({ type: 'lead_status', id: lead.id })}>{lead.status === 'LOST' ? 'Reopen lead' : 'Change lead status'}</button>}
      {permissions.commercial && lead.status !== 'LOST' && <button type="button" className={styles.secondary} disabled={disabled} aria-label={`Quotation and follow-up for ${lead.title}`} onClick={() => open({ type: 'followup_quote', leadId: lead.id })}>Quotation & follow-up</button>}
    </div>
    {!hasOpenFollowup && lead.status !== 'LOST' && <div className={styles.reminder}><span>No follow-up scheduled.</span>{permissions.follow && <button type="button" className={styles.textButton} disabled={disabled} aria-label={`Schedule follow-up for ${lead.title}`} onClick={() => open({ type: 'followup', leadId: lead.id })}>Schedule follow-up</button>}</div>}
    {quotes.length ? <details className={styles.related}><summary>{quotes.length === 1 ? `Quotation · ${QUOTE_LABELS[effectiveQuoteStatus(quotes[0])]}` : `${quotes.length} quotations · choose one`}</summary>
      {quotes.map(quote => { const action = quoteAction(quote, permissions); return <div className={styles.quoteRow} key={quote.id}><div><strong>{quote.number || quote.title}</strong><span>{QUOTE_LABELS[effectiveQuoteStatus(quote)]} · Revision {quote.revision}</span></div><button type="button" className={styles.textButton} disabled={disabled} aria-label={`${action.label}: ${quote.title}`} onClick={() => open({ type: action.type, id: quote.id })}>{action.label}</button></div>; })}
    </details> : <p className={styles.footnote}>No quotation prepared yet.</p>}
  </article>;
}
function SimpleFollowup({ item, lead, now, workspace, permissions, open, disabled }: RowProps & { item: FollowUp; lead?: Lead; now: Date; workspace: WorkspaceData }) {
  const overdue = item.status === 'OPEN' && Date.parse(item.dueAt) < now.getTime();
  const quotation = getFollowupQuotationContext(workspace, item).quotation;
  const today = item.status === 'OPEN' && todayIST(new Date(item.dueAt)) === todayIST(now);
  return <article className={styles.card} aria-label={`Follow-up: ${item.title}`}>
    <header className={styles.cardHeader}><h3>{item.title}</h3><span className={styles.badge} data-status={overdue ? 'LOST' : item.status}>{item.status === 'DONE' ? 'Completed' : item.status === 'CANCELLED' ? 'Cancelled' : overdue ? 'Overdue' : today ? 'Today' : 'To do'}</span></header>
    {lead && <button type="button" className={styles.projectLink} disabled={disabled} onClick={() => open({ type: 'lead_detail', id: lead.id })}>{lead.title}</button>}
    <p className={styles.meta}>{item.channel} · {dueLabel(item.dueAt)}{item.isDemo && ' · Example'}</p>
    {item.outcome && <p className={styles.hint}>{item.outcome}</p>}
    {quotation && <p className={styles.hint}>Linked quotation: {quotation.number || quotation.title} · {QUOTE_LABELS[effectiveQuoteStatus(quotation)]}</p>}
    <div className={styles.actions}>
      {permissions.follow && item.status === 'OPEN' && <button type="button" className={styles.primary} disabled={disabled} aria-label={`Complete follow-up: ${item.title}`} onClick={() => open({ type: 'followup_complete', id: item.id })}>Mark completed</button>}
      {permissions.follow && lead && <button type="button" className={styles.secondary} disabled={disabled} aria-label={`Quotation given for ${item.title}?`} onClick={() => open({ type: 'followup_quote', id: item.id })}>Quotation given?</button>}
      {!permissions.follow && quotation && <button type="button" className={styles.secondary} disabled={disabled} onClick={() => open({ type: 'quote_detail', id: quotation.id })}>View linked quotation</button>}
    </div>
  </article>;
}
function SimpleOrder({ order, workspace, permissions, open, disabled }: RowProps & { order: WorkOrder; workspace: WorkspaceData }) {
  const missing = missingDocuments(order);
  const payment = permissions.owner && canRecordWorkOrderPayment(workspace, order.id);
  const status = permissions.delivery && WORK_TRANSITIONS[order.status].length > 0;
  const job = !order.isDemo && order.status !== 'PLANNED';
  const done = order.milestones.reduce((count, item) => count + Number(item.status === 'DONE'), 0);
  return <article className={styles.card} aria-label={`Work order: ${order.title}`}>
    <header className={styles.cardHeader}><button type="button" className={styles.title} disabled={disabled} onClick={() => open({ type: 'work_detail', id: order.id })}>{order.title}</button><span className={styles.badge} data-status={order.status}>{WORK_LABELS[order.status]}</span></header>
    <p className={styles.meta}>{order.number} · {order.customerName}{order.isDemo && ' · Example'}</p>
    {order.siteAddress && <p className={styles.hint}>{order.siteAddress}</p>}
    {(order.milestones.length > 0 || !order.snapshot) && <p className={styles.hint}>{order.milestones.length > 0 && `${done} of ${order.milestones.length} milestones completed.`} {!order.snapshot && 'No accepted quotation linked.'}</p>}
    {!order.isDemo && <div className={styles.documentSummary}><strong>{missing.length ? `${missing.length} document${missing.length === 1 ? '' : 's'} pending` : 'All 7 documents received'}</strong>
      {missing.length > 0 && <span>{missing.map(key => DOCUMENT_NAMES[key]).join(', ')}</span>}
      <button type="button" className={styles.textButton} disabled={disabled} aria-label={`Review documents for ${order.title}`} onClick={() => open({ type: 'work_documents', id: order.id })}>Review documents</button>
    </div>}
    <div className={styles.actions}>
      {status && <button type="button" className={styles.primary} disabled={disabled} aria-label={`Update job status: ${order.title}`} onClick={() => open({ type: 'work_status', id: order.id })}>Update job status</button>}
      {job && <button type="button" className={styles.secondary} disabled={disabled} aria-label={`Job items for ${order.title}`} onClick={() => open({ type: 'work_job', id: order.id })}>{order.status === 'CANCELLED' ? 'View job history' : 'Job items & filing'}</button>}
      {payment && <button type="button" className={styles.secondary} disabled={disabled} aria-label={`Payments for ${order.title}`} onClick={() => open({ type: 'work_payment', id: order.id })}>Payments</button>}
    </div>
  </article>;
}
