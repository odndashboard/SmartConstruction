'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  LayoutDashboard, UsersRound, CalendarClock, FileText, HardHat, ContactRound, Settings2,
  Search, Bell, Plus, ArrowUpRight, ChevronRight, ChevronDown, X, Check, Phone, Mail,
  MapPin, MoreHorizontal, Download, LayoutGrid, List, Clock3, CircleAlert,
  Building2, HelpCircle, RefreshCw, Trash2, Pencil, Printer, CheckCircle2, LoaderCircle,
  Menu, Sparkles, ShieldCheck, ArrowRight, CalendarDays, Package, ClipboardCheck, Receipt, IndianRupee,
} from 'lucide-react';
import type { Customer, FollowUp, Lead, LeadStatus, Quotation, QuoteItemInput, QuoteTotals, WorkOrder, WorkspaceData } from '@/lib/types';
import { LEAD_STAGES, ROLE_LABELS } from '@/lib/types';
import { computeQuote, formatINR, STATE_OPTIONS, todayIST } from '@/lib/finance';
import DashboardOverview, { type OverviewBootstrap } from './DashboardOverview';
import type { OperationsData, OperationsSection } from '@/lib/operations-types';
import { saveTextFile, printDocument } from '@/lib/native-platform';
import { readJson } from '@/lib/client-read';
import { mergeDashboardWorkspace, mergeWorkspaceUpdate } from '@/lib/dashboard-refresh';
import { SignOutButton } from './SignOutButton';

function TabLoading() {
  return <div className="empty-state" role="status"><LoaderCircle size={22} className="spin" /><p>Opening this section…</p></div>;
}
const TeamSettings = dynamic(() => import('./TeamSettings'), { loading: TabLoading });
const AccountSecurity = dynamic(() => import('./AccountSecurity'), { loading: TabLoading });
const OperationsPanel = dynamic(() => import('./OperationsPanel'), { loading: TabLoading });
const TeamActivityPanel = dynamic(() => import('./TeamActivityPanel'), { loading: TabLoading });

type Section = 'dashboard' | 'leads' | 'followups' | 'quotations' | 'workorders' | 'settings' | 'team_activity' | OperationsSection;
type ModalState = { type: string; id?: string; leadId?: string; workId?: string } | null;
type Mutation = (action: string, payload: Record<string, unknown>, close?: boolean) => Promise<WorkspaceData | undefined>;
type CRMAppProps = {
  initialWorkspace?: WorkspaceData | null;
  initialOperations?: OperationsData | null;
  initialOperationsError?: string;
  initialError?: string;
};
function preloadSection(section: Section) {
  // Load code on navigation intent; private records still require their live API read.
  if (section === 'stock' || section === 'attendance' || section === 'expenses' || section === 'payments') void import('./OperationsPanel').catch(() => undefined);
  if (section === 'team_activity') void import('./TeamActivityPanel').catch(() => undefined);
  if (section === 'settings') {
    void import('./TeamSettings').catch(() => undefined);
    void import('./AccountSecurity').catch(() => undefined);
  }
}
const NAV: { key: Section; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'leads', label: 'Leads', icon: UsersRound },
  { key: 'followups', label: 'Follow-ups', icon: CalendarClock },
  { key: 'quotations', label: 'Quotations', icon: FileText },
  { key: 'workorders', label: 'Work orders', icon: HardHat },
  { key: 'stock', label: 'Stock', icon: Package },
  { key: 'attendance', label: 'Attendance', icon: ClipboardCheck },
  { key: 'expenses', label: 'Expenses', icon: Receipt },
  { key: 'payments', label: 'Payments', icon: IndianRupee, adminOnly: true },
  { key: 'team_activity', label: 'Team activity', icon: ShieldCheck, adminOnly: true },
];
const WORK_TRANSITIONS: Record<string, string[]> = { PLANNED: ['PLANNED', 'ACTIVE', 'CANCELLED'], ACTIVE: ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'], ON_HOLD: ['ON_HOLD', 'ACTIVE', 'CANCELLED'], COMPLETED: ['COMPLETED'], CANCELLED: ['CANCELLED'] };
const WORK_LABELS: Record<string, string> = { PLANNED: 'Planned', ACTIVE: 'In progress', ON_HOLD: 'On hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
const QUOTE_LABELS: Record<string, string> = { DRAFT: 'Draft', ISSUED: 'Awaiting approval', ACCEPTED: 'Accepted', DECLINED: 'Declined', EXPIRED: 'Expired', SUPERSEDED: 'Superseded' };
const FOLLOW_LABELS: Record<string, string> = { OPEN: 'Scheduled', DONE: 'Completed', CANCELLED: 'Cancelled' };
const units = ['job', 'sq ft', 'sq m', 'cu m', 'running ft', 'nos', 'day'];

function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase() || 'SC'; }
function displayDate(value?: string, options?: Intl.DateTimeFormatOptions) {
  if (!value) return 'Not scheduled';
  const date = new Date(value.length === 10 ? value + 'T00:00:00+05:30' : value);
  return Number.isNaN(date.getTime()) ? 'Not scheduled' : date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', ...options });
}
function displayTime(value: string) { return new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }); }
function localInput(value?: string) {
  const d = value ? new Date(value) : new Date(Date.now() + 3600000);
  const date = todayIST(d);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${date}T${parts}`;
}
function plusDays(days: number) { return todayIST(new Date(Date.now() + days * 86400000)); }
function ownerName(data: WorkspaceData, id: string) { const member = data.members.find(m => m.userId === id); if (member) return member.name; return id && [...data.leads, ...data.followups, ...data.workorders].some(r => r.isDemo && r.owner === id) ? `${id} · example` : 'Unassigned'; }
function assigneeValue(data: WorkspaceData, id: string) { return data.members.some(m => m.active && m.userId === id) ? id : ''; }
function leadLabel(status: LeadStatus) { return LEAD_STAGES.find(s => s.value === status)?.label || status; }
function stateLabel(code: string) { return STATE_OPTIONS.find(s => s.value === code)?.label || 'Not selected'; }
function effectiveQuoteStatus(quote: Quotation) { return quote.status === 'ISSUED' && quote.validUntil < todayIST() ? 'EXPIRED' : quote.status; }
function isOverdue(item: FollowUp) { return item.status === 'OPEN' && new Date(item.dueAt).getTime() < Date.now(); }
function customerForLead(data: WorkspaceData, id: string) { const lead = data.leads.find(l => l.id === id); return data.customers.find(c => c.id === lead?.customerId); }

function IconButton({ children, label, onClick, disabled = false, className = '' }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  const color = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return <span className={`avatar avatar-${color}${small ? ' avatar-small' : ''}`} title={name}>{initials(name)}</span>;
}
function Badge({ status, children }: { status: string; children: ReactNode }) { return <span className={`status-badge status-${status.toLowerCase()}`}><span />{children}</span>; }
function DemoTag({ demo }: { demo?: boolean }) { return demo ? <span className="demo-tag">Example</span> : null; }
function Empty({ icon: Icon = FileText, title, detail, action }: { icon?: typeof FileText; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={26} strokeWidth={1.5} /></span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function PanelHeader({ title, eyebrow, children }: { title: string; eyebrow?: string; children?: ReactNode }) { return <div className="panel-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>; }
function StateOptions() { return <><option value="">Select state / territory</option>{STATE_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}</>; }
function MemberOptions({ data }: { data: WorkspaceData }) { return <><option value="">Unassigned</option>{data.members.filter(m => m.active).map(m => <option key={m.userId} value={m.userId}>{m.name}</option>)}</>; }
function Field({ label, children, hint, wide = false }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) { return <label className={`field${wide ? ' field-wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function FormFooter({ busy, onClose, label = 'Save changes', disabled = false }: { busy: boolean; onClose: () => void; label?: string; disabled?: boolean }) { return <div className="form-footer"><button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button button-primary" disabled={busy || disabled}>{busy ? <LoaderCircle size={17} className="spin" /> : <Check size={17} />}{busy ? 'Saving…' : label}</button></div>; }
function Notes({ children }: { children: ReactNode }) { return <p className="preserve muted detail-copy">{children}</p>; }
function DetailField({ label, children }: { label: string; children: ReactNode }) { return <div className="detail-field"><dt>{label}</dt><dd>{children || '—'}</dd></div>; }

function Dialog({ title, eyebrow, children, onClose, busy, wide = false }: { title: string; eyebrow?: string; children: ReactNode; onClose: () => void; busy: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key === 'Tab') {
        const targets = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])');
        if (!targets?.length) return;
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [onClose, busy]);
  return <div className="modal-layer" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className={`modal-shell${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1} ref={ref}><header className="modal-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2 id="modal-title">{title}</h2></div><IconButton label="Close panel" onClick={onClose} disabled={busy}><X size={21} /></IconButton></header><div className="modal-body">{children}</div></div></div>;
}

function downloadCSV(title: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => { let s = String(value ?? ''); if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const text = '\uFEFF' + [keys, ...rows.map(row => keys.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n');
  saveTextFile(`smart-construction-${title}-${todayIST()}.csv`, text, 'text/csv;charset=utf-8;');
}

export default function CRMApp({ initialWorkspace = null, initialOperations = null, initialOperationsError = '', initialError = '' }: CRMAppProps = {}) {
  const [data, setData] = useState<WorkspaceData | null>(initialWorkspace);
  const [loading, setLoading] = useState(!initialWorkspace && !initialError);
  const [loadError, setLoadError] = useState(initialError);
  const [initialOverview, setInitialOverview] = useState<OverviewBootstrap | null>(() => initialWorkspace ? {
    identity: `${initialWorkspace.user.userId}:${initialWorkspace.user.role}:${initialWorkspace.user.active}`,
    data: initialOperations, error: initialOperationsError,
  } : null);
  const consumeInitialOverview = useCallback(() => setInitialOverview(null), []);
  const [section, setSection] = useState<Section>('dashboard');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [leadView, setLeadView] = useState<'board' | 'list'>('board');
  const [modal, setModal] = useState<ModalState>(null);
  const [modalError, setModalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [printQuote, setPrintQuote] = useState<Quotation | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Reuse an unresolved submission's ID if the response is lost. The server
  // safely replays its receipt instead of creating a second business record.
  const pendingRequests = useRef(new Map<string, string>());
  const workspaceRequest = useRef<Promise<void> | null>(null);
  const workspaceController = useRef<AbortController | null>(null);
  const workspaceSequence = useRef(0), mounted = useRef(false);
  const currentWorkspace = useRef(initialWorkspace);
  const accessGeneration = useRef(0);
  const invalidateWorkspaceAccess = useCallback(() => { ++accessGeneration.current; }, []);
  const updateWorkspace = useCallback((update: WorkspaceData | null | ((current: WorkspaceData | null) => WorkspaceData | null)) => {
    const current = currentWorkspace.current;
    const next = typeof update === 'function' ? update(current) : update;
    const identity = (value: WorkspaceData | null) => value ? `${value.user.userId}:${value.user.role}:${value.user.active}` : '';
    if (identity(current) !== identity(next)) invalidateWorkspaceAccess();
    currentWorkspace.current = next;
    setData(next);
  }, [invalidateWorkspaceAccess]);
  const applyWorkspaceUpdate = useCallback((next: WorkspaceData) => {
    if (mounted.current) updateWorkspace(current => mergeWorkspaceUpdate(current, next));
  }, [updateWorkspace]);
  const load = useCallback((): Promise<void> => {
    if (workspaceRequest.current) return workspaceRequest.current;
    const controller = new AbortController(); workspaceController.current = controller;
    const sequence = ++workspaceSequence.current;
    const flight = (async () => {
      try {
        const { response, body: result } = await readJson<WorkspaceData & { data?: WorkspaceData; error?: string }>('/api/workspace', { signal: controller.signal });
        if (!mounted.current || sequence !== workspaceSequence.current) return;
        if (response.status === 401) { updateWorkspace(null); window.location.replace('/login'); return; }
        if (!response.ok) {
          if (response.status === 403) updateWorkspace(null);
          throw new Error(response.status === 403 ? 'Your account no longer has access to this workspace. Please sign in again.' : result.error || 'Your workspace could not be loaded.');
        }
        setLoadError('');
        const next = result.data || result;
        // A dashboard refresh must not replace a newer successful edit.
        updateWorkspace(current => current && current.user.userId === next.user.userId && current.revision > next.revision ? current : next);
      } catch (error) {
        if (!controller.signal.aborted && mounted.current && sequence === workspaceSequence.current) setLoadError(error instanceof Error ? error.message : 'Unable to connect to your workspace.');
      } finally {
        if (sequence === workspaceSequence.current) { workspaceRequest.current = null; if (mounted.current) setLoading(false); }
      }
    })();
    workspaceRequest.current = flight;
    return flight;
  }, [updateWorkspace]);
  useEffect(() => {
    mounted.current = true;
    if (!initialWorkspace && !initialError) void load();
    return () => { mounted.current = false; invalidateWorkspaceAccess(); workspaceController.current?.abort(); workspaceRequest.current = null; };
  }, [initialWorkspace, initialError, load, invalidateWorkspaceAccess]);
  const applyDashboardWorkspace = useCallback((next: WorkspaceData) => {
    if (!mounted.current) return;
    updateWorkspace(current => mergeDashboardWorkspace(current, next));
    setLoadError('');
  }, [updateWorkspace]);
  const handleDashboardRefreshError = useCallback((message: string, status?: number) => {
    // A temporary failure is shown beside the overview's own retry button.
    // An access failure must also remove every previously loaded private view.
    if (!mounted.current || (status !== 401 && status !== 403)) return;
    ++workspaceSequence.current;
    workspaceController.current?.abort();
    workspaceRequest.current = null;
    updateWorkspace(null); setInitialOverview(null); setModal(null); setLoadError(message);
    if (status === 401) window.location.replace('/login');
  }, [updateWorkspace]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
  const close = useCallback(() => { setModal(null); setModalError(''); }, []);
  const open = (next: ModalState) => { setModal(next); setModalError(''); };
  const navigate = (next: Section, nextFilter = 'all') => { preloadSection(next); setSection(next); setFilter(nextFilter); setSearch(''); setMobileNav(false); };

  useEffect(() => {
    const back = (event: Event) => {
      if (busy) { event.preventDefault(); return; }
      if (modal) { event.preventDefault(); close(); }
      else if (mobileNav) { event.preventDefault(); setMobileNav(false); }
      else if (search) { event.preventDefault(); setSearch(''); }
      else if (section !== 'dashboard') { event.preventDefault(); setSection('dashboard'); setFilter('all'); }
    };
    window.addEventListener('smart-construction-back', back);
    return () => window.removeEventListener('smart-construction-back', back);
  }, [busy, close, modal, mobileNav, search, section]);

  const mutate: Mutation = async (action, payload, shouldClose = true) => {
    if (!data || busy) return;
    const generation = accessGeneration.current;
    setBusy(true); setModalError('');
    const fingerprint = JSON.stringify({ action, payload });
    const requestId = pendingRequests.current.get(fingerprint) || crypto.randomUUID();
    pendingRequests.current.set(fingerprint, requestId);
    try {
      const response = await fetch('/api/workspace', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, payload, expectedRevision: data.revision, requestId }) });
      const result = await response.json() as { data: WorkspaceData; message?: string; error?: string };
      if (!response.ok) {
        if (response.status < 500) pendingRequests.current.delete(fingerprint);
        if (response.status === 409) await load();
        throw new Error(result.error || 'The change could not be saved.');
      }
      pendingRequests.current.delete(fingerprint);
      // The write's receipt still counts as complete, even if a concurrent read
      // revoked access. Never put that earlier private response back on screen.
      if (!mounted.current || generation !== accessGeneration.current) return;
      applyWorkspaceUpdate(result.data); setToast(result.message || 'Your changes have been saved.');
      if (shouldClose) close();
      return result.data;
    } catch (error) { if (mounted.current && generation === accessGeneration.current) setModalError(error instanceof Error ? error.message : 'Could not save. Please try again.'); }
    finally { if (mounted.current) setBusy(false); }
  };

  const deferredSearch = useDeferredValue(search);
  const searchText = deferredSearch.trim().toLowerCase();
  const customerIndex = useMemo(() => new Map((data?.customers || []).map(customer => [customer.id, customer])), [data?.customers]);
  const leadRecords = useMemo(() => (data?.leads || []).filter(lead =>
    (filter === 'all' || lead.status === filter) && `${lead.title} ${lead.contact} ${lead.location} ${customerIndex.get(lead.customerId)?.name}`.toLowerCase().includes(searchText)
  ), [data?.leads, filter, searchText, customerIndex]);

  if (loading) return <div className="boot-screen"><BrandMark /><h1>Opening your workspace</h1><p>Connecting to smart construction</p><LoaderCircle className="spin" size={23} /></div>;
  if (!data) return <div className="boot-screen"><BrandMark /><h1>Let’s reconnect.</h1><p>{loadError || 'Your workspace is not available yet.'}</p><button className="button button-primary" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={17} />Try again</button><SignOutButton /></div>;

  const commercial = ['OWNER', 'MANAGER', 'SALES'].includes(data.user.role);
  const approve = ['OWNER', 'MANAGER'].includes(data.user.role);
  const delivery = ['OWNER', 'MANAGER', 'OPERATIONS'].includes(data.user.role);
  const follow = ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS'].includes(data.user.role);
  const manageLeadStatus = approve;
  const owner = data.user.role === 'OWNER';
  const permissions = { commercial, approve, delivery, follow, owner, manageLeadStatus };
  const hasDemo = [...data.leads, ...data.customers, ...data.quotations, ...data.workorders].some(r => r.isDemo);
  const overdue = data.followups.filter(isOverdue).length;
  const quoteById = data.quotations.find(q => q.id === modal?.id);
  const leadById = data.leads.find(l => l.id === modal?.id);
  const customerById = data.customers.find(c => c.id === modal?.id);
  const followById = data.followups.find(f => f.id === modal?.id);
  const workById = data.workorders.find(w => w.id === modal?.id);
  const currentLabel = NAV.find(n => n.key === section)?.label || 'Settings';
  const operationsSection = section === 'stock' || section === 'attendance' || section === 'expenses' || section === 'payments';
  const print = (quote: Quotation) => { setPrintQuote(quote); requestAnimationFrame(() => requestAnimationFrame(() => printDocument())); };
  const exportList = () => {
    const count = ({ leads: leadRecords.length, quotations: data.quotations.length, workorders: data.workorders.length, followups: data.followups.length } as Record<string, number>)[section] || 0;
    if (!count) { setToast('There are no records to export in this view.'); return; }
    if (section === 'leads') downloadCSV('leads', leadRecords.map(l => ({ Project: l.title, Customer: data.customers.find(c => c.id === l.customerId)?.name, Stage: leadLabel(l.status), 'Value INR': (l.value / 100).toFixed(2), Owner: ownerName(data, l.owner), Phone: l.phone, Site: l.siteAddress, Example: l.isDemo ? 'Yes' : 'No' })));
    if (section === 'quotations') downloadCSV('quotations', data.quotations.map(q => ({ Number: q.number || 'Draft', Title: q.title, Status: effectiveQuoteStatus(q), Revision: q.revision, 'Valid until': q.validUntil, 'Taxable INR': (q.totals.taxable / 100).toFixed(2), 'Total INR': (q.totals.total / 100).toFixed(2), 'GST setup pending': q.totals.needsConfig ? 'Yes — amount excludes GST' : 'No', Example: q.isDemo ? 'Yes' : 'No' })));
    if (section === 'workorders') downloadCSV('work-orders', data.workorders.map(w => ({ Number: w.number, Project: w.title, Customer: w.customerName, Status: WORK_LABELS[w.status], Owner: ownerName(data, w.owner), Start: w.startDate, End: w.endDate, 'Total INR': (w.snapshot.totals.total / 100).toFixed(2), Example: w.isDemo ? 'Yes' : 'No' })));
    if (section === 'followups') downloadCSV('followups', data.followups.map(f => ({ Action: f.title, Channel: f.channel, Due: f.dueAt, Owner: ownerName(data, f.owner), Status: FOLLOW_LABELS[f.status], Outcome: f.outcome, Example: f.isDemo ? 'Yes' : 'No' })));
  };

  return <>
    <div className={`crm-app${mobileNav ? ' nav-open' : ''}`}>
      {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <aside className="sidebar"><button className="brand" onClick={() => navigate('dashboard')} aria-label="smart construction dashboard"><BrandMark /><span>smart<span className="brand-second">construction</span></span></button><div className="workspace-label"><span />YOUR WORKSPACE</div><nav aria-label="Main navigation">{NAV.filter(item => !item.adminOnly || owner).map(({ key, label, icon: Icon }) => <button key={key} className={`nav-item${section === key ? ' active' : ''}`} onMouseEnter={() => preloadSection(key)} onFocus={() => preloadSection(key)} onClick={() => navigate(key)}><Icon size={20} strokeWidth={1.6} /><span>{label}</span>{key === 'followups' && overdue > 0 && <b className="nav-count">{overdue}</b>}</button>)}</nav><div className="sidebar-bottom"><button className={`nav-item${section === 'settings' ? ' active' : ''}`} onMouseEnter={() => preloadSection('settings')} onFocus={() => preloadSection('settings')} onClick={() => navigate('settings')}><Settings2 size={20} strokeWidth={1.6} /><span>Settings</span></button><button className="nav-item" onClick={() => open({ type: 'help' })}><HelpCircle size={20} strokeWidth={1.6} /><span>Quick guide</span></button><SignOutButton className="nav-item" /><div className="sidebar-workspace"><span className="online-dot" /><div><strong>Cloud workspace</strong><span>INR · GST enabled</span></div><ShieldCheck size={17} /></div></div></aside>
      <div className="workspace-shell"><header className="topbar"><div className="topbar-left"><IconButton label="Open navigation" className="mobile-menu" onClick={() => setMobileNav(true)}><Menu size={23} /></IconButton><div className="breadcrumb">Workspace <ChevronRight size={14} /><strong>{currentLabel}</strong></div></div><label className="global-search"><Search size={18} /><input ref={searchRef} aria-label="Search workspace" placeholder="Search your workspace…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>⌘ K</kbd>{search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')}><X size={16} /></button>}</label><div className="topbar-right"><IconButton label={`${overdue} overdue follow-ups`} onClick={() => navigate('followups', 'overdue')} className="notification-button"><Bell size={20} />{overdue > 0 && <span className="notification-dot" />}</IconButton><span className="topbar-divider" /><button className="profile-button" onClick={() => navigate('settings')}><Avatar name={data.user.name} /><span><strong>{data.user.name}</strong><small>{ROLE_LABELS[data.user.role]}</small></span><ChevronDown size={14} /></button></div></header>
      <main className="workspace-main" id="main">
        {loadError && <div className="inline-alert"><CircleAlert size={17} />{loadError}<button onClick={() => void load()}>Retry</button></div>}
        {!modal && modalError && <div role="alert" className="inline-alert error"><CircleAlert size={17} />{modalError}<button onClick={() => setModalError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
        {hasDemo && <div className="demo-banner"><span><Sparkles size={15} /><strong>Example workspace</strong><span>Sample records are marked and kept separate from your work.</span></span>{owner && <button disabled={busy} onClick={() => open({ type: 'clear_demo' })}>Clear examples <X size={14} /></button>}</div>}
        {section === 'dashboard' && !searchText ? <Dashboard data={data} permissions={permissions} navigate={navigate} open={open} busy={busy} onWorkspaceRefreshed={applyDashboardWorkspace} onRefreshError={handleDashboardRefreshError} initialOverview={initialOverview} onInitialOverviewUsed={consumeInitialOverview} /> : <>
          <div className="page-heading"><div><span className="eyebrow">{section === 'settings' ? 'YOUR WORKSPACE' : section === 'dashboard' ? 'FIND YOUR WORK' : 'WORKSPACE'}</span><h1>{section === 'dashboard' ? 'Search results' : currentLabel}</h1><p>{({ leads: 'Every conversation. Every opportunity. A clear next step.', followups: 'Stay close to your customers and ahead of the next action.', quotations: 'Thoughtful proposals, precise pricing and clear approvals.', workorders: 'From a signed agreement to a job well done.', stock: 'Keep materials accounted for, from delivery to the job site.', attendance: owner ? 'A clear record of your team’s working days.' : 'Check in, check out and keep track of your working days.', expenses: owner ? 'Review submissions, approve expenses and see the complete picture.' : 'Record your expenses and follow their approval status.', payments: 'Track customer payments, due stages and outstanding work-order balances.', settings: 'Your company, your team and the way you work.', team_activity: 'See who changed what, when it happened and the details behind it.', dashboard: `Results for “${search}”` })[section]}</p></div><div className="heading-actions">{section !== 'settings' && section !== 'dashboard' && section !== 'team_activity' && !operationsSection && <button className="button button-secondary" onClick={exportList}><Download size={16} /><span>Export</span></button>}{section === 'leads' && commercial && <button className="button button-primary" onClick={() => open({ type: 'lead' })}><Plus size={17} />Add lead</button>}{section === 'followups' && follow && <button className="button button-primary" onClick={() => open({ type: 'followup' })}><Plus size={17} />Schedule follow-up</button>}{section === 'quotations' && commercial && <button className="button button-primary" onClick={() => open({ type: 'quote' })}><Plus size={17} />New quotation</button>}</div></div>
          {section === 'dashboard' && <SearchResults data={data} search={searchText} open={open} manageLeadStatus={manageLeadStatus} />}
          {section === 'leads' && <><div className="list-toolbar"><div className="tabs"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>All leads <span>{data.leads.length}</span></button><button className={filter === 'NEW' ? 'selected' : ''} onClick={() => setFilter('NEW')}>New</button><button className={filter === 'WON' ? 'selected' : ''} onClick={() => setFilter('WON')}>Won</button><button className={filter === 'LOST' ? 'selected' : ''} onClick={() => setFilter('LOST')}>Lost</button></div><div className="view-toggle"><IconButton label="Board view" className={leadView === 'board' ? 'selected' : ''} onClick={() => setLeadView('board')}><LayoutGrid size={17} /></IconButton><IconButton label="List view" className={leadView === 'list' ? 'selected' : ''} onClick={() => setLeadView('list')}><List size={18} /></IconButton></div></div>{leadRecords.length ? leadView === 'board' && filter !== 'WON' && filter !== 'LOST' ? <LeadBoard data={data} leads={leadRecords} open={open} commercial={commercial} manageLeadStatus={manageLeadStatus} dashboard={false} /> : <LeadTable data={data} leads={leadRecords} open={open} manageLeadStatus={manageLeadStatus} /> : <div className="panel"><Empty icon={UsersRound} title="Your next project starts here" detail="Add an enquiry and keep its owner, site details and follow-ups together." action={commercial && <button className="button button-primary" onClick={() => open({ type: 'lead' })}><Plus size={17} />Add a lead</button>} /></div>}</>}
          {section === 'followups' && <><div className="list-toolbar"><div className="tabs">{[['all', 'All'], ['today', 'Today'], ['overdue', 'Overdue'], ['OPEN', 'Scheduled'], ['DONE', 'Completed']].map(([key, label]) => <button key={key} className={filter === key ? 'selected' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div></div><div className="panel followup-list">{data.followups.filter(f => `${f.title} ${data.leads.find(l => l.id === f.leadId)?.title}`.toLowerCase().includes(searchText) && (filter === 'all' || filter === 'today' && f.status === 'OPEN' && todayIST(new Date(f.dueAt)) === todayIST() || filter === 'overdue' && isOverdue(f) || filter === f.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt)).map(f => <FollowupRow key={f.id} item={f} data={data} open={open} canEdit={follow} full />)}{!data.followups.some(f => `${f.title} ${data.leads.find(l => l.id === f.leadId)?.title}`.toLowerCase().includes(searchText) && (filter === 'all' || filter === 'today' && f.status === 'OPEN' && todayIST(new Date(f.dueAt)) === todayIST() || filter === 'overdue' && isOverdue(f) || filter === f.status)) && <Empty icon={CalendarClock} title="All clear here" detail="Schedule a call, visit or check-in and it will appear in this list." action={follow && <button className="button button-secondary" onClick={() => open({ type: 'followup' })}><Plus size={16} />Schedule follow-up</button>} />}</div></>}
          {section === 'quotations' && <><StatusTabs choices={[['all', 'All quotations'], ['DRAFT', 'Drafts'], ['ISSUED', 'Awaiting approval'], ['ACCEPTED', 'Accepted'], ['EXPIRED', 'Expired']]} filter={filter} setFilter={setFilter} /><QuoteTable data={data} quotes={data.quotations.filter(q => (filter === 'all' || effectiveQuoteStatus(q) === filter) && `${q.title} ${q.number} ${q.customer?.name || customerForLead(data, q.leadId)?.name}`.toLowerCase().includes(searchText))} open={open} /></>}
          {section === 'workorders' && <><StatusTabs choices={[['all', 'All work orders'], ['PLANNED', 'Planned'], ['ACTIVE', 'In progress'], ['ON_HOLD', 'On hold'], ['COMPLETED', 'Completed']]} filter={filter} setFilter={setFilter} /><div className="workorder-grid">{data.workorders.filter(w => (filter === 'all' || w.status === filter) && `${w.title} ${w.number} ${w.customerName}`.toLowerCase().includes(searchText)).map(w => <WorkCard key={w.id} item={w} data={data} open={open} />)}</div>{!data.workorders.filter(w => (filter === 'all' || w.status === filter) && `${w.title} ${w.number} ${w.customerName}`.toLowerCase().includes(searchText)).length && <div className="panel"><Empty icon={HardHat} title="Ready for the next build" detail="Accept a quotation and create a work order to start tracking delivery." action={<button className="button button-secondary" onClick={() => navigate('quotations', 'ACCEPTED')}>View accepted quotations <ArrowRight size={16} /></button>} /></div>}</>}
          {section === 'team_activity' && owner && <TeamActivityPanel workspace={data} search={searchText} />}
          {operationsSection && <OperationsPanel key={section} section={section} workspace={data} search={searchText} />}
          {section === 'settings' && <SettingsView data={data} owner={owner} busy={busy} mutate={mutate} open={open} onUpdated={applyWorkspaceUpdate} />}
        </>}
        <footer className="workspace-footer"><span><span className="online-dot" />Your team’s work, in one place.</span><span>₹ INR <span>·</span> Asia/Kolkata</span></footer>
      </main></div>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={19} /><span>{toast}</span><button onClick={() => setToast('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {modal && <Dialog title={modalTitle(modal.type, leadById, quoteById, workById)} eyebrow={modal.type.endsWith('_detail') ? 'WORKSPACE DETAILS' : undefined} wide={['quote', 'quote_detail', 'work_detail'].includes(modal.type)} onClose={close} busy={busy}>
      {modalError && <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{modalError}</span></div>}
      {modal.type === 'customer' && <CustomerForm customer={customerById} busy={busy} close={close} mutate={mutate} />}
      {modal.type === 'lead' && <LeadForm lead={leadById} data={data} busy={busy} close={close} mutate={mutate} manageLeadStatus={manageLeadStatus} />}
      {modal.type === 'followup' && <FollowupForm item={followById} data={data} leadId={modal.leadId} busy={busy} close={close} mutate={mutate} />}
      {modal.type === 'followup_complete' && followById && <SimpleForm onSubmit={p => mutate('followup_complete', { id: followById.id, outcome: p.outcome })} busy={busy} close={close} submit="Complete follow-up"><div className="form-intro"><Badge status="open">{followById.channel}</Badge><h3>{followById.title}</h3><p>{displayDate(followById.dueAt)} at {displayTime(followById.dueAt)} IST</p></div><Field label="Conversation outcome *" hint="Record the decision and what should happen next."><textarea name="outcome" required rows={5} placeholder="What did you discuss or agree?" /></Field></SimpleForm>}
      {modal.type === 'lead_status' && leadById && manageLeadStatus && <LeadStatusForm key={`${leadById.id}:${leadById.status}`} lead={leadById} busy={busy} close={() => open({ type: 'lead_detail', id: leadById.id })} mutate={mutate} open={open} />}
      {modal.type === 'quote' && <QuoteEditor quote={quoteById} data={data} leadId={modal.leadId} busy={busy} close={close} mutate={mutate} />}
      {modal.type === 'quote_accept' && quoteById && <SimpleForm onSubmit={p => mutate('quote_accept', { id: quoteById.id, acceptanceNote: p.acceptanceNote })} busy={busy} close={close} submit="Record acceptance"><div className="form-intro"><span className="eyebrow">{quoteById.number}</span><h3>{quoteById.title}</h3><strong>{formatINR(quoteById.totals.total)}</strong></div><Field label="Acceptance reference *" hint="Record who approved, when, and the email, message or written approval reference."><textarea name="acceptanceNote" rows={4} required placeholder="Customer acceptance details…" /></Field></SimpleForm>}
      {modal.type === 'work_edit' && workById && <WorkForm item={workById} data={data} busy={busy} close={close} mutate={mutate} />}
      {modal.type === 'milestone' && <SimpleForm onSubmit={p => mutate('milestone_add', { workorderId: modal.workId, title: p.title, dueDate: p.dueDate })} busy={busy} close={close} submit="Add milestone"><Field label="Milestone name *"><input name="title" required placeholder="e.g. Foundation inspection" /></Field><Field label="Target date"><input name="dueDate" type="date" /></Field></SimpleForm>}
      {modal.type === 'lead_detail' && leadById && <LeadDetail lead={leadById} data={data} permissions={permissions} open={open} busy={busy} />}
      {modal.type === 'quote_detail' && quoteById && <QuoteDetail quote={quoteById} data={data} permissions={permissions} open={open} busy={busy} mutate={mutate} print={print} />}
      {modal.type === 'work_detail' && workById && <WorkDetail item={workById} data={data} delivery={delivery} open={open} busy={busy} mutate={mutate} />}
      {modal.type === 'load_demo' && <div className="confirmation"><span className="confirmation-icon"><Sparkles size={30} /></span><h3>Explore with example projects</h3><p>Add clearly labelled sample leads, follow-ups, quotations and work orders to see the complete workflow. Your company details and real records stay as they are.</p><div className="form-footer"><button className="button button-secondary" onClick={close} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy} onClick={() => void mutate('load_demo', {})}>{busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}Load example workspace</button></div></div>}
      {modal.type === 'clear_demo' && <div className="confirmation"><span className="confirmation-icon"><Trash2 size={27} /></span><h3>Clear the example records?</h3><p>Only records marked Example will be removed. Your real customers, leads, documents and company settings will be kept.</p><div className="form-footer"><button className="button button-secondary" onClick={close} disabled={busy}>Keep examples</button><button className="button button-danger" disabled={busy} onClick={() => void mutate('clear_demo', {})}>{busy ? <LoaderCircle className="spin" size={17} /> : <Trash2 size={17} />}Clear examples</button></div></div>}
      {modal.type === 'help' && <div className="quick-guide"><p className="form-description">A simple path from the first enquiry to completed work.</p>{[['01', 'Add a lead', 'Create an enquiry and save its customer details, project site, expected value and person responsible.'], ['02', 'Keep a clear next action', 'Schedule a call or site visit. Complete it with an outcome so the team knows what happened.'], ['03', 'Prepare & approve a quotation', 'Add the scope, explicit HSN/SAC and GST rates. A manager issues the quotation and records customer acceptance.'], ['04', 'Deliver the agreed work', 'Convert an accepted quotation into one work order. Assign its owner, schedule the work and track milestones.'], ['05', 'Keep materials accounted for', 'Record stock received, consumed, transferred and returned. Request materials and review balances at every site.'], ['06', 'Record your working day', 'Check in at your assigned site. Review your monthly calendar and shift hours; the Owner manages site assignments, shift rules and overtime approval.'], ['07', 'Submit expenses for review', 'Enter the date, amount and bill reference, then attach a private receipt. You see your own submissions; the Owner reviews all expenses.']].map(([n, title, text]) => <article key={n}><span>{n}</span><div><h3>{title}</h3><p>{text}</p></div></article>)}<div className="soft-callout"><ShieldCheck size={19} /><p>Changes are saved to your company workspace. Attendance and expense records follow your account permissions, including in exports. Saved changes are recorded for the Owner in Team activity. An issued quotation preserves its original commercial details.</p></div></div>}
    </Dialog>}
    {printQuote && <div className="print-target"><QuoteDocument quote={printQuote} data={data} /></div>}
  </>;
}

function BrandMark() { return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 44 44" fill="none"><path d="M6 35V17L18 9v26M18 35V5l20 10v20M25 14v21M31 18v17M6 35h32" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" /><path d="M10 21h4m-4 6h4" stroke="currentColor" strokeWidth="2" /></svg></span>; }
function StatusTabs({ choices, filter, setFilter }: { choices: string[][]; filter: string; setFilter: (s: string) => void }) { return <div className="list-toolbar"><div className="tabs">{choices.map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div></div>; }

type PermissionFlags = { commercial: boolean; approve: boolean; delivery: boolean; follow: boolean; owner: boolean; manageLeadStatus: boolean };
type OpenModal = (modal: ModalState) => void;
function Dashboard({ data, permissions: p, navigate, open, busy, onWorkspaceRefreshed, onRefreshError, initialOverview, onInitialOverviewUsed }: { data: WorkspaceData; permissions: PermissionFlags; navigate: (s: Section, filter?: string) => void; open: OpenModal; busy: boolean; onWorkspaceRefreshed: (workspace: WorkspaceData) => void; onRefreshError: (message: string, status?: number) => void; initialOverview: OverviewBootstrap | null; onInitialOverviewUsed: () => void }) {
  const pipeline = data.leads.filter(l => !['WON', 'LOST'].includes(l.status));
  const next = data.followups.filter(f => f.status === 'OPEN').sort((a, b) => a.dueAt.localeCompare(b.dueAt)).slice(0, 4);
  const pending = data.quotations.filter(q => effectiveQuoteStatus(q) === 'ISSUED');
  const active = data.workorders.filter(w => !['COMPLETED', 'CANCELLED'].includes(w.status));
  const empty = !data.leads.length && !data.customers.length && !data.quotations.length && !data.workorders.length;
  const configured = !!(data.company.legalName && data.company.gstin && data.company.stateCode && data.company.address);
  return <><div className="page-heading dashboard-heading"><div><span className="date-eyebrow"><CalendarDays size={14} />{new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><h1>Workspace overview<span className="heading-dot">.</span></h1><p>Welcome back, {data.user.name.split(' ')[0]}. Your projects, people and daily operations in one place.</p></div>{p.commercial && <button className="button button-primary" onClick={() => open({ type: 'lead' })}><Plus size={18} />Add new lead</button>}</div>
    <DashboardOverview workspace={data} navigate={navigate} onWorkspaceRefreshed={onWorkspaceRefreshed} onRefreshError={onRefreshError} initialOverview={initialOverview} onInitialOverviewUsed={onInitialOverviewUsed} />
    {empty ? <><section className="welcome-panel"><div className="welcome-copy"><span className="welcome-label"><span />START YOUR NEXT PROJECT</span><h2>Build relationships.<br />Deliver great work.</h2><p>Add a lead with its customer details, then follow the project through quotation and delivery. Your daily operations are available in the overview above.</p><div className="welcome-actions">{p.commercial && <button className="button button-primary" onClick={() => open({ type: 'lead' })}><Plus size={18} />Add your first lead</button>}{p.owner && <button className="button button-light" disabled={busy} onClick={() => open({ type: 'load_demo' })}><Sparkles size={17} />Explore example workspace</button>}</div><span className="welcome-note"><ShieldCheck size={14} />Private access · Cloud saved · Ready for your team</span></div><div className="welcome-illustration" aria-hidden="true"><div className="blueprint-grid" /><div className="building building-back"><i /><i /><i /><i /><i /><i /></div><div className="building building-front"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="illustration-chip"><CheckCircle2 size={17} />A stronger foundation</div></div></section><div className="setup-steps"><button onClick={() => navigate('settings')}><span className={`step-number${configured ? ' complete' : ''}`}>{configured ? <Check size={18} /> : '01'}</span><div><h3>Set up your company</h3><p>Add your GST registration and company details.</p></div><ArrowUpRight size={20} /></button><button onClick={() => p.commercial && open({ type: 'lead' })} disabled={!p.commercial}><span className="step-number">02</span><div><h3>Add your first lead</h3><p>Capture the project and customer details together.</p></div><ArrowUpRight size={20} /></button><button onClick={() => p.follow && open({ type: 'followup' })} disabled={!p.follow || !data.leads.length}><span className="step-number">03</span><div><h3>Plan the next action</h3><p>Schedule a call or site visit for your lead.</p></div><ArrowUpRight size={20} /></button></div></> : <>

    <section className="panel pipeline-panel"><PanelHeader title="Lead pipeline" eyebrow="FROM FIRST HELLO TO HANDSHAKE"><button className="text-link" onClick={() => navigate('leads')}>View all leads <ArrowUpRight size={16} /></button></PanelHeader><LeadBoard data={data} leads={pipeline} open={open} commercial={p.commercial} manageLeadStatus={p.manageLeadStatus} dashboard /></section>
    <div className="dashboard-middle"><section className="panel followup-panel"><PanelHeader title="Your next follow-ups"><button className="text-link" onClick={() => navigate('followups')}>View all <ArrowUpRight size={15} /></button></PanelHeader><div className="panel-subheading"><span><span className="live-dot" />Keep the conversation moving</span>{p.follow && <IconButton label="Schedule a follow-up" onClick={() => open({ type: 'followup' })}><Plus size={17} /></IconButton>}</div>{next.length ? next.map(f => <FollowupRow key={f.id} item={f} data={data} open={open} canEdit={p.follow} />) : <Empty icon={CalendarClock} title="Nothing on your list yet" detail="A quick follow-up can move a project forward." />}</section><section className="panel quotation-panel"><PanelHeader title="Pending quotations"><button className="text-link" onClick={() => navigate('quotations')}>View all <ArrowUpRight size={15} /></button></PanelHeader><QuoteTable data={data} quotes={pending.slice(0, 4)} open={open} compact /></section></div>
    <section className="work-section"><div className="section-heading"><div><span className="eyebrow">GOOD PLANS. GREAT EXECUTION.</span><h2>Work in progress</h2></div><button className="text-link" onClick={() => navigate('workorders')}>View all work orders <ArrowUpRight size={16} /></button></div>{active.length ? <div className="workorder-grid dashboard-work-grid">{active.slice(0, 3).map(w => <WorkCard key={w.id} item={w} data={data} open={open} />)}</div> : <div className="panel"><Empty icon={HardHat} title="Make the next project happen" detail="An accepted quotation becomes a work order, ready for your team." /></div>}</section>
    {!configured && <div className="setup-callout"><span className="setup-icon"><Building2 size={20} /></span><div><strong>A few details make it official.</strong><p>Complete your company’s GST setup before issuing real quotations.</p></div>{p.owner && <button className="button button-secondary" onClick={() => navigate('settings')}>Complete setup <ArrowRight size={16} /></button>}</div>}
    </>}
  </>;
}
function LeadBoard({ data, leads, open, commercial, manageLeadStatus, dashboard }: { data: WorkspaceData; leads: Lead[]; open: OpenModal; commercial: boolean; manageLeadStatus: boolean; dashboard: boolean }) {
  return <div className={`lead-board${dashboard ? ' dashboard-board' : ''}`}>{LEAD_STAGES.slice(0, 5).map(stage => {
    const records = leads.filter(l => l.status === stage.value);
    return <section className={`board-column stage-${stage.value.toLowerCase()}`} key={stage.value}><header><span className="stage-dot" /><h3>{stage.label}</h3><span className="stage-count">{records.length}</span>{commercial && <IconButton label={`Add lead`} onClick={() => open({ type: 'lead' })}><Plus size={14} /></IconButton>}</header><div className="board-cards">{(dashboard ? records.slice(0, 2) : records).map(lead => <article className="lead-card" key={lead.id}><div className="lead-card-tags"><span className={`priority-label priority-${lead.priority.toLowerCase()}`}><span />{lead.priority} priority</span><IconButton label={`Open ${lead.title}`} onClick={() => open({ type: 'lead_detail', id: lead.id })}><MoreHorizontal size={17} /></IconButton></div><button className="lead-card-title" onClick={() => open({ type: 'lead_detail', id: lead.id })}>{lead.title}</button><p className="lead-customer">{data.customers.find(c => c.id === lead.customerId)?.name || lead.contact}</p><span className="lead-location"><MapPin size={12} />{lead.location || stateLabel(lead.stateCode)}</span><strong className="lead-value">{lead.value ? formatINR(lead.value, true) : 'To be scoped'}</strong>{manageLeadStatus && <button type="button" className="button button-secondary button-small lead-status-action" aria-label={`Change status of ${lead.title}`} onClick={() => open({ type: 'lead_status', id: lead.id })}><RefreshCw size={14} />Change status</button>}<footer><span className="lead-footer-date"><CalendarDays size={12} />{displayDate(lead.createdAt)}<DemoTag demo={lead.isDemo} /></span><Avatar small name={ownerName(data, lead.owner)} /></footer></article>)}{!records.length && <div className="board-empty"><span>No leads here yet</span>{commercial && <button onClick={() => open({ type: 'lead' })}><Plus size={13} />Add a lead</button>}</div>}{dashboard && records.length > 2 && <span className="board-more">+{records.length - 2} more opportunities</span>}</div></section>;
  })}</div>;
}
function LeadTable({ data, leads, open, manageLeadStatus }: { data: WorkspaceData; leads: Lead[]; open: OpenModal; manageLeadStatus: boolean }) { return <div className="panel table-container"><table><thead><tr><th>Project / customer</th><th>Stage</th><th>Expected value</th><th>Owner</th><th>Priority</th><th /></tr></thead><tbody>{leads.map(l => <tr key={l.id}><td><button className="table-title" onClick={() => open({ type: 'lead_detail', id: l.id })}>{l.title}</button><small>{data.customers.find(c => c.id === l.customerId)?.name} <DemoTag demo={l.isDemo} /></small></td><td><Badge status={l.status}>{leadLabel(l.status)}</Badge></td><td className="money-cell">{formatINR(l.value)}</td><td><span className="owner-cell"><Avatar small name={ownerName(data, l.owner)} />{ownerName(data, l.owner)}</span></td><td><span className={`priority-label priority-${l.priority.toLowerCase()}`}><span />{l.priority}</span></td><td><div className="lead-row-actions">{manageLeadStatus && l.status !== 'WON' && <button type="button" className="button button-secondary button-small" aria-label={`Change status of ${l.title}`} onClick={() => open({ type: 'lead_status', id: l.id })}><RefreshCw size={14} />Change status</button>}<IconButton label={`Open ${l.title}`} onClick={() => open({ type: 'lead_detail', id: l.id })}><ArrowUpRight size={17} /></IconButton></div></td></tr>)}</tbody></table></div>; }
function FollowupRow({ item, data, open, canEdit, full = false }: { item: FollowUp; data: WorkspaceData; open: OpenModal; canEdit: boolean; full?: boolean }) {
  const Icon = item.channel === 'Email' ? Mail : item.channel === 'Site visit' ? MapPin : Phone;
  return <article className={`followup-row${full ? ' full' : ''}`}><span className={`followup-type ${item.channel === 'Site visit' ? 'visit' : ''}`}><Icon size={18} strokeWidth={1.7} /></span><div className="followup-content"><button onClick={() => open({ type: 'lead_detail', id: item.leadId })}>{item.title}</button><span>{data.leads.find(l => l.id === item.leadId)?.title}<DemoTag demo={item.isDemo} /></span><div className="followup-meta"><span><Clock3 size={12} />{todayIST(new Date(item.dueAt)) === todayIST() ? 'Today' : displayDate(item.dueAt)}, {displayTime(item.dueAt)}</span>{isOverdue(item) ? <span className="overdue-text">Overdue</span> : item.status !== 'OPEN' ? <span className="completed-text">{FOLLOW_LABELS[item.status]}</span> : null}</div>{full && <><small>Assigned to {ownerName(data, item.owner)}</small>{(item.outcome || item.notes) && <p className="followup-outcome">{item.outcome || item.notes}</p>}</>}</div>{canEdit && item.status === 'OPEN' && <div className="followup-actions">{full && <IconButton label="Edit follow-up" onClick={() => open({ type: 'followup', id: item.id })}><Pencil size={16} /></IconButton>}<IconButton label={`Complete ${item.title}`} className="complete-button" onClick={() => open({ type: 'followup_complete', id: item.id })}><Check size={17} /></IconButton></div>}{item.status === 'DONE' && <CheckCircle2 size={20} className="sage-text" />}</article>;
}
function QuoteTable({ data, quotes, open, compact = false }: { data: WorkspaceData; quotes: Quotation[]; open: OpenModal; compact?: boolean }) {
  if (!quotes.length) return <div className={compact ? '' : 'panel'}><Empty icon={FileText} title="No quotations to show" detail="Build a clear proposal from a lead, then track its approval here." /></div>;
  return <div className={`table-container${compact ? ' compact-table' : ' panel'}`}><table><thead><tr><th>Quotation / client</th><th>Amount</th>{!compact && <th>Valid until</th>}<th>Status</th><th /></tr></thead><tbody>{quotes.map(q => <tr key={q.id}><td><button className="table-title" onClick={() => open({ type: 'quote_detail', id: q.id })}>{q.number || 'Draft quotation'}</button><small>{q.customer?.name || customerForLead(data, q.leadId)?.name || q.title}<DemoTag demo={q.isDemo} /></small>{!compact && <span className="table-subline">{q.title} · Rev. {q.revision}</span>}</td><td className="money-cell">{formatINR(q.totals.total, compact)}{q.totals.needsConfig && <small>Before GST</small>}</td>{!compact && <td>{displayDate(q.validUntil)}</td>}<td><Badge status={effectiveQuoteStatus(q)}>{compact && effectiveQuoteStatus(q) === 'ISSUED' ? 'Awaiting' : QUOTE_LABELS[effectiveQuoteStatus(q)]}</Badge></td><td><IconButton label={`View ${q.title}`} onClick={() => open({ type: 'quote_detail', id: q.id })}><ArrowUpRight size={16} /></IconButton></td></tr>)}</tbody></table></div>;
}
function WorkCard({ item: w, data, open }: { item: WorkOrder; data: WorkspaceData; open: OpenModal }) {
  const done = w.milestones.filter(m => m.status === 'DONE').length;
  const progress = w.milestones.length ? Math.round(done / w.milestones.length * 100) : 0;
  return <article className="work-card"><div className="work-card-top"><span className="work-card-icon"><HardHat size={21} strokeWidth={1.6} /></span><Badge status={w.status}>{WORK_LABELS[w.status]}</Badge><IconButton label={`Open ${w.title}`} onClick={() => open({ type: 'work_detail', id: w.id })}><MoreHorizontal size={19} /></IconButton></div><button className="work-title" onClick={() => open({ type: 'work_detail', id: w.id })}>{w.title}</button><p>{w.customerName}<DemoTag demo={w.isDemo} /></p><div className="work-progress-label"><span>{done} of {w.milestones.length} milestones complete</span><strong>{progress}%</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><footer><span><CalendarDays size={13} />{w.endDate ? `Due ${displayDate(w.endDate)}` : 'Dates to be scheduled'}</span><span className="work-owner"><Avatar small name={ownerName(data, w.owner)} /></span></footer><div className="work-bottom"><span>{w.number}</span><strong>{formatINR(w.snapshot.totals.total, true)}</strong></div></article>;
}

function SearchResults({ data, search, open, manageLeadStatus }: { data: WorkspaceData; search: string; open: OpenModal; manageLeadStatus: boolean }) {
  const matchingCustomerIds = new Set(data.customers.filter(c => `${c.name} ${c.contact} ${c.phone} ${c.email}`.toLowerCase().includes(search)).map(c => c.id));
  const leads = data.leads.filter(l => matchingCustomerIds.has(l.customerId) || `${l.title} ${l.contact} ${l.phone} ${l.location}`.toLowerCase().includes(search));
  const quotes = data.quotations.filter(q => `${q.title} ${q.number}`.toLowerCase().includes(search));
  const work = data.workorders.filter(w => `${w.title} ${w.number} ${w.customerName}`.toLowerCase().includes(search));
  const followups = data.followups.filter(f => `${f.title} ${f.notes} ${f.outcome} ${data.leads.find(l => l.id === f.leadId)?.title || ''}`.toLowerCase().includes(search));
  return <div className="search-results">{leads.length > 0 && <section><div className="section-heading"><h2>Leads <span className="count-pill">{leads.length}</span></h2></div><LeadTable data={data} leads={leads} open={open} manageLeadStatus={manageLeadStatus} /></section>}{quotes.length > 0 && <section><div className="section-heading"><h2>Quotations</h2></div><QuoteTable data={data} quotes={quotes} open={open} /></section>}{work.length > 0 && <section><div className="section-heading"><h2>Work orders</h2></div><div className="workorder-grid">{work.map(w => <WorkCard key={w.id} item={w} data={data} open={open} />)}</div></section>}{followups.length > 0 && <section className="panel"><PanelHeader title="Follow-ups" />{followups.map(f => <FollowupRow key={f.id} item={f} data={data} open={open} canEdit={['OWNER', 'MANAGER', 'SALES', 'OPERATIONS'].includes(data.user.role)} full />)}</section>}{!leads.length && !quotes.length && !work.length && !followups.length && <div className="panel"><Empty icon={Search} title="No matching records" detail="Try a project name, quotation number, customer contact or location." /></div>}</div>;
}

function SimpleForm({ children, onSubmit, busy, close, submit }: { children: ReactNode; onSubmit: (values: Record<string, string>) => Promise<unknown>; busy: boolean; close: () => void; submit?: string }) { return <form onSubmit={e => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>; void onSubmit(values); }}><fieldset disabled={busy}>{children}</fieldset><FormFooter busy={busy} onClose={close} label={submit} /></form>; }
function CustomerForm({ customer: c, busy, close, mutate }: { customer?: Customer; busy: boolean; close: () => void; mutate: Mutation }) { return <SimpleForm onSubmit={p => mutate('customer_save', { ...p, ...(c ? { id: c.id } : {}) })} busy={busy} close={close} submit={c ? 'Save customer' : 'Add customer'}><p className="form-description">Contact and billing details for your customer. Issued documents keep their original information.</p><div className="form-grid"><Field label="Customer / business name *" wide><input name="name" defaultValue={c?.name} required maxLength={200} placeholder="e.g. Mehta family residence" /></Field><Field label="Contact person"><input name="contact" defaultValue={c?.contact} placeholder="Full name" /></Field><Field label="Phone number"><input name="phone" defaultValue={c?.phone} type="tel" /></Field><Field label="Email address"><input name="email" defaultValue={c?.email} type="email" /></Field><Field label="State / territory"><select name="stateCode" defaultValue={c?.stateCode || ''}><StateOptions /></select></Field><Field label="Billing address" wide><textarea name="address" defaultValue={c?.address} rows={3} placeholder="Full billing address" /></Field><Field label="GSTIN" wide hint="Leave blank for an unregistered customer."><input name="gstin" defaultValue={c?.gstin} maxLength={15} placeholder="15-character GSTIN, if applicable" className="uppercase-input" /></Field></div></SimpleForm>; }
function LeadForm({ lead: l, data, busy, close, mutate, manageLeadStatus }: { lead?: Lead; data: WorkspaceData; busy: boolean; close: () => void; mutate: Mutation; manageLeadStatus: boolean }) {
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [customerId, setCustomerId] = useState(l?.customerId || '');
  const canChooseStage = manageLeadStatus && l?.status !== 'WON';
  const addCustomer = () => setAddingCustomer(true);
  const saveCustomer: Mutation = async (action, payload) => {
    const previousIds = new Set(data.customers.map(customer => customer.id));
    const next = await mutate(action, payload, false);
    if (next) {
      const created = next.customers.find(customer => !previousIds.has(customer.id));
      if (created) setCustomerId(created.id);
      setAddingCustomer(false);
    }
    return next;
  };
  return <><div hidden={addingCustomer}><SimpleForm onSubmit={p => mutate('lead_save', { ...p, ...(l ? { id: l.id } : {}), status: canChooseStage ? p.status : l?.status || 'NEW' })} busy={busy} close={close} submit={l ? 'Save lead' : 'Create lead'}>
    <p className="form-description">Capture the project, its potential value and who will move it forward.</p>
    {!data.customers.length && <div className="soft-callout"><ContactRound size={20} /><div><strong>Add the customer details</strong><p>A lead needs a customer to link quotations and billing details.</p><button type="button" className="text-link" onClick={addCustomer}>Create customer <ArrowRight size={14} /></button></div></div>}
    <div className="form-grid">
      <Field label="Project / enquiry title *" wide><input name="title" defaultValue={l?.title} required placeholder="e.g. Residential renovation, Sector 14" maxLength={200} /></Field>
      <Field label="Customer *" wide><select name="customerId" value={customerId} onChange={event => setCustomerId(event.target.value)} required><option value="">Select customer</option>{data.customers.map(c => <option key={c.id} value={c.id}>{c.name}{c.isDemo ? ' · Example' : ''}</option>)}</select></Field>
      {!!data.customers.length && <div className="field-wide"><button type="button" className="text-link" onClick={addCustomer}><Plus size={14} />Add customer details</button></div>}
      <Field label="Contact person"><input name="contact" defaultValue={l?.contact} /></Field>
      <Field label="Phone"><input name="phone" type="tel" defaultValue={l?.phone} /></Field>
      <Field label="Email"><input name="email" type="email" defaultValue={l?.email} /></Field>
      <Field label="Expected value (₹)"><input name="value" inputMode="decimal" type="number" step="0.01" min="0" defaultValue={l ? (l.value / 100).toFixed(2) : '0'} required /></Field>
      <Field label="Location / city"><input name="location" defaultValue={l?.location} placeholder="e.g. Hisar" /></Field>
      <Field label="Project state"><select name="stateCode" defaultValue={l?.stateCode || ''}><StateOptions /></select></Field>
      <Field label="Project site address" wide><textarea name="siteAddress" defaultValue={l?.siteAddress} rows={2} /></Field>
      <Field label="Assigned to"><select name="owner" defaultValue={assigneeValue(data, l ? l.owner : data.user.userId)}><MemberOptions data={data} /></select></Field>
      <Field label="Priority"><select name="priority" defaultValue={l?.priority || 'Medium'}><option>High</option><option>Medium</option><option>Low</option></select></Field>
      <Field label="Stage" hint={!manageLeadStatus ? 'Admin and Manager update lead status.' : l?.status === 'WON' ? 'Won is recorded from quotation acceptance.' : undefined}>
        {canChooseStage ? <select name="status" defaultValue={l?.status || 'NEW'}>{LEAD_STAGES.filter(s => s.value !== 'LOST' || l?.status === 'LOST').filter(s => s.value !== 'WON').filter(s => l?.status !== 'LOST' || ['NEW', 'LOST'].includes(s.value)).map(s => <option value={s.value} key={s.value}>{s.label}</option>)}</select> : <input readOnly value={leadLabel(l?.status || 'NEW')} />}
      </Field>
      <Field label="Lead source"><select name="source" defaultValue={l?.source || 'Referral'}>{['Referral', 'Website', 'Walk-in', 'Phone enquiry', 'Social media', 'Instagram', 'Repeat customer', 'Other'].map(s => <option key={s}>{s}</option>)}</select></Field>
      <Field label="Project notes" wide><textarea name="notes" rows={3} defaultValue={l?.notes} placeholder="Requirements, budget, timings and useful context…" /></Field>
    </div>
  </SimpleForm></div>{addingCustomer && <><h3>Add customer details</h3><CustomerForm busy={busy} close={() => setAddingCustomer(false)} mutate={saveCustomer} /></>}</>;
}
function LeadStatusForm({ lead, busy, close, mutate, open }: { lead: Lead; busy: boolean; close: () => void; mutate: Mutation; open: OpenModal }) {
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [reason, setReason] = useState(lead.lostReason);
  const changed = status !== lead.status || status === 'LOST' && reason.trim() !== lead.lostReason;
  const canSave = changed && (status !== 'LOST' || reason.trim().length > 0);
  if (lead.status === 'WON') return <div className="confirmation"><p>This lead is won. Its status is linked to the accepted quotation.</p><button type="button" className="button button-secondary" onClick={close}>Back to lead</button></div>;
  const choices = LEAD_STAGES.filter(stage => stage.value !== 'WON' && (lead.status !== 'LOST' || stage.value === 'NEW' || stage.value === 'LOST'));
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave || busy) return;
    const next = await mutate('lead_status', { id: lead.id, status, lostReason: status === 'LOST' ? reason.trim() : '' }, false);
    if (next) open({ type: 'lead_detail', id: lead.id });
  }
  return <form onSubmit={save}>
    <div className="form-intro"><Badge status={lead.status}>{leadLabel(lead.status)}</Badge><h3>{lead.title}</h3></div>
    <p className="form-description">{lead.status === 'LOST' ? 'Reopen this opportunity as a new enquiry before moving it through the pipeline again.' : 'Choose the next stage and save the update for your team.'}</p>
    <fieldset disabled={busy}>
      <Field label="Lead status" hint="Won is recorded when a quotation is accepted."><select name="status" value={status} onChange={event => setStatus(event.target.value as LeadStatus)}>{choices.map(stage => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></Field>
      {status === 'LOST' && <Field label="Reason for closing *" hint="The reason and lead history stay available to your team."><textarea name="lostReason" required rows={4} maxLength={3000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why did this opportunity not go ahead?" /></Field>}
    </fieldset>
    <FormFooter busy={busy} disabled={!canSave} onClose={close} label={lead.status === 'LOST' && status === 'NEW' ? 'Reopen lead' : 'Save status'} />
  </form>;
}
function FollowupForm({ item, data, leadId, busy, close, mutate }: { item?: FollowUp; data: WorkspaceData; leadId?: string; busy: boolean; close: () => void; mutate: Mutation }) { return <SimpleForm onSubmit={p => mutate('followup_save', { ...p, ...(item ? { id: item.id } : {}), dueAt: new Date(p.dueAt + '+05:30').toISOString() })} busy={busy} close={close} submit={item ? 'Save follow-up' : 'Schedule follow-up'}><div className="form-grid"><Field label="Lead / project *" wide><select name="leadId" defaultValue={item?.leadId || leadId || ''} required><option value="">Select project</option>{data.leads.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></Field><Field label="Next action *" wide><input name="title" required defaultValue={item?.title} placeholder="e.g. Confirm site visit and discuss scope" /></Field><Field label="Date & time (IST) *"><input name="dueAt" type="datetime-local" defaultValue={localInput(item?.dueAt)} required /></Field><Field label="Contact channel"><select name="channel" defaultValue={item?.channel || 'Call'}>{['Call', 'WhatsApp', 'Email', 'Site visit', 'Other'].map(s => <option key={s}>{s}</option>)}</select></Field><Field label="Assigned to" wide><select name="owner" defaultValue={assigneeValue(data, item ? item.owner : data.user.userId)}><MemberOptions data={data} /></select></Field><Field label="Notes / preparation" wide><textarea name="notes" rows={3} defaultValue={item?.notes} /></Field></div>{item?.status === 'OPEN' && <button type="button" className="text-link danger-text" onClick={() => void mutate('followup_cancel', { id: item.id })} disabled={busy}>Cancel this follow-up</button>}</SimpleForm>; }

function QuoteEditor({ quote, data, leadId, busy, close, mutate }: { quote?: Quotation; data: WorkspaceData; leadId?: string; busy: boolean; close: () => void; mutate: Mutation }) {
  const initialLead = data.leads.find(l => l.id === (quote?.leadId || leadId));
  const [selectedLead, setSelectedLead] = useState(quote?.leadId || leadId || '');
  const [title, setTitle] = useState(quote?.title || initialLead?.title || '');
  const [placeOfSupply, setPlaceOfSupply] = useState(quote?.placeOfSupply || initialLead?.stateCode || '');
  const [siteAddress, setSiteAddress] = useState(quote?.siteAddress || initialLead?.siteAddress || '');
  const [items, setItems] = useState<QuoteItemInput[]>(quote?.items.map(i => ({ id: i.id, description: i.description, hsnSac: i.hsnSac, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, discount: i.discount, gstRate: i.gstRate })) || []);
  const [localError, setLocalError] = useState('');
  let totals: QuoteTotals | null = null, previewError = '';
  try { totals = computeQuote(items, data.company.stateCode, placeOfSupply).totals; } catch (e) { previewError = e instanceof Error ? e.message : 'Complete the work items to calculate totals.'; }
  const updateItem = (id: string, key: keyof QuoteItemInput, value: string) => setItems(rows => rows.map(row => row.id === id ? { ...row, [key]: value } : row));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLocalError('');
    try { computeQuote(items, data.company.stateCode, placeOfSupply); } catch (e) { setLocalError(e instanceof Error ? e.message : 'Review the work items.'); return; }
    const p = Object.fromEntries(new FormData(event.currentTarget).entries());
    void mutate('quote_save', { ...p, ...(quote ? { id: quote.id } : {}), leadId: selectedLead, title, placeOfSupply, siteAddress, items });
  };
  return <form onSubmit={submit}><fieldset disabled={busy}><p className="form-description">Define the scope and pricing. A manager reviews and issues the final quotation.</p>{localError && <div className="inline-alert error">{localError}</div>}<div className="form-grid"><Field label="Lead / project *" wide><select value={selectedLead} required disabled={!!quote} onChange={e => { const l = data.leads.find(v => v.id === e.target.value); setSelectedLead(e.target.value); if (l) { setTitle(l.title); setPlaceOfSupply(l.stateCode); setSiteAddress(l.siteAddress); } }}><option value="">Choose a lead</option>{data.leads.filter(l => l.status !== 'LOST').map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></Field><Field label="Quotation title *" wide><input value={title} onChange={e => setTitle(e.target.value)} required /></Field><Field label="Valid until *"><input type="date" name="validUntil" defaultValue={quote?.validUntil || plusDays(30)} required /></Field><Field label="Project place of supply"><select value={placeOfSupply} onChange={e => setPlaceOfSupply(e.target.value)}><StateOptions /></select></Field><Field label="Project site address" wide><textarea value={siteAddress} onChange={e => setSiteAddress(e.target.value)} rows={2} /></Field></div><div className="editor-section-heading"><div><h3>Work items</h3><p>Prices before GST. Discounts apply to the whole line.</p></div><button type="button" className="button button-secondary button-small" onClick={() => setItems(rows => [...rows, { id: crypto.randomUUID(), description: '', hsnSac: '', quantity: '1', unit: 'job', unitPrice: '', discount: '0', gstRate: '' }])}><Plus size={15} />Add item</button></div>{!items.length && <div className="quote-items-empty"><FileText size={23} /><p>Add your scope of work, quantities and reviewed tax rates.</p></div>}{items.map((item, index) => <section className="quote-item-editor" key={item.id}><header><span className="item-number">{String(index + 1).padStart(2, '0')}</span><strong>Work item</strong><IconButton label={`Remove item ${index + 1}`} onClick={() => setItems(rows => rows.filter(r => r.id !== item.id))}><Trash2 size={16} /></IconButton></header><div className="form-grid"><Field label="Description *" wide><input value={item.description} required placeholder="Describe the work or material" onChange={e => updateItem(item.id, 'description', e.target.value)} /></Field><Field label="HSN / SAC *"><input value={item.hsnSac} pattern="[0-9]{4,8}" maxLength={8} required placeholder="Reviewed code" onChange={e => updateItem(item.id, 'hsnSac', e.target.value)} /></Field><Field label="Unit"><select value={item.unit} onChange={e => updateItem(item.id, 'unit', e.target.value)}>{[...new Set([...units, item.unit])].map(unit => <option key={unit}>{unit}</option>)}</select></Field></div><div className="item-numbers"><Field label="Quantity *"><input type="number" min="0.001" step="0.001" value={item.quantity} required onChange={e => updateItem(item.id, 'quantity', e.target.value)} /></Field><Field label="Unit price (₹) *"><input type="number" min="0" step="0.01" value={item.unitPrice} required onChange={e => updateItem(item.id, 'unitPrice', e.target.value)} /></Field><Field label="Discount (₹)"><input type="number" min="0" step="0.01" value={item.discount} onChange={e => updateItem(item.id, 'discount', e.target.value)} /></Field><Field label="GST rate (%) *"><input type="number" min="0" max="100" step="0.01" value={item.gstRate} required placeholder="Explicit rate" onChange={e => updateItem(item.id, 'gstRate', e.target.value)} /></Field></div></section>)}<div className="quote-editor-bottom"><Field label="Terms & exclusions"><textarea name="terms" rows={6} defaultValue={quote?.terms ?? data.company.terms} /></Field>{totals ? <Totals totals={totals} /> : <div className="calculation-note"><CircleAlert size={20} /><p>{previewError}</p></div>}</div><div className="form-note"><ShieldCheck size={15} /><p>Ordinary domestic forward-charge supplies only. Use reviewed classifications and rates; no universal construction GST rate is assumed.</p></div></fieldset><FormFooter busy={busy} onClose={close} label={quote ? 'Save quotation' : 'Save draft quotation'} /></form>;
}
function Totals({ totals: t }: { totals: QuoteTotals }) { return <dl className="quote-totals"><div><dt>Subtotal</dt><dd>{formatINR(t.subtotal)}</dd></div><div><dt>Discount</dt><dd>− {formatINR(t.discount)}</dd></div><div><dt>Taxable value</dt><dd>{formatINR(t.taxable)}</dd></div>{t.needsConfig ? <div className="tax-config-note"><CircleAlert size={14} /><span>GST setup needed — tax not yet calculated</span></div> : t.mode === 'IGST' ? <div><dt>IGST</dt><dd>{formatINR(t.igst)}</dd></div> : <><div><dt>CGST</dt><dd>{formatINR(t.cgst)}</dd></div><div><dt>{t.mode === 'CGST_UTGST' ? 'UTGST' : 'SGST'}</dt><dd>{formatINR(t.utgst || t.sgst)}</dd></div></>}<div className="total-final"><dt>{t.needsConfig ? 'Total before GST' : 'Total incl. GST'}</dt><dd>{formatINR(t.total)}</dd></div></dl>; }

function LeadDetail({ lead: l, data, permissions: p, open, busy }: { lead: Lead; data: WorkspaceData; permissions: PermissionFlags; open: OpenModal; busy: boolean }) {
  const customer = data.customers.find(c => c.id === l.customerId);
  return <div className="record-detail"><div className="detail-title"><div><Badge status={l.status}>{leadLabel(l.status)}</Badge><DemoTag demo={l.isDemo} /><h3>{l.title}</h3><p>{customer?.name}</p></div><div className="lead-detail-actions">{p.manageLeadStatus && l.status !== 'WON' && <button type="button" className="button button-primary button-small" disabled={busy} onClick={() => open({ type: 'lead_status', id: l.id })}><RefreshCw size={15} />Change status</button>}{p.commercial && <button className="button button-secondary button-small" disabled={busy} onClick={() => open({ type: 'lead', id: l.id })}><Pencil size={15} />Edit lead</button>}</div></div><div className="lead-detail-value"><span>Expected project value</span><strong>{formatINR(l.value)}</strong></div><dl className="detail-grid"><DetailField label="Contact person">{l.contact || customer?.contact}</DetailField><DetailField label="Assigned to">{ownerName(data, l.owner)}</DetailField><DetailField label="Phone">{l.phone || customer?.phone}</DetailField><DetailField label="Email">{l.email || customer?.email}</DetailField><DetailField label="Project location">{l.location}</DetailField><DetailField label="Project state">{stateLabel(l.stateCode)}</DetailField><DetailField label="Source">{l.source}</DetailField><DetailField label="Priority">{l.priority}</DetailField></dl><section className="detail-section"><h4>Site address</h4><Notes>{l.siteAddress || 'Add the project address before preparing the final quotation.'}</Notes></section>{l.notes && <section className="detail-section"><h4>Project notes</h4><Notes>{l.notes}</Notes></section>}{l.lostReason && <div className="soft-callout"><CircleAlert size={18} /><p>{l.lostReason}</p></div>}{p.commercial && customer && <div className="detail-section-heading"><h4>Customer information</h4><button type="button" className="text-link" disabled={busy} onClick={() => open({ type: 'customer', id: customer.id })}><Pencil size={14} />Edit customer details</button></div>}<div className="detail-section-heading"><h4>Follow-ups</h4>{p.follow && <button className="text-link" onClick={() => open({ type: 'followup', leadId: l.id })}><Plus size={15} />Schedule</button>}</div><div className="detail-followups">{data.followups.filter(f => f.leadId === l.id).slice(0, 6).map(f => <FollowupRow key={f.id} item={f} data={data} open={open} canEdit={p.follow} />)}{!data.followups.some(f => f.leadId === l.id) && <p className="muted small-text">No follow-up scheduled yet.</p>}</div><div className="detail-section-heading"><h4>Quotations</h4>{p.commercial && l.status !== 'LOST' && <button className="text-link" onClick={() => open({ type: 'quote', leadId: l.id })}><Plus size={15} />Create quotation</button>}</div>{data.quotations.filter(q => q.leadId === l.id).map(q => <button className="document-link" key={q.id} onClick={() => open({ type: 'quote_detail', id: q.id })}><FileText size={19} /><span><strong>{q.number || 'Draft quotation'}</strong><small>Revision {q.revision} · {QUOTE_LABELS[effectiveQuoteStatus(q)]}</small></span><b>{formatINR(q.totals.total, true)}</b><ChevronRight size={17} /></button>)}{!data.quotations.some(q => q.leadId === l.id) && <p className="muted small-text">Create a quotation when the work scope is ready.</p>}</div>;
}
function QuoteDetail({ quote: q, data, permissions: p, open, busy, mutate, print }: { quote: Quotation; data: WorkspaceData; permissions: PermissionFlags; open: OpenModal; busy: boolean; mutate: Mutation; print: (quote: Quotation) => void }) {
  const customer = q.customer || customerForLead(data, q.leadId);
  const status = effectiveQuoteStatus(q);
  const work = data.workorders.find(w => w.quoteId === q.id);
  return <div className="record-detail"><div className="detail-title"><div><Badge status={status}>{QUOTE_LABELS[status]}</Badge><DemoTag demo={q.isDemo} /><h3>{q.title}</h3><p>{q.number || 'Number assigned on issue'} · Revision {q.revision}</p></div><button className="button button-secondary button-small" onClick={() => print(q)}><Printer size={15} />Print</button></div><dl className="detail-grid"><DetailField label="Customer">{customer?.name}</DetailField><DetailField label="Valid until">{displayDate(q.validUntil, { year: 'numeric' })}</DetailField><DetailField label="Place of supply">{stateLabel(q.placeOfSupply)}</DetailField><DetailField label="GST treatment">{q.totals.needsConfig ? 'Registration details needed' : q.totals.mode.replaceAll('_', ' + ')}</DetailField></dl><div className="table-container quote-detail-table"><table><thead><tr><th>Work item</th><th>Quantity</th><th>Rate</th><th>GST</th><th>Total</th></tr></thead><tbody>{q.items.map(i => <tr key={i.id}><td><strong>{i.description}</strong><small>HSN/SAC {i.hsnSac}</small></td><td>{i.quantity} {i.unit}</td><td>{formatINR(Math.round(Number(i.unitPrice) * 100))}</td><td>{i.gstRate}%</td><td className="money-cell">{formatINR(i.total)}</td></tr>)}</tbody></table>{!q.items.length && <p className="muted empty-inline">No work items added.</p>}</div><div className="quote-editor-bottom"><section><h4>Terms & scope</h4><Notes>{q.terms || 'No additional terms.'}</Notes><h4>Project site</h4><Notes>{q.siteAddress || 'Not entered'}</Notes></section><Totals totals={q.totals} /></div>{q.acceptanceNote && <section className="acceptance-note"><CheckCircle2 size={20} /><div><strong>Customer acceptance recorded</strong><p>{q.acceptanceNote}</p></div></section>}<div className="detail-actions">{q.status === 'DRAFT' && p.commercial && <button className="button button-secondary" onClick={() => open({ type: 'quote', id: q.id })}><Pencil size={16} />Edit quotation</button>}{q.status === 'DRAFT' && p.approve && <button className="button button-primary" disabled={busy} onClick={() => void mutate('quote_issue', { id: q.id }, false)}><FileText size={16} />Issue quotation</button>}{status === 'ISSUED' && p.approve && <><button className="button button-primary" onClick={() => open({ type: 'quote_accept', id: q.id })}><Check size={16} />Record acceptance</button><button className="button button-secondary" disabled={busy} onClick={() => void mutate('quote_decline', { id: q.id }, false)}>Mark declined</button></>}{['ISSUED', 'DECLINED', 'EXPIRED'].includes(status) && p.commercial && <button className="button button-secondary" disabled={busy} onClick={async () => { const next = await mutate('quote_revise', { id: q.id }, false); const revision = next?.quotations.find(v => v.revisionOf === q.id && v.status === 'DRAFT'); if (revision) open({ type: 'quote', id: revision.id }); }}><RefreshCw size={16} />Create revision</button>}{q.status === 'ACCEPTED' && (work ? <button className="button button-primary" onClick={() => open({ type: 'work_detail', id: work.id })}>Open work order <ArrowRight size={16} /></button> : p.approve && <button className="button button-primary" disabled={busy} onClick={async () => { const next = await mutate('quote_convert', { id: q.id }, false); const created = next?.workorders.find(w => w.quoteId === q.id); if (created) open({ type: 'work_detail', id: created.id }); }}><HardHat size={17} />Create work order</button>)}</div><p className="document-disclaimer">Quotation only — not a GST tax invoice. Issued prices, parties and tax details are preserved.</p></div>;
}
function WorkForm({ item: w, data, busy, close, mutate }: { item: WorkOrder; data: WorkspaceData; busy: boolean; close: () => void; mutate: Mutation }) { return <SimpleForm onSubmit={p => mutate('workorder_save', { ...p, id: w.id })} busy={busy} close={close} submit="Update work order"><p className="form-description">Update delivery responsibility and progress. The accepted commercial scope stays fixed.</p><div className="form-grid"><Field label="Work owner" wide><select name="owner" defaultValue={assigneeValue(data, w.owner)}><MemberOptions data={data} /></select></Field><Field label="Start date"><input name="startDate" type="date" defaultValue={w.startDate} /></Field><Field label="Target completion"><input name="endDate" type="date" defaultValue={w.endDate} /></Field><Field label="Progress status" wide><select name="status" defaultValue={w.status}>{Object.entries(WORK_LABELS).filter(([code]) => WORK_TRANSITIONS[w.status].includes(code)).map(([code, label]) => <option key={code} value={code} disabled={code === 'COMPLETED' && w.milestones.some(m => m.status !== 'DONE')}>{label}{code === 'COMPLETED' && w.milestones.some(m => m.status !== 'DONE') ? ' — finish milestones first' : ''}</option>)}</select></Field></div></SimpleForm>; }
function WorkDetail({ item: w, data, delivery, open, busy, mutate }: { item: WorkOrder; data: WorkspaceData; delivery: boolean; open: OpenModal; busy: boolean; mutate: Mutation }) {
  const closed = ['COMPLETED', 'CANCELLED'].includes(w.status);
  return <div className="record-detail"><div className="detail-title"><div><Badge status={w.status}>{WORK_LABELS[w.status]}</Badge><DemoTag demo={w.isDemo} /><h3>{w.title}</h3><p>{w.number} · {w.customerName}</p></div>{delivery && !closed && <button className="button button-secondary button-small" onClick={() => open({ type: 'work_edit', id: w.id })}><Pencil size={15} />Update progress</button>}</div><dl className="detail-grid"><DetailField label="Work owner">{ownerName(data, w.owner)}</DetailField><DetailField label="Agreed total incl. GST">{formatINR(w.snapshot.totals.total)}</DetailField><DetailField label="Start date">{displayDate(w.startDate)}</DetailField><DetailField label="Target completion">{displayDate(w.endDate)}</DetailField></dl><section className="detail-section"><h4>Project site</h4><Notes>{w.siteAddress}</Notes></section><div className="detail-section-heading"><h4>Delivery milestones</h4>{delivery && !closed && <button className="text-link" onClick={() => open({ type: 'milestone', workId: w.id })}><Plus size={15} />Add milestone</button>}</div><div className="milestone-list">{w.milestones.map((m, i) => <article key={m.id} className={m.status === 'DONE' ? 'milestone-done' : ''}><span className="milestone-state">{m.status === 'DONE' ? <Check size={17} /> : i + 1}</span><div><strong>{m.title}</strong><small>{m.dueDate ? `Due ${displayDate(m.dueDate)}` : 'No target date'}</small></div>{delivery && !closed && m.status !== 'DONE' && <button className="button button-secondary button-small" disabled={busy} onClick={() => void mutate('milestone_complete', { workorderId: w.id, milestoneId: m.id }, false)}>Complete</button>}{m.status === 'DONE' && <Badge status="done">Done</Badge>}</article>)}{!w.milestones.length && <p className="muted empty-inline">Break the agreed work into clear delivery checkpoints.</p>}</div><div className="detail-section-heading"><h4>Agreed scope</h4><button className="text-link" onClick={() => open({ type: 'quote_detail', id: w.quoteId })}>View quotation <ArrowUpRight size={15} /></button></div><div className="scope-list">{w.snapshot.items.map((item, i) => <div key={item.id}><span>{String(i + 1).padStart(2, '0')}</span><div><strong>{item.description}</strong><small>{item.quantity} {item.unit} · HSN/SAC {item.hsnSac}</small></div><b>{formatINR(item.total)}</b></div>)}</div><section className="detail-section"><h4>Terms</h4><Notes>{w.snapshot.terms}</Notes></section></div>;
}

function SettingsView({ data, owner, busy, mutate, open, onUpdated }: { data: WorkspaceData; owner: boolean; busy: boolean; mutate: Mutation; open: OpenModal; onUpdated: (value: WorkspaceData) => void }) {
  const [settingsTab, setSettingsTab] = useState('company');
  const c = data.company;
  return <><div className="list-toolbar"><div className="tabs">{[['company', 'Company details'], ['team', 'Team & roles'], ['security', 'Account security'], ['data', 'Workspace data']].map(([code, title]) => <button key={code} className={settingsTab === code ? 'selected' : ''} onClick={() => setSettingsTab(code)}>{title}</button>)}</div></div>
    {settingsTab === 'company' && <section className="panel settings-panel"><PanelHeader title="Make it your workspace" eyebrow="COMPANY & GST" /><p className="settings-intro">Your legal details appear on issued quotations. Currency is INR and the workspace uses India Standard Time.</p><form key={data.revision} onSubmit={e => { e.preventDefault(); void mutate('company_save', Object.fromEntries(new FormData(e.currentTarget).entries()), false); }}><fieldset disabled={!owner || busy}><div className="form-grid"><Field label="Company display name *"><input name="name" required defaultValue={c.name} /></Field><Field label="Registered legal name"><input name="legalName" defaultValue={c.legalName} placeholder="As on the GST registration" /></Field><Field label="GSTIN" hint="Use your actual registration, not example details."><input name="gstin" defaultValue={c.gstin} maxLength={15} className="uppercase-input" /></Field><Field label="Registration state"><select name="stateCode" defaultValue={c.stateCode}><StateOptions /></select></Field><Field label="Registered address" wide><textarea name="address" rows={3} defaultValue={c.address} /></Field><Field label="Business phone"><input name="phone" type="tel" defaultValue={c.phone} /></Field><Field label="Business email"><input name="email" type="email" defaultValue={c.email} /></Field><Field label="Website"><input name="website" defaultValue={c.website} placeholder="https://" /></Field><Field label="Currency & timezone"><input readOnly value="INR (₹) · Asia/Kolkata" /></Field><Field label="Default quotation terms" wide><textarea name="terms" rows={4} defaultValue={c.terms} /></Field></div></fieldset><div className="settings-form-footer"><span><ShieldCheck size={16} />{owner ? 'Only workspace owners can change company details.' : 'Your owner manages company details.'}</span>{owner && <button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}Save company details</button>}</div></form></section>}
    {settingsTab === 'team' && <TeamSettings data={data} owner={owner} busy={busy} mutate={mutate} onUpdated={onUpdated} />}
    {settingsTab === 'security' && <AccountSecurity email={data.user.email} owner={owner} />}
    {settingsTab === 'data' && <section className="panel data-settings"><PanelHeader title="Your workspace data" /><div><span className="settings-feature-icon"><Download size={23} /></span><h3>Export your records</h3><p>Download your accessible records as JSON, including stock, attendance and expenses. Only the Owner receives company-wide attendance, expenses and team activity history. Keep exports securely; they contain business and personal information.</p><a className="button button-secondary" href="/api/export"><Download size={16} />Export workspace</a></div>{owner && <div><span className="settings-feature-icon"><Sparkles size={23} /></span><h3>Explore with examples</h3><p>Load clearly labelled sample projects to try the workflow. Real records and company settings are preserved.</p><div className="heading-actions"><button className="button button-secondary" onClick={() => open({ type: 'load_demo' })}>Load example workspace</button>{data.leads.some(l => l.isDemo) && <button className="text-link danger-text" onClick={() => open({ type: 'clear_demo' })}>Clear example records</button>}</div></div>}</section>}
  </>;
}
function modalTitle(type: string, lead?: Lead, quote?: Quotation, work?: WorkOrder) { return ({ customer: 'Customer details', lead: lead ? 'Edit lead' : 'Add a new lead', followup: 'Schedule a follow-up', followup_complete: 'Complete follow-up', lead_status: 'Change lead status', quote: quote ? 'Edit draft quotation' : 'Create a quotation', quote_accept: 'Record customer acceptance', work_edit: 'Update work order', milestone: 'Add a milestone', lead_detail: 'Lead details', quote_detail: quote?.number || 'Quotation details', work_detail: work?.number || 'Work order', load_demo: 'Explore your workspace', clear_demo: 'Clear example records', help: 'Your workspace, at a glance' } as Record<string, string>)[type] || 'Workspace'; }
function QuoteDocument({ quote: q, data }: { quote: Quotation; data: WorkspaceData }) {
  const supplier = q.supplier || data.company;
  const customer = q.customer || customerForLead(data, q.leadId);
  return <article className="quotation-document"><header><div><span className="document-brand">{supplier.name}</span><h1>Quotation</h1><p>Commercial quotation · not a tax invoice</p></div><div><strong>{q.number || 'DRAFT — NOT ISSUED'}</strong><p>Revision {q.revision}</p><p>Valid until {displayDate(q.validUntil, { year: 'numeric' })}</p>{q.isDemo && <b>EXAMPLE · NOT FOR CUSTOMER USE</b>}</div></header><h2>{q.title}</h2><div className="document-parties"><section><h3>From</h3><strong>{supplier.legalName || supplier.name}</strong><p>{supplier.address}</p><p>GSTIN: {supplier.gstin || 'Not configured'}</p></section><section><h3>To</h3><strong>{customer?.name}</strong><p>{customer?.address}</p><p>GSTIN: {customer?.gstin || 'Unregistered'}</p></section></div><div className="document-site"><strong>Place of supply: {stateLabel(q.placeOfSupply)}</strong><p>{q.siteAddress}</p></div><table><thead><tr><th>Work item / HSN/SAC</th><th>Qty</th><th>Unit price ₹</th><th>Discount ₹</th><th>GST %</th><th>Total ₹</th></tr></thead><tbody>{q.items.map(i => <tr key={i.id}><td><strong>{i.description}</strong><small>{i.hsnSac}</small></td><td>{i.quantity} {i.unit}</td><td>{i.unitPrice}</td><td>{i.discount}</td><td>{i.gstRate}</td><td>{(i.total / 100).toFixed(2)}</td></tr>)}</tbody></table><div className="quote-editor-bottom"><section><h3>Terms & exclusions</h3><p className="preserve">{q.terms}</p></section><Totals totals={q.totals} /></div><footer>Currency: INR. Amounts rounded to paise per line and tax component. This document is not a GST tax invoice.</footer></article>;
}
