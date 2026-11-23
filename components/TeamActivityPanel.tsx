'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowRight, CalendarDays, CalendarClock, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, CircleAlert, ContactRound, FileText, HardHat,
  LoaderCircle, Package, ReceiptText, RefreshCw, Settings2, ShieldCheck, UsersRound, X,
} from 'lucide-react';
import type { Member, WorkspaceData } from '@/lib/types';
import { todayIST } from '@/lib/finance';
import { TEAM_ACTIVITY_MODULES, type TeamActivityData, type TeamActivityEntry, type TeamActivityModule } from '@/lib/operations-types';
import styles from './TeamActivityPanel.module.css';

type Props = { workspace: WorkspaceData; search: string };
type Query = { month: string; employeeId: string; module: TeamActivityModule; page: number };
type Change = { label: string; before: string; after: string };
type Snapshot = Record<string, unknown> | null;

const MODULE_LABELS: Record<TeamActivityModule, string> = {
  all: 'All modules', leads: 'Leads', followups: 'Follow-ups', quotations: 'Quotations',
  workorders: 'Work orders', customers: 'Customers', team: 'Team access', settings: 'Settings',
  stock: 'Stock', attendance: 'Attendance', expenses: 'Expenses',
  payments: 'Customer payments',
};
const MODULE_ICONS: Record<TeamActivityModule, typeof Activity> = {
  all: Activity, leads: UsersRound, followups: CalendarClock, quotations: FileText,
  workorders: HardHat, customers: ContactRound, team: ShieldCheck, settings: Settings2,
  stock: Package, attendance: CalendarDays, expenses: ReceiptText,
  payments: ReceiptText,
};
const STATUS_LABELS: Record<string, string> = {
  PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'On leave',
  SUBMITTED: 'Awaiting review', APPROVED: 'Approved', REJECTED: 'Rejected', PAID: 'Paid', WITHDRAWN: 'Withdrawn',
  IN: 'Stock received', OUT: 'Stock used / issued', ADJUST: 'Balance correction', SELF: 'Employee', ADMIN: 'Administrator',
  OPEN: 'Open', PART_RECEIVED: 'Part received', RECEIVED: 'Received', CANCELLED: 'Cancelled', FULFILLED: 'Fulfilled', READY: 'Attached',
};
const TRACKED_FIELDS: [string, string][] = [
  ['name', 'Name'], ['sku', 'Stock code'], ['title', 'Title'], ['memberName', 'Employee'],
  ['unit', 'Unit'], ['location', 'Storage location'], ['quantityMilli', 'Remaining stock'],
  ['minQuantityMilli', 'Reorder level'], ['active', 'Item availability'], ['workDate', 'Attendance date'],
  ['expenseDate', 'Expense date'], ['category', 'Category'], ['amountPaise', 'Amount'],
  ['status', 'Status'], ['checkIn', 'Check-in (IST)'], ['checkOut', 'Check-out (IST)'],
  ['site', 'Site / project'], ['reference', 'Bill / payment reference'], ['notes', 'Notes'],
  ['reviewNote', 'Review note'], ['reviewedBy', 'Reviewed by'], ['reviewedAt', 'Reviewed at (IST)'], ['source', 'Recorded by'],
  ['fileName', 'Receipt file'], ['mimeType', 'File type'], ['sizeBytes', 'File size'],
  ['paymentDate', 'Payment date'], ['dueDate', 'Due date'], ['method', 'Payment method'],
  ['voidedAt', 'Voided at (IST)'], ['voidReason', 'Reason for void'], ['cancelReason', 'Cancellation reason'],
  ['supplier', 'Supplier'], ['expectedOn', 'Expected delivery'], ['neededOn', 'Required by'],
  ['configured', 'Shift rules enabled'], ['startLocal', 'Shift starts (IST)'], ['endLocal', 'Shift finishes (IST)'],
  ['overnight', 'Overnight shift'], ['breakMinutes', 'Unpaid break'], ['graceMinutes', 'Arrival grace period'],
  ['approvedOvertimeMinutes', 'Approved overtime'], ['overtimeReason', 'Overtime review reason'],
];

function simple(value: unknown): string { return typeof value === 'string' ? value : ''; }
function integer(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}
function quantity(value: unknown, unit: string, signed = false): string {
  const amount = integer(value);
  if (amount === null) return 'Not recorded';
  const absolute = amount < 0n ? -amount : amount;
  const fraction = String(absolute % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${amount < 0n ? '−' : signed && amount > 0n ? '+' : ''}${(absolute / 1000n).toLocaleString('en-IN')}${fraction ? `.${fraction}` : ''}${unit ? ` ${unit}` : ''}`;
}
function money(value: unknown): string {
  const amount = integer(value);
  if (amount === null) return 'Not recorded';
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(absolute % 100n).padStart(2, '0')}`;
}
function dayLabel(value: string): string {
  return new Date(`${value}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function timestamp(value: string): string {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function formatField(key: string, value: unknown, snapshot: Snapshot, members: Map<string, Member>, fallbackUnit: string): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (key === 'amountPaise') return money(value);
  if (key.endsWith('Milli')) return quantity(value, simple(snapshot?.unit) || fallbackUnit);
  if (key === 'active') return value === true ? 'Active' : 'Archived';
  if (key === 'configured' || key === 'overnight') return value === true ? 'Yes' : 'No';
  if (key.endsWith('Minutes')) return `${value} minutes`;
  if (key === 'sizeBytes' && typeof value === 'number') return `${Math.ceil(value / 1024)} KB`;
  if (key === 'reviewedBy') return members.get(simple(value))?.name || 'Team member';
  if (key === 'checkIn' || key === 'checkOut' || key === 'reviewedAt' || key === 'voidedAt') return timestamp(simple(value));
  if (['workDate', 'expenseDate', 'paymentDate', 'dueDate', 'expectedOn', 'neededOn'].includes(key)) return dayLabel(simple(value));
  if (key === 'status' || key === 'source') return STATUS_LABELS[simple(value)] || 'Recorded';
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'Not recorded';
}
function changesFor(entry: TeamActivityEntry, members: Map<string, Member>): Change[] {
  const before = entry.before, after = entry.after;
  if (!before && !after) return [];
  const unit = simple(after?.unit) || simple(before?.unit);
  if (entry.entityType === 'stock_movement') {
    const movement = simple(after?.type);
    const rows: Change[] = [
      { label: 'Movement', before: 'Not recorded', after: STATUS_LABELS[movement] || 'Stock movement' },
      { label: movement === 'ADJUST' ? 'Corrected balance' : movement === 'OUT' ? 'Quantity used' : 'Quantity received', before: 'Not recorded', after: quantity(after?.quantityMilli, unit) },
      { label: 'Change in stock', before: 'Not recorded', after: quantity(after?.deltaMilli, unit, true) },
      { label: 'Remaining stock', before: quantity(before?.quantityMilli, unit), after: quantity(after?.balanceAfterMilli, unit) },
    ];
    if (simple(after?.reference)) rows.push({ label: 'Reference', before: 'Not recorded', after: simple(after?.reference) });
    if (simple(after?.note)) rows.push({ label: 'Movement note', before: 'Not recorded', after: simple(after?.note) });
    return rows;
  }
  return TRACKED_FIELDS.flatMap(([key, label]) => {
    const oldValue = before?.[key], newValue = after?.[key];
    if (oldValue === undefined && newValue === undefined) return [];
    const oldText = formatField(key, oldValue, before, members, unit);
    const newText = formatField(key, newValue, after, members, unit);
    if (oldText === newText || (!before && newText === 'Not recorded')) return [];
    return [{ label, before: oldText, after: newText }];
  });
}
function subject(entry: TeamActivityEntry): string {
  return simple(entry.after?.title) || simple(entry.after?.name) || simple(entry.before?.name) || simple(entry.after?.memberName) || '';
}

export default function TeamActivityPanel(props: Props) {
  if (props.workspace.user.role !== 'OWNER' || !props.workspace.user.active) return <AccessNotice />;
  return <AdministratorActivity key={props.workspace.user.userId} {...props} />;
}

function AccessNotice() {
  return <section className={styles.access}><ShieldCheck size={29} /><h2>Administrator access required</h2><p>Team activity is available to an active workspace administrator.</p></section>;
}

function AdministratorActivity({ workspace, search }: Props) {
  const [query, setQuery] = useState<Query>(() => ({ month: todayIST().slice(0, 7), employeeId: '', module: 'all', page: 1 }));
  const [result, setResult] = useState<{ key: string; data: TeamActivityData } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const expandedTrigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const key = JSON.stringify(query);
  const current = result?.key === key ? result.data : null;
  const memberMap = new Map(workspace.members.map(member => [member.userId, member]));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  const load = useCallback(() => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    const requestSequence = ++sequence.current;
    const params = new URLSearchParams({ month: query.month, module: query.module, page: String(query.page) });
    if (query.employeeId) params.set('employeeId', query.employeeId);
    return fetch(`/api/team-activity?${params}`, { cache: 'no-store', credentials: 'same-origin', signal: request.signal }).then(async response => {
      if (!mounted.current || requestSequence !== sequence.current) return;
      if (response.status === 401 || response.status === 403) {
        setResult(null); setExpanded(null); setForbidden(true);
        throw new Error(response.status === 401 ? 'Your session has ended. Sign in again to review team activity.' : 'Your account no longer has access to team activity.');
      }
      const body = await response.json() as TeamActivityData & { error?: string };
      if (!mounted.current || requestSequence !== sequence.current) return;
      if (!response.ok) throw new Error(body.error || 'Team activity could not be loaded. Please try again.');
      setForbidden(false); setResult({ key: JSON.stringify(query), data: body });
    }).catch((cause: unknown) => {
      if (!request.signal.aborted && mounted.current && requestSequence === sequence.current) {
        setError(cause instanceof Error ? cause.message : 'Check your connection and try again.');
      }
    }).finally(() => {
      if (mounted.current && requestSequence === sequence.current) setLoading(false);
    });
  }, [query]);
  useEffect(() => { void load(); }, [load]);

  const closeDetails = useCallback(() => {
    setExpanded(null);
    requestAnimationFrame(() => { if (expandedTrigger.current?.isConnected) expandedTrigger.current.focus(); });
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const back = (event: Event) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeDetails();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); closeDetails(); } };
    window.addEventListener('smart-construction-back', back, true);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('smart-construction-back', back, true); document.removeEventListener('keydown', escape); };
  }, [expanded, closeDetails]);

  function filter(update: Partial<Query>) {
    setLoading(true); setError(''); setExpanded(null);
    setQuery(value => ({ ...value, ...update, page: 1 }));
  }
  function page(value: number) {
    setLoading(true); setError(''); setExpanded(null); setQuery(previous => ({ ...previous, page: value }));
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function refresh() { setLoading(true); setError(''); setExpanded(null); void load(); }

  const entries = (current?.entries || []).filter(entry => {
    const needle = search.trim().toLocaleLowerCase();
    return !needle || [entry.actorName, entry.description, MODULE_LABELS[entry.module], subject(entry), entry.reason].some(value => value.toLocaleLowerCase().includes(needle));
  });
  const groups = new Map<string, TeamActivityEntry[]>();
  for (const entry of entries) {
    const day = todayIST(new Date(entry.createdAt));
    groups.set(day, [...(groups.get(day) || []), entry]);
  }
  const members = [...workspace.members].sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name));
  const pages = current ? Math.max(1, Math.ceil(current.total / current.pageSize)) : 1;

  return <div className={styles.workspace} aria-busy={loading}>
    <div className={styles.intro}><span className={styles.introIcon}><ShieldCheck size={21} /></span><div><strong>A clear record of your team’s work</strong><p>See who recorded each change, when it happened, and the details available for that action.</p></div><span className={styles.adminBadge}>Administrator only</span></div>
    <section className={styles.filters} aria-label="Filter team activity"><label><span><CalendarDays size={13} />Month</span><input type="month" value={query.month} min="2000-01" max={todayIST().slice(0, 7)} disabled={loading} onChange={event => { if (event.target.value) filter({ month: event.target.value }); }} /></label><label><span><UsersRound size={13} />Employee</span><select value={query.employeeId} disabled={loading} onChange={event => filter({ employeeId: event.target.value })}><option value="">All employees</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.name}{member.active ? '' : ' (removed account)'}</option>)}</select></label><label><span><Activity size={13} />Module</span><select value={query.module} disabled={loading} onChange={event => filter({ module: event.target.value as TeamActivityModule })}>{TEAM_ACTIVITY_MODULES.map(module => <option key={module} value={module}>{MODULE_LABELS[module]}</option>)}</select></label><button className={styles.refresh} disabled={loading} onClick={refresh}><RefreshCw size={16} className={loading ? 'spin' : undefined} /><span>Refresh</span></button></section>
    {error && <div className={styles.error} role="alert"><CircleAlert size={18} /><div><strong>Activity could not be refreshed</strong><p>{error}</p><button disabled={loading} onClick={refresh}>Try again</button></div>{!forbidden && current && <button className={styles.dismiss} onClick={() => setError('')} aria-label="Dismiss activity error"><X size={16} /></button>}</div>}
    {forbidden ? <AccessNotice /> : <section className={styles.card}><header className={styles.cardHeader}><div><span className={styles.eyebrow}>PEOPLE · ACTIONS · ACCOUNTABILITY</span><h2 tabIndex={-1} ref={heading}>Activity history</h2><p>{current ? `${current.total.toLocaleString('en-IN')} ${current.total === 1 ? 'activity' : 'activities'} in this view` : 'Loading the selected activity history'} <span>· Newest first · IST</span></p></div><span className={styles.readOnly}><CheckCircle2 size={14} />Read-only record</span></header>
      {search.trim() && <div className={styles.searchNote}>Search is filtering this page. Use the employee, module, and month filters to narrow the full history.</div>}
      {current && current.total > 0 && <Pagination data={current} pages={pages} disabled={loading} change={page} top />}
      {!current ? <div className={styles.empty}>{loading ? <><LoaderCircle size={25} className="spin" /><h3>Bringing the history into view</h3><p>Loading the latest activity for these filters.</p></> : <><Activity size={26} /><h3>Activity is unavailable</h3><p>Refresh the view to try again.</p></>}</div> : !entries.length ? <div className={styles.empty}><span className={styles.emptyIcon}><Activity size={26} /></span><h3>{search.trim() && current.entries.length ? 'No activity matches this search' : 'No activity in this view yet'}</h3><p>{search.trim() && current.entries.length ? 'Search applies to this page. Try another search or page, or adjust the filters above.' : 'Actions recorded by your team will appear here. Select another month, employee, or module to review more history.'}</p></div> : <div className={styles.timeline}>{[...groups].map(([day, records]) => <section className={styles.dayGroup} key={day}><h3 className={styles.dayHeading}><CalendarDays size={13} />{day === todayIST(new Date(current.serverTime)) ? `Today · ${dayLabel(day)}` : dayLabel(day)}</h3><div>{records.map(entry => {
        const Icon = MODULE_ICONS[entry.module] || Activity;
        const changes = changesFor(entry, memberMap);
        const details = changes.length > 0 || !!entry.reason;
        const isExpanded = expanded === entry.id;
        const actor = entry.actorId ? memberMap.get(entry.actorId) : undefined;
        const target = subject(entry);
        return <article key={entry.id} className={`${styles.entry} ${isExpanded ? styles.expanded : ''}`}><span className={`${styles.moduleIcon} ${styles[entry.module] || ''}`}><Icon size={18} /></span><div className={styles.entryBody}><div className={styles.entryMeta}><div><strong>{entry.actorName || 'System activity'}</strong>{actor && !actor.active && <span className={styles.removed}>Removed account</span>}<span className={styles.moduleBadge}>{MODULE_LABELS[entry.module]}</span></div><time dateTime={entry.createdAt} title={`${timestamp(entry.createdAt)} IST`}>{timeLabel(entry.createdAt)}</time></div><p className={styles.description}>{entry.description || `Recorded a change in ${MODULE_LABELS[entry.module].toLocaleLowerCase()}.`}</p>{target && !entry.description.includes(target) && <p className={styles.subject}>{target}</p>}{details && <button className={styles.detailToggle} aria-expanded={isExpanded} aria-controls={`activity-detail-${entry.id}`} onClick={event => { if (isExpanded) closeDetails(); else { expandedTrigger.current = event.currentTarget; setExpanded(entry.id); } }}>{isExpanded ? 'Hide details' : entry.before ? 'View changes' : 'View recorded details'}<ChevronDown size={14} /></button>}{isExpanded && <div className={styles.details} id={`activity-detail-${entry.id}`}>
          {changes.length > 0 && <div className={styles.changeTable}><div className={styles.changeHeading}><span>Detail</span>{entry.before && <span>Before</span>}<span>{entry.before ? 'After' : 'Recorded value'}</span></div>{changes.map(change => <div className={`${styles.changeRow} ${!entry.before ? styles.created : ''}`} key={change.label}><strong>{change.label}</strong>{entry.before && <span className={styles.before}><small>Before</small>{change.before === 'Not recorded' ? '—' : change.before}</span>}{entry.before && <ArrowRight size={13} className={styles.changeArrow} />}<span className={styles.after}><small>{entry.before ? 'After' : 'Recorded value'}</small>{change.after}</span></div>)}</div>}
          {entry.reason && !changes.some(change => change.after === entry.reason) && <div className={styles.reason}><span>Reason / note</span><p>{entry.reason}</p></div>}
        </div>}</div></article>;
      })}</div></section>)}</div>}
      {current && current.total > 0 && <Pagination data={current} pages={pages} disabled={loading} change={page} />}
    </section>}
  </div>;
}

function Pagination({ data, pages, disabled, change, top = false }: { data: TeamActivityData; pages: number; disabled: boolean; change: (page: number) => void; top?: boolean }) {
  const start = data.entries.length ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = data.entries.length ? start + data.entries.length - 1 : 0;
  return <nav className={`${styles.pagination} ${top ? styles.topPagination : ''}`} aria-label={top ? 'Activity pages above history' : 'Activity pages below history'}><span>{start.toLocaleString('en-IN')}–{end.toLocaleString('en-IN')} of {data.total.toLocaleString('en-IN')}</span><div><button disabled={disabled || data.page <= 1} onClick={() => change(data.page - 1)} aria-label="Previous activity page"><ChevronLeft size={16} /><span>Previous</span></button><small>Page {data.page} of {pages}</small><button disabled={disabled || data.page >= pages} onClick={() => change(data.page + 1)} aria-label="Next activity page"><span>Next</span><ChevronRight size={16} /></button></div></nav>;
}
