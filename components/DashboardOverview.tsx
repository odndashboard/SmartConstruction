'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUpRight, Building2, CalendarCheck2, CalendarClock, CheckCircle2, ChevronRight,
  CircleAlert, ContactRound, FileText, HardHat, IndianRupee, MapPin, Package,
  ReceiptText, RefreshCw, ShieldCheck, ShoppingCart, Truck, UsersRound,
} from 'lucide-react';
import type { WorkspaceData } from '@/lib/types';
import type { OperationsData } from '@/lib/operations-types';
import { buildDashboardOverview } from '@/lib/dashboard-overview';
import { readJson, ReadTimeoutError } from '@/lib/client-read';
import styles from './DashboardOverview.module.css';

type Destination = 'leads' | 'followups' | 'quotations' | 'workorders' | 'customers' | 'stock'
  | 'attendance' | 'expenses' | 'payments' | 'team_activity' | 'settings';
type Props = {
  workspace: WorkspaceData;
  navigate: (section: Destination, filter?: string) => void;
  refreshWorkspace: (force?: boolean) => Promise<void>;
};
type ReadState = { identity: string; data: OperationsData | null; loading: boolean; error: string };
type CardProps = {
  label: string; value: string; exactValue?: string; detail: ReactNode; footer: ReactNode;
  icon: typeof Package; tone?: 'navy' | 'gold' | 'sage'; onClick: () => void;
  unavailable?: boolean; loading?: boolean; textValue?: boolean;
};

function integer(value: number) { return value.toLocaleString('en-IN'); }
function exactMoney(value: string) {
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const fraction = absolute % 100n;
  return `${amount < 0n ? '−' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}`;
}
function money(value: string) {
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount;
  const unit = absolute >= 1_000_000_000n ? 1_000_000_000n : absolute >= 10_000_000n ? 10_000_000n : null;
  if (!unit) return exactMoney(value);
  const rounded = (absolute * 100n + unit / 2n) / unit;
  const decimals = String(rounded % 100n).padStart(2, '0').replace(/0+$/, '');
  return `${amount < 0n ? '−' : ''}₹${rounded / 100n}${decimals ? `.${decimals}` : ''} ${unit === 1_000_000_000n ? 'Cr' : 'L'}`;
}
function Money({ value }: { value: string }) { return <span title={exactMoney(value)}>{money(value)}</span>; }
function duration(minutes: number) {
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${integer(hours)}h${remainder ? ` ${remainder}m` : ''}`;
}
function monthName(month: string) {
  return new Date(`${month}-01T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', month: 'long', year: 'numeric' });
}
function refreshTime(value: string) {
  return new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
}

function OverviewCard({ label, value, exactValue, detail, footer, icon: Icon, tone = 'navy', onClick, unavailable, loading, textValue }: CardProps) {
  return <button type="button" className={`${styles.card} ${styles[tone]}${unavailable ? ` ${styles.unavailable}` : ''}`}
    onClick={onClick} disabled={unavailable} aria-label={unavailable ? `${label}: ${loading ? 'loading' : 'unavailable'}` : `${label}: ${exactValue || value}. Open ${label.toLocaleLowerCase()}`}>
    <span className={styles.cardTop}><span>{label}</span><span className={styles.cardIcon}><Icon size={19} strokeWidth={1.7} /></span></span>
    <strong className={`${styles.value}${textValue ? ` ${styles.textValue}` : ''}`} title={exactValue}>{unavailable ? <span aria-hidden="true">—</span> : value}</strong>
    <span className={styles.detail}>{unavailable ? loading ? 'Loading your records…' : 'Refresh to load this module' : detail}</span>
    <span className={styles.cardBottom}><span>{unavailable ? 'Not available yet' : footer}</span><ArrowUpRight size={15} /></span>
  </button>;
}

function Shortcut({ icon: Icon, title, detail, onClick }: { icon: typeof Package; title: string; detail: string; onClick: () => void }) {
  return <button type="button" className={styles.shortcut} onClick={onClick}><Icon size={17} strokeWidth={1.7} /><span><strong>{title}</strong><small>{detail}</small></span><ChevronRight size={15} /></button>;
}

export default function DashboardOverview({ workspace, navigate, refreshWorkspace }: Props) {
  const identity = `${workspace.user.userId}:${workspace.user.role}:${workspace.user.active}`;
  const [read, setRead] = useState<ReadState>({ identity: '', data: null, loading: true, error: '' });
  const sequence = useRef(0), request = useRef<AbortController | null>(null);
  const lastRead = useRef(0), mounted = useRef(false), pending = useRef(false);
  const refreshCore = useRef(refreshWorkspace);
  useEffect(() => { refreshCore.current = refreshWorkspace; }, [refreshWorkspace]);

  const refresh = useCallback(async (includeWorkspace: boolean, forceWorkspace = true) => {
    const next = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    pending.current = true;
    setRead(current => ({ identity, data: current.identity === identity ? current.data : null, loading: true, error: '' }));
    // The workspace reports its own load errors; this timestamp applies only to operations.
    let coreRead = includeWorkspace ? refreshCore.current(forceWorkspace).catch(() => undefined) : Promise.resolve();
    try {
      const { response, body } = await readJson<OperationsData & { error?: string }>('/api/operations', { signal: controller.signal });
      if (!mounted.current || next !== sequence.current) return;
      if (!response.ok) {
        setRead({ identity, data: null, loading: true, error: response.status === 401 ? 'Please sign in again to view your overview.' : body.error || 'The operations overview could not be loaded. Please try again.' });
        if (response.status === 401 || response.status === 403) coreRead = refreshCore.current().catch(() => undefined);
        return;
      }
      if (!body.extension || body.user?.userId !== workspace.user.userId || !body.user.active) {
        setRead({ identity, data: null, loading: true, error: 'Your account details changed. Refresh the workspace to continue.' });
        coreRead = refreshCore.current().catch(() => undefined);
        return;
      }
      if (body.user.role !== workspace.user.role) {
        setRead({ identity, data: null, loading: true, error: 'Your permissions changed. Refreshing your workspace…' });
        coreRead = refreshCore.current().catch(() => undefined);
        return;
      }
      lastRead.current = Date.now();
      setRead({ identity, data: body, loading: true, error: '' });
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current || next !== sequence.current) return;
      setRead({ identity, data: null, loading: true, error: cause instanceof ReadTimeoutError ? cause.message : cause instanceof SyntaxError ? 'The server returned an incomplete overview. Please refresh.' : 'The operations overview could not be loaded. Check your connection and try again.' });
    } finally {
      await coreRead;
      if (mounted.current && next === sequence.current) {
        pending.current = false;
        setRead(current => current.identity === identity ? { ...current, loading: false } : current);
      }
    }
  }, [identity, workspace.user.userId, workspace.user.role]);

  useEffect(() => {
    mounted.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Start an authenticated asynchronous read for this identity.
    void refresh(true, false);
    const onReturn = () => {
      if (!pending.current && document.visibilityState === 'visible' && Date.now() - lastRead.current >= 30_000) void refresh(true);
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      mounted.current = false; request.current?.abort();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [refresh]);

  const current = read.identity === identity ? read.data : null;
  const loading = read.identity !== identity || read.loading;
  const summary = buildDashboardOverview(workspace, current);
  const core = summary.core, operations = summary.operations;
  const owner = operations?.owner === true;
  const ownerCard = workspace.user.role === 'OWNER';
  const unavailable = !operations;
  const expenses = operations?.expenses;
  const attendance = operations?.attendance;
  const payments = owner ? operations.payments : null;
  const summaryError = read.identity === identity && read.error ? read.error
    : current && !operations && !loading ? 'Refresh overview to sync the latest records and account access.' : '';
  const ownStatus = attendance?.ownOpenShift ? 'Shift open' : attendance?.ownStatus ? ({ PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'On leave' })[attendance.ownStatus] : 'Not recorded';
  const pendingExpensePaise = owner ? expenses?.allTimeTotals?.submittedPaise || '0' : '0';
  const alerts: { label: string; detail: string; destination: Destination; filter?: string }[] = [];
  if (core.overdueFollowups) alerts.push({ label: `${integer(core.overdueFollowups)} overdue follow-up${core.overdueFollowups === 1 ? '' : 's'}`, detail: 'Keep the next conversation moving', destination: 'followups', filter: 'overdue' });
  if (operations?.stock.lowItems.length) alerts.push({ label: `${integer(operations.stock.lowItems.length)} material${operations.stock.lowItems.length === 1 ? '' : 's'} at reorder level`, detail: 'Review remaining stock', destination: 'stock' });
  if (BigInt(pendingExpensePaise) > 0n) alerts.push({ label: `${money(pendingExpensePaise)} expenses awaiting review`, detail: 'All dates · company submissions', destination: 'expenses' });
  if (payments && BigInt(payments.overduePaise) > 0n) alerts.push({ label: `${money(payments.overduePaise)} customer payments overdue`, detail: 'Review due instalments', destination: 'payments' });
  if (owner && operations.materialRequests.submitted > 0) alerts.push({ label: `${integer(operations.materialRequests.submitted)} material request${operations.materialRequests.submitted === 1 ? '' : 's'} to review`, detail: 'Approve or reject site requests', destination: 'stock' });
  if (owner && operations.purchaseOrders?.overdue) alerts.push({ label: `${integer(operations.purchaseOrders.overdue)} purchase order${operations.purchaseOrders.overdue === 1 ? '' : 's'} overdue`, detail: 'Check outstanding deliveries', destination: 'stock' });

  const alertCoverageComplete = operations && (!owner || (expenses?.allTimeTotals && payments && operations.purchaseOrders));
  return <section className={styles.overview} aria-labelledby="dashboard-overview-title" aria-busy={loading}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>YOUR WORKSPACE AT A GLANCE</span><h2 id="dashboard-overview-title">Business overview</h2><p>{ownerCard ? 'Projects, people, materials and payments in one place.' : 'Shared project progress, with your own attendance and expenses.'}</p></div>
      <button type="button" className={styles.refresh} onClick={() => void refresh(true)} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : undefined} />{loading ? 'Refreshing' : 'Refresh overview'}</button>
    </header>
    <div className={styles.context}><span><CalendarClock size={13} />{monthName(summary.month)} <i />India Standard Time</span><small>{current && operations ? `Operations updated ${refreshTime(current.serverTime)}${loading ? ' · refreshing…' : ''}` : loading ? 'Connecting to your operations…' : 'Operations unavailable'}</small></div>
    {summaryError && <div className={styles.error} role="alert"><CircleAlert size={17} /><p>{summaryError}</p><button type="button" disabled={loading} onClick={() => void refresh(true)}>Try again <RefreshCw size={13} /></button></div>}

    <div className={styles.grid}>
      <OverviewCard label="Open leads" value={integer(core.openLeads)} icon={UsersRound} detail={<><Money value={core.pipelinePaise} /> in potential work</>} footer="Current pipeline" onClick={() => navigate('leads')} />
      <OverviewCard label="Follow-ups today" value={integer(core.followupsToday)} icon={CalendarClock} tone="gold" detail={core.overdueFollowups ? `${integer(core.overdueFollowups)} overdue follow-ups overall` : 'No overdue follow-ups'} footer="Open conversations due today" onClick={() => navigate('followups', 'today')} />
      <OverviewCard label="Pending quotations" value={integer(core.pendingQuotations)} icon={FileText} detail={<><Money value={core.pendingQuotationPaise} /> awaiting acceptance</>} footer="Issued and still valid" onClick={() => navigate('quotations', 'ISSUED')} />
      <OverviewCard label="Open work orders" value={integer(core.activeWorkOrders)} icon={HardHat} tone="sage" detail={`${integer(core.completedWorkOrders)} completed work orders`} footer="Planned, in progress and on hold" onClick={() => navigate('workorders')} />
      <OverviewCard label="Stock items" value={integer(operations?.stock.activeItems || 0)} icon={Package} tone="sage" unavailable={unavailable} loading={loading} detail={`${integer(operations?.stock.lowItems.length || 0)} at reorder level`} footer={`${integer(operations?.stock.movementCount || 0)} stock entries · ${integer(operations?.stock.transfers || 0)} transfers this month`} onClick={() => navigate('stock')} />
      <OverviewCard label={ownerCard ? 'Attendance recorded today' : 'Your attendance'} value={owner ? integer(attendance?.todayRecorded || 0) : ownStatus} icon={CalendarCheck2} unavailable={unavailable} loading={loading} textValue={!owner}
        detail={owner ? `${integer(attendance?.todayPresent || 0)} present · ${integer(attendance?.todayHalfDay || 0)} half day` : attendance?.ownOpenShift && !attendance.ownStatus ? 'A previous shift is still open' : 'Your recorded status for today'}
        footer={attendance ? `${duration(attendance.workedMinutes)} worked · ${duration(attendance.approvedOvertimeMinutes)} overtime approved this month` : ''} onClick={() => navigate('attendance')} />
      <OverviewCard label={ownerCard ? 'Expenses paid' : 'Your expenses'} value={owner ? money(expenses?.monthTotals?.paidPaise || '0') : integer(expenses?.monthCount || 0)} exactValue={owner ? exactMoney(expenses?.monthTotals?.paidPaise || '0') : undefined} icon={ReceiptText} tone="gold" unavailable={unavailable || (owner && !expenses?.monthTotals)} loading={loading}
        detail={owner ? <><Money value={expenses?.monthTotals?.submittedPaise || '0'} /> awaiting review this month</> : 'Your expense submissions this month'}
        footer={owner ? `${integer(expenses?.monthCount || 0)} company entries this month` : 'Receipts and approval status'} onClick={() => navigate('expenses')} />
      {ownerCard ? <OverviewCard label="Customer outstanding" value={money(payments?.outstandingPaise || '0')} exactValue={exactMoney(payments?.outstandingPaise || '0')} icon={IndianRupee} tone="gold" unavailable={!owner || !payments} loading={loading}
        detail={<><Money value={payments?.overduePaise || '0'} /> overdue</>} footer={<><Money value={payments?.receivedPaise || '0'} /> received · all time</>} onClick={() => navigate('payments')} />
        : <OverviewCard label="Your construction site" value={operations?.sites.ownSite?.name || 'Not assigned'} icon={MapPin} unavailable={unavailable} loading={loading} textValue detail={operations?.sites.ownSite ? 'Your current attendance location' : 'Ask your admin to assign a site'} footer={operations?.sites.shiftConfigured ? 'Shift rules configured' : 'Shift rules awaiting setup'} onClick={() => navigate('attendance')} />}
    </div>

    <div className={styles.shortcuts} aria-label="More workspace modules">
      <Shortcut icon={ContactRound} title="Customers" detail={`${integer(core.customers)} customer${core.customers === 1 ? '' : 's'}`} onClick={() => navigate('customers')} />
      {operations && <>
        <Shortcut icon={Building2} title="Construction sites" detail={`${integer(operations.sites.activeSites)} active site${operations.sites.activeSites === 1 ? '' : 's'}`} onClick={() => navigate('attendance')} />
        <Shortcut icon={Truck} title={owner ? 'Material requests' : 'Your material requests'} detail={`${integer(operations.materialRequests.open)} open request${operations.materialRequests.open === 1 ? '' : 's'}`} onClick={() => navigate('stock')} />
        {owner && <>
          {operations.purchaseOrders && <Shortcut icon={ShoppingCart} title="Purchase orders" detail={`${integer(operations.purchaseOrders.open)} awaiting delivery`} onClick={() => navigate('stock')} />}
          <Shortcut icon={ShieldCheck} title="Team activity" detail={`${integer(operations.activeTeamMembers || 0)} active team member${operations.activeTeamMembers === 1 ? '' : 's'}`} onClick={() => navigate('team_activity')} />
        </>}
      </>}
    </div>

    {alerts.length ? <div className={styles.attention}><div className={styles.attentionHeading}><span><CircleAlert size={16} />Needs attention</span><small>{alerts.length} area{alerts.length === 1 ? '' : 's'} to review</small></div><div className={styles.alerts}>{alerts.map(alert => <button type="button" key={alert.label} onClick={() => navigate(alert.destination, alert.filter)}><span><strong>{alert.label}</strong><small>{alert.detail}</small></span><ArrowUpRight size={15} /></button>)}</div></div>
      : alertCoverageComplete && <div className={styles.calm}><CheckCircle2 size={16} /><span>No overdue follow-ups, low-stock alerts{owner ? ' or pending financial reviews' : ''} in this overview.</span></div>}
    {operations && <div className={styles.scopeNote}><ShieldCheck size={13} /><span>{owner ? 'Company totals and team attendance are visible to you as Owner.' : 'Attendance and expenses above show only your records.'} Attendance is recorded only when an entry exists.</span></div>}
  </section>;
}
