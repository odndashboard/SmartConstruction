'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Archive, ArrowDownLeft, ArrowUpRight, CalendarDays, Check, CheckCircle2, ChevronDown,
  CircleAlert, Clock3, Download, IndianRupee, LoaderCircle, LogIn, LogOut, MapPin,
  Package, Pencil, Plus, ReceiptText, RefreshCw, RotateCcw, ShieldCheck, UsersRound, X,
} from 'lucide-react';
import type { Member, WorkspaceData } from '@/lib/types';
import { todayIST } from '@/lib/finance';
import { saveTextFile } from '@/lib/native-platform';
import AttendanceAdvanced from './AttendanceAdvanced';
import StockAdvanced from './StockAdvanced';
import PaymentsPanel from './PaymentsPanel';
import ExpenseReceipts from './ExpenseReceipts';
import type { ExpenseReceipt } from '@/lib/operations-extensions';
import {
  EXPENSE_CATEGORIES, type AttendanceRecord, type AttendanceStatus, type Expense,
  type ExpenseStatus, type ExpenseTotals, type OperationsAction, type OperationsData,
  type OperationsMutation, type OperationsSection, type StockItem, type StockMovementType,
} from '@/lib/operations-types';
import styles from './OperationsPanel.module.css';

type Props = { section: OperationsSection; workspace: WorkspaceData; search: string };
type Editor =
  | { kind: 'item'; item?: StockItem }
  | { kind: 'movement'; item?: StockItem }
  | { kind: 'itemAccess'; item: StockItem; active: boolean }
  | { kind: 'checkIn' }
  | { kind: 'attendance'; record?: AttendanceRecord }
  | { kind: 'expense'; expense?: Expense }
  | { kind: 'withdraw'; expense: Expense }
  | { kind: 'review'; expense: Expense; status: 'APPROVED' | 'REJECTED' | 'PAID' };
type OpenEditor = (editor: Editor) => void;
type Save = (action: OperationsAction, payload: Record<string, unknown>) => Promise<boolean>;
type CsvValue = string | number | null;
type ExportCsv = (label: string, headers: string[], rows: CsvValue[][]) => void;

const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = { PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', LEAVE: 'On leave' };
const EXPENSE_LABELS: Record<ExpenseStatus, string> = { SUBMITTED: 'Awaiting review', APPROVED: 'Approved', REJECTED: 'Rejected', PAID: 'Paid', WITHDRAWN: 'Withdrawn' };
const MOVEMENT_LABELS: Record<StockMovementType, string> = { IN: 'Stock in', OUT: 'Stock out', ADJUST: 'Adjustment' };
const SECTION_LABELS: Record<OperationsSection, string> = { stock: 'stock', attendance: 'attendance', expenses: 'expenses', payments: 'payments' };

function quantity(value: number): string {
  return (value / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
function exactQuantity(value: string | number | undefined, signed = false): string {
  if (value === undefined) return '—';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = String(absolute % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${amount < 0n ? '−' : signed && amount > 0n ? '+' : ''}${(absolute / 1000n).toLocaleString('en-IN')}${fraction ? `.${fraction}` : ''}`;
}
function exactQuantityCsv(value: string | number | undefined): string {
  if (value === undefined) return '';
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`;
}
function decimal(value: number, places: 2 | 3): string {
  const factor = 10 ** places;
  return `${Math.floor(value / factor)}.${String(value % factor).padStart(places, '0')}`;
}
/** Keep company totals exact even when the total is larger than a safe JS number. */
function money(value: number | string | bigint): string {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '−' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(absolute % 100n).padStart(2, '0')}`;
}
function dateLabel(value: string, full = false): string {
  return new Date(`${value}T12:00:00+05:30`).toLocaleDateString('en-IN', { day: 'numeric', month: full ? 'long' : 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function monthLabel(value: string): string {
  return new Date(`${value}-01T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function timeLabel(value: string | null): string {
  return value ? new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '—';
}
function dateTimeLabel(value: string): string {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function istLocal(value: string | null): string {
  return value ? new Date(new Date(value).getTime() + 330 * 60_000).toISOString().slice(0, 16) : '';
}
function isoFromIST(value: string): string | null {
  return value ? new Date(`${value}:00+05:30`).toISOString() : null;
}
function duration(record: AttendanceRecord): string {
  if (!record.checkIn || !record.checkOut) return record.checkIn ? 'Shift open' : 'No times recorded';
  const minutes = Math.max(0, Math.floor((Date.parse(record.checkOut) - Date.parse(record.checkIn)) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function matches(search: string, ...values: (string | undefined)[]): boolean {
  const needle = search.trim().toLocaleLowerCase();
  return !needle || values.some(value => value?.toLocaleLowerCase().includes(needle));
}
function textField(fields: FormData, name: string): string { return String(fields.get(name) ?? '').trim(); }
function csvCell(value: CsvValue): string {
  const raw = value === null ? '' : String(value);
  const safe = typeof value === 'string' && (/^\s*[=+\-@]/.test(raw) || /^[\t\r\n]/.test(raw)) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export default function OperationsPanel(props: Props) {
  // Navigation starts a fresh editor and request scope for the selected module.
  return <OperationsWorkspace key={props.section} {...props} />;
}

function OperationsWorkspace({ section, workspace, search }: Props) {
  const [month, setMonth] = useState(() => todayIST().slice(0, 7));
  const [data, setData] = useState<OperationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [retrySuccess, setRetrySuccess] = useState(0);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const attempt = useRef<OperationsMutation | null>(null);
  const sending = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const readSequence = useRef(0);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readController.current?.abort(); };
  }, []);

  const refresh = useCallback(() => {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const sequence = ++readSequence.current;
    return fetch(`/api/operations?month=${encodeURIComponent(month)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json() as OperationsData & { error?: string };
      if (!mounted.current || sequence !== readSequence.current) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { setData(null); setEditor(null); }
        throw new Error(result.error || 'This workspace could not be loaded. Please try again.');
      }
      setData(result);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && mounted.current && sequence === readSequence.current) {
        setError(cause instanceof Error ? cause.message : 'Check your connection and try again.');
      }
    }).finally(() => {
      if (mounted.current && sequence === readSequence.current) setLoading(false);
    });
  }, [month]);

  useEffect(() => { void refresh(); }, [refresh]);

  function reload() { setLoading(true); setError(''); void refresh(); }

  const closeEditor = useCallback(() => {
    if (busy || uncertain) return;
    setEditor(null);
    requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
  }, [busy, uncertain]);

  useEffect(() => {
    if (!editor) return;
    editorHeading.current?.focus({ preventScroll: true });
    editorHeading.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const back = (event: Event) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeEditor();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); closeEditor(); } };
    window.addEventListener('smart-construction-back', back, true);
    document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('smart-construction-back', back, true); document.removeEventListener('keydown', escape); };
  }, [editor, closeEditor]);

  const open: OpenEditor = value => {
    if (busy || receiptBusy || uncertain || loading) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setNotice(''); setEditor(value);
  };

  async function send(request: OperationsMutation): Promise<boolean> {
    if (sending.current) return false;
    const confirmingRetry = uncertain && attempt.current?.requestId === request.requestId;
    sending.current = true;
    readController.current?.abort(); ++readSequence.current;
    setLoading(false); setBusy(true); setError(''); setNotice('');
    attempt.current = request;
    try {
      const response = await fetch('/api/operations', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      });
      const result = await response.json() as { data?: OperationsData; message?: string; error?: string };
      if (!mounted.current) return false;
      if (!response.ok || !result.data) {
        if (response.status >= 500 || (response.ok && !result.data)) throw new Error('UNKNOWN_RESULT');
        attempt.current = null; setUncertain(false);
        if (response.status === 401 || response.status === 403) { setData(null); setEditor(null); }
        if (response.status === 409) {
          await refresh();
          setError('The records changed while you were working. Review the latest values, then save again.');
        } else setError(result.error || 'This change could not be saved. Check the details and try again.');
        return false;
      }
      attempt.current = null; setUncertain(false); setData(result.data); setEditor(null);
      if (confirmingRetry) setRetrySuccess(value => value + 1);
      setNotice(result.message || 'Your change has been saved.');
      requestAnimationFrame(() => returnFocus.current?.isConnected && returnFocus.current.focus());
      return true;
    } catch {
      if (mounted.current) {
        setUncertain(true);
        setError('We could not confirm whether this change was saved. Keep this page open and retry the same change to confirm its result.');
      }
      return false;
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }

  const save: Save = async (action, payload) => {
    if (!data || busy || receiptBusy || uncertain || !data.permissions.canWrite) return false;
    return send({ action, payload, expectedRevision: data.revision, requestId: crypto.randomUUID(), month });
  };
  const exportCsv: ExportCsv = (label, headers, rows) => {
    try {
      const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
      saveTextFile(`smart-construction-${label}-${month}.csv`, `\uFEFF${csv}\r\n`, 'text/csv;charset=utf-8');
    } catch { setError('The file could not be prepared. Please try again.'); }
  };
  const current = data?.month === month ? data : null;
  const blocked = busy || receiptBusy || uncertain || loading;

  return <div className={styles.workspace} aria-busy={loading || busy}>
    <div className={styles.toolbar}>
      <div className={styles.scope}><span className={styles.scopeIcon}>{section === 'stock' ? <Package size={18} /> : section === 'attendance' ? <CalendarDays size={18} /> : <ReceiptText size={18} />}</span><div><strong>{section === 'stock' ? 'Shared inventory' : section === 'attendance' ? current?.permissions.admin ? 'Your team, accounted for' : 'Your working day' : section === 'payments' ? 'Customer payment register' : current?.permissions.admin ? 'Company expense control' : 'Your expense requests'}</strong><small>{section === 'stock' ? 'Current balances · monthly movement history' : section === 'attendance' ? 'All attendance times use India Standard Time' : section === 'payments' ? 'Agreed amounts, receipts and outstanding balances · INR' : 'Amounts in INR · keep each request traceable'}</small></div></div>
      <div className={styles.toolbarActions}>{section !== 'payments' && <label className={styles.monthField}><CalendarDays size={15} /><span className={styles.srOnly}>History month</span><input type="month" value={month} min="2000-01" max={todayIST().slice(0, 7)} disabled={blocked} onChange={event => { if (event.target.value) { setEditor(null); setNotice(''); setError(''); setLoading(true); setMonth(event.target.value); } }} /></label>}<button className={styles.iconButton} type="button" aria-label={`Refresh ${SECTION_LABELS[section]}`} title="Refresh" disabled={blocked} onClick={reload}><RefreshCw size={17} className={loading ? 'spin' : undefined} /></button></div>
    </div>
    {error && <div className={`${styles.alert} ${styles.error}`} role="alert"><CircleAlert size={18} /><div><strong>{uncertain ? 'Confirm your last change' : 'Something needs your attention'}</strong><p>{error}</p>{uncertain && <button className="button button-secondary button-small" disabled={busy} onClick={() => { if (attempt.current && !busy) void send(attempt.current); }}>{busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}Retry the same change</button>}{!uncertain && !current && <button className="button button-secondary button-small" disabled={loading} onClick={reload}>Try again</button>}</div>{!uncertain && current && <button className={styles.iconButton} aria-label="Dismiss message" onClick={() => setError('')}><X size={16} /></button>}</div>}
    {notice && <div className={`${styles.alert} ${styles.success}`} role="status"><CheckCircle2 size={18} /><p>{notice}</p><button className={styles.iconButton} aria-label="Dismiss confirmation" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {!current ? <div className={styles.loading}>{loading ? <><LoaderCircle size={23} className="spin" /><h3>Opening your {SECTION_LABELS[section]}</h3><p>Bringing the latest records into view.</p></> : <><CircleAlert size={24} /><h3>Records are unavailable</h3><p>Refresh this page to reconnect to your workspace.</p></>}</div> : <>
      {!current.permissions.canWrite && <div className={styles.readOnly}><ShieldCheck size={15} />Your account has view-only access. An administrator can update your permissions.</div>}
      {editor && <section className={styles.editor} aria-label="Edit record"><div className={styles.editorTop}><div><span className={styles.eyebrow}>KEEP THE DETAILS CLEAR</span><h2 tabIndex={-1} ref={editorHeading}>{editorTitle(editor)}</h2></div><button className={styles.iconButton} aria-label="Close form" disabled={busy || uncertain} onClick={closeEditor}><X size={19} /></button></div><RecordEditor key={editorKey(editor)} editor={editor} data={current} members={workspace.members} disabled={blocked} save={save} close={closeEditor} reportError={setError} /></section>}
      {section === 'stock' && <><StockSection data={current} search={search} blocked={blocked} open={open} exportCsv={exportCsv} /><StockAdvanced key={retrySuccess} workspace={workspace} data={current} blocked={blocked || !!editor} save={save} /></>}
      {section === 'attendance' && <AttendanceSection data={current} workspace={workspace} members={workspace.members} search={search} blocked={blocked} open={open} save={save} exportCsv={exportCsv} editorOpen={!!editor} retrySuccess={retrySuccess} />}
      {section === 'expenses' && <ExpensesSection data={current} search={search} blocked={blocked} open={open} exportCsv={exportCsv} onReceiptBusy={setReceiptBusy} onReceiptsChanged={refresh} />}
      {section === 'payments' && <PaymentsPanel key={retrySuccess} workspace={workspace} data={current} blocked={blocked} save={save} />}
    </>}
  </div>;
}

function Stat({ label, value, hint, icon: Icon = Package, tone = 'navy' }: { label: string; value: string; hint: string; icon?: typeof Package; tone?: 'navy' | 'gold' | 'sage' }) {
  return <article className={styles.stat}><div><span>{label}</span><span className={`${styles.statIcon} ${styles[tone]}`}><Icon size={18} /></span></div><strong>{value}</strong><small>{hint}</small></article>;
}
function Empty({ icon: Icon, title, children }: { icon: typeof Package; title: string; children: ReactNode }) {
  return <div className={styles.empty}><span><Icon size={26} strokeWidth={1.6} /></span><h3>{title}</h3><p>{children}</p></div>;
}
function Badge({ value, children }: { value: string; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[`status${value}`] || ''}`}><i />{children}</span>;
}
function CsvButton({ onClick, disabled = false, label = 'Export CSV' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return <button type="button" className={`button button-secondary button-small ${styles.csvButton}`} onClick={onClick} disabled={disabled}><Download size={15} />{label}</button>;
}
function HistoryLimit({ count, loaded, limit }: { count: number; loaded: number; limit: number }) {
  if (count <= loaded) return null;
  return <div className={styles.historyNotice}><CircleAlert size={17} /><div><strong>Showing the latest {Math.min(loaded, limit).toLocaleString('en-IN')} of {count.toLocaleString('en-IN')} records this month.</strong><p>CSV includes the rows shown here. Choose a different month to view its history, or <a href="/api/export">download all records you can access</a> as a complete workspace file.</p></div></div>;
}

function StockBalances({ item }: { item: StockItem }) {
  const adjusted = item.adjustedMilli !== undefined && BigInt(item.adjustedMilli) !== 0n;
  return <div className={styles.stockTotals}>
    <div><small>Received</small><strong>{exactQuantity(item.receivedMilli)}</strong><span>{item.unit} · all time</span></div>
    <div><small>Used</small><strong>{exactQuantity(item.usedMilli)}</strong><span>{item.unit} · net of returns</span></div>
    <div className={styles.remaining}><small>Remaining</small><strong>{exactQuantity(item.quantityMilli)}</strong><span>{item.unit} · min {quantity(item.minQuantityMilli)}</span></div>
    {!!item.returnedMilli && BigInt(item.returnedMilli) > 0n && <p className={styles.adjustmentNote}><RotateCcw size={12} /><span>Returned unused: <b>{exactQuantity(item.returnedMilli)} {item.unit}</b>, already deducted from used.</span></p>}
    {adjusted && <p className={styles.adjustmentNote}><RefreshCw size={12} /><span>Adjustments: <b>{exactQuantity(item.adjustedMilli, true)} {item.unit}</b>. Remaining = received − used + adjustments.</span></p>}
  </div>;
}

function StockSection({ data, search, blocked, open, exportCsv }: { data: OperationsData; search: string; blocked: boolean; open: OpenEditor; exportCsv: ExportCsv }) {
  const [inventoryFilter, setInventoryFilter] = useState('active');
  const [movementFilter, setMovementFilter] = useState('ALL');
  const active = data.stockItems.filter(item => item.active);
  const low = active.filter(item => item.quantityMilli <= item.minQuantityMilli);
  const items = data.stockItems.filter(item => matches(search, item.name, item.sku, item.location, item.unit)
    && (inventoryFilter === 'all' || inventoryFilter === 'archived' ? inventoryFilter === 'all' || !item.active : item.active)
    && (inventoryFilter !== 'low' || item.quantityMilli <= item.minQuantityMilli));
  const byId = new Map(data.stockItems.map(item => [item.id, item]));
  const movements = data.stockMovements.filter(move => (movementFilter === 'ALL' || move.type === movementFilter)
    && matches(search, byId.get(move.itemId)?.name, byId.get(move.itemId)?.sku, move.actorName, move.note, move.reference));
  return <>
    <div className={styles.stats}><Stat label="Active stock items" value={String(active.length)} hint="Materials available to your team" /><Stat label="At reorder level" value={String(low.length)} hint="At or below the minimum balance" icon={CircleAlert} tone="gold" /><Stat label="Movements this month" value={data.counts.stockMovements.toLocaleString('en-IN')} hint={monthLabel(data.month)} icon={ArrowUpRight} tone="sage" /></div>
    <section className={styles.card}><div className={styles.cardHeader}><div><span className={styles.eyebrow}>MATERIALS &amp; SUPPLIES</span><h2>Stock on hand</h2><p>Company totals across all locations. Used excludes unused material returned; remaining is the current balance.</p></div><div className={styles.actions}>{data.permissions.canWrite && <><button className="button button-secondary button-small" disabled={blocked || !active.length} onClick={() => open({ kind: 'movement' })}><ArrowDownLeft size={15} />Record movement</button><button className="button button-primary button-small" disabled={blocked} onClick={() => open({ kind: 'item' })}><Plus size={16} />Add item</button></>}</div></div>
      <div className={styles.filterBar}><div className={styles.segmented} aria-label="Inventory filter">{[['active', 'Active'], ['low', 'Low stock'], ['archived', 'Archived'], ['all', 'All items']].map(([value, label]) => <button key={value} aria-pressed={inventoryFilter === value} onClick={() => setInventoryFilter(value)}>{label}</button>)}</div><CsvButton disabled={!items.length} onClick={() => exportCsv('stock', ['SKU', 'Item', 'Unit', 'Storage note', 'Received (all time)', 'Used (net of returns)', 'Returned unused', 'Adjustments (all time)', 'Remaining', 'Minimum quantity', 'Status'], items.map(item => [item.sku, item.name, item.unit, item.location, exactQuantityCsv(item.receivedMilli), exactQuantityCsv(item.usedMilli), exactQuantityCsv(item.returnedMilli || '0'), exactQuantityCsv(item.adjustedMilli), exactQuantityCsv(item.quantityMilli), decimal(item.minQuantityMilli, 3), item.active ? 'Active' : 'Archived']))} /></div>
      {items.length ? <div className={styles.stockList}>{items.map(item => <article className={styles.stockRow} key={item.id}><span className={styles.itemIcon}><Package size={20} /></span><div className={styles.identity}><strong>{item.name}</strong><small>{item.sku} · {item.unit}</small>{item.location && <span><MapPin size={12} />{item.location}</span>}</div><StockBalances item={item} /><div className={styles.stockState}><Badge value={!item.active ? 'WITHDRAWN' : item.quantityMilli <= item.minQuantityMilli ? 'LOW' : 'PRESENT'}>{!item.active ? 'Archived' : item.quantityMilli <= item.minQuantityMilli ? 'Reorder level' : 'In stock'}</Badge></div><div className={styles.rowActions}>{item.active && data.permissions.canWrite && <button className="button button-secondary button-small" disabled={blocked} onClick={() => open({ kind: 'movement', item })}>In / out</button>}{data.permissions.admin && <>{item.active && <button className={styles.iconButton} disabled={blocked} aria-label={`Edit ${item.name}`} title="Edit item" onClick={() => open({ kind: 'item', item })}><Pencil size={16} /></button>}<button className={styles.iconButton} disabled={blocked || (item.active && item.quantityMilli !== 0)} aria-label={`${item.active ? 'Archive' : 'Restore'} ${item.name}`} title={item.active && item.quantityMilli !== 0 ? 'Use or adjust the remaining stock before archiving' : item.active ? 'Archive empty item' : 'Restore item'} onClick={() => open({ kind: 'itemAccess', item, active: !item.active })}>{item.active ? <Archive size={16} /> : <RotateCcw size={16} />}</button></>}</div></article>)}</div> : <Empty icon={Package} title={data.stockItems.length ? 'No items match this view' : 'A clear view of every material'}>{data.stockItems.length ? 'Change your search or inventory filter to see more items.' : 'Add your first stock item with its unit and opening balance. Your team can then record materials received and used.'}</Empty>}
    </section>
    <section className={styles.card}><div className={styles.cardHeader}><div><span className={styles.eyebrow}>{monthLabel(data.month)}</span><h2>Movement history</h2><p>A record of what came in, went out, or was corrected.</p></div><CsvButton disabled={!movements.length} onClick={() => exportCsv('stock-movements', ['Date and time (IST)', 'SKU', 'Item', 'Movement', 'Location', 'Change in quantity', 'Company balance after', 'Unit', 'Recorded by', 'Reference', 'Note'], movements.map(move => [dateTimeLabel(move.createdAt), byId.get(move.itemId)?.sku || '', byId.get(move.itemId)?.name || 'Stock item', move.kind === 'RETURN' ? 'Unused material returned' : MOVEMENT_LABELS[move.type], data.extension.sites.find(site => site.id === move.siteId)?.name || '', `${move.deltaMilli < 0 ? '-' : ''}${decimal(Math.abs(move.deltaMilli), 3)}`, decimal(move.balanceAfterMilli, 3), byId.get(move.itemId)?.unit || '', move.actorName, move.reference, move.note]))} /></div>
      <div className={styles.filterBar}><label className={styles.compactField}><span>Movement</span><select value={movementFilter} onChange={event => setMovementFilter(event.target.value)}><option value="ALL">All movements</option><option value="IN">Stock in</option><option value="OUT">Stock out</option><option value="ADJUST">Adjustments</option></select></label><span className={styles.resultCount}>{movements.length} shown</span></div>
      {movements.length ? <div className={styles.ledger}>{movements.map(move => <article key={move.id} className={styles.ledgerRow}><span className={`${styles.movementIcon} ${move.deltaMilli < 0 ? styles.outgoing : styles.incoming}`}>{move.type === 'ADJUST' ? <RefreshCw size={17} /> : move.type === 'IN' ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span><div className={styles.identity}><strong>{byId.get(move.itemId)?.name || 'Stock item'}</strong><small>{(move.kind === 'RETURN' ? 'Unused material returned' : MOVEMENT_LABELS[move.type])} · {move.actorName}</small><small>{dateTimeLabel(move.createdAt)} IST{move.siteId ? ` · ${data.extension.sites.find(site => site.id === move.siteId)?.name || 'Recorded location'}` : ''}</small>{(move.note || move.reference) && <details className={styles.inlineDetails}><summary>Movement details <ChevronDown size={12} /></summary>{move.reference && <p><b>Reference:</b> {move.reference}</p>}{move.note && <p>{move.note}</p>}</details>}</div><div className={styles.ledgerAmount}><strong className={move.deltaMilli < 0 ? styles.negative : styles.positive}>{move.deltaMilli > 0 ? '+' : move.deltaMilli < 0 ? '−' : ''}{quantity(Math.abs(move.deltaMilli))} <small>{byId.get(move.itemId)?.unit}</small></strong><small>Company balance {quantity(move.balanceAfterMilli)}</small></div></article>)}</div> : <Empty icon={ArrowDownLeft} title="No movements in this view">Recorded stock activity will appear here for {monthLabel(data.month).toLocaleLowerCase()}. Check the month, filter, or search if you expected a record.</Empty>}
      <HistoryLimit count={data.counts.stockMovements} loaded={data.stockMovements.length} limit={data.historyLimit} />
    </section>
  </>;
}

function AttendanceSection({ data, workspace, members, search, blocked, open, save, exportCsv, editorOpen, retrySuccess }: { data: OperationsData; workspace: WorkspaceData; members: Member[]; search: string; blocked: boolean; open: OpenEditor; save: Save; exportCsv: ExportCsv; editorOpen: boolean; retrySuccess: number }) {
  const [status, setStatus] = useState('ALL');
  const [member, setMember] = useState('ALL');
  const own = data.myOpenAttendance || data.myTodayAttendance;
  const records = data.attendance.filter(record => (data.permissions.admin || record.userId === data.user.userId)
    && (status === 'ALL' || status === record.status) && (member === 'ALL' || member === record.userId)
    && matches(search, record.memberName, record.site, record.notes, ATTENDANCE_LABELS[record.status], record.workDate));
  return <>
    <section className={styles.attendanceToday}><div className={styles.todayIntro}><span className={styles.todayIcon}><Clock3 size={25} /></span><div><span className={styles.eyebrow}>YOUR ATTENDANCE · {dateLabel(data.today)}</span><h2>{data.myOpenAttendance ? 'You’re checked in.' : own ? 'Your attendance is recorded.' : 'Ready for the working day?'}</h2><p>{data.myOpenAttendance && data.myOpenAttendance.workDate !== data.today ? `Your shift from ${dateLabel(data.myOpenAttendance.workDate)} is still open. Check out to finish it.` : own ? `${ATTENDANCE_LABELS[own.status]}${own.site ? ` · ${own.site}` : ''}` : 'Check in when you start and check out when your shift is complete.'}</p></div></div><div className={styles.todayTimes}><div><small>Check-in</small><strong>{timeLabel(own?.checkIn || null)}</strong></div><span /><div><small>Check-out</small><strong>{timeLabel(own?.checkOut || null)}</strong></div></div>{data.permissions.canWrite && <div className={styles.todayAction}>{data.myOpenAttendance ? <button className="button button-primary" disabled={blocked} onClick={() => void save('attendance_check_out', {})}><LogOut size={17} />Check out</button> : !data.myTodayAttendance ? <button className="button button-primary" disabled={blocked} onClick={() => open({ kind: 'checkIn' })}><LogIn size={17} />Check in</button> : <span className={styles.todayComplete}><CheckCircle2 size={18} />Recorded for today</span>}</div>}</section>
    <AttendanceAdvanced key={retrySuccess} workspace={workspace} data={data} blocked={blocked || editorOpen} save={save} />
    <section className={styles.card}><div className={styles.cardHeader}><div><span className={styles.eyebrow}>{monthLabel(data.month)}</span><h2>{data.permissions.admin ? 'Team attendance' : 'Your attendance history'}</h2><p>{data.permissions.admin ? 'Review each working day and make a correction with a clear reason.' : 'Your own attendance records, with times shown in IST.'}</p></div><div className={styles.actions}><CsvButton disabled={!records.length} onClick={() => exportCsv('attendance', ['Work date', 'Employee', 'Status', 'Check-in (IST)', 'Check-out (IST)', 'Recorded duration', 'Site', 'Notes', 'Recorded by'], records.map(record => [record.workDate, record.memberName, ATTENDANCE_LABELS[record.status], record.checkIn ? dateTimeLabel(record.checkIn) : '', record.checkOut ? dateTimeLabel(record.checkOut) : '', duration(record), record.site, record.notes, record.source === 'ADMIN' ? 'Administrator' : 'Employee']))} />{data.permissions.admin && <button className="button button-primary button-small" disabled={blocked} onClick={() => open({ kind: 'attendance' })}><Plus size={16} />Mark attendance</button>}</div></div>
      <div className={styles.filterBar}><div className={styles.filters}><label className={styles.compactField}><span>Status</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="ALL">All statuses</option>{Object.entries(ATTENDANCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{data.permissions.admin && <label className={styles.compactField}><span>Employee</span><select value={member} onChange={event => setMember(event.target.value)}><option value="ALL">All employees</option>{members.map(person => <option key={person.userId} value={person.userId}>{person.name}{!person.active ? ' (removed)' : ''}</option>)}</select></label>}</div><span className={styles.resultCount}>{records.length} shown · {data.counts.attendance.toLocaleString('en-IN')} this month</span></div>
      {records.length ? <div className={styles.recordList}>{records.map(record => <article key={record.id} className={styles.attendanceRow}><div className={styles.dateTile}><strong>{Number(record.workDate.slice(8))}</strong><span>{new Date(`${record.workDate}T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' })}</span></div><div className={styles.identity}><strong>{data.permissions.admin ? record.memberName : new Date(`${record.workDate}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' })}</strong><small>{record.site || 'No site recorded'}</small><small>{record.source === 'ADMIN' ? 'Recorded by administrator' : 'Self check-in'}</small>{record.notes && <details className={styles.inlineDetails}><summary>Notes <ChevronDown size={12} /></summary><p>{record.notes}</p></details>}</div><div className={styles.attendanceTimes}><strong>{timeLabel(record.checkIn)} <span>→</span> {timeLabel(record.checkOut)}</strong><small>{duration(record)}{record.checkOut && todayIST(new Date(record.checkOut)) !== record.workDate ? ` · checked out ${dateLabel(todayIST(new Date(record.checkOut)))}` : ''}</small></div><div className={styles.attendanceStatus}><Badge value={record.status}>{ATTENDANCE_LABELS[record.status]}</Badge></div>{data.permissions.admin && <button className={styles.iconButton} disabled={blocked} aria-label={`Correct ${record.memberName}'s attendance on ${dateLabel(record.workDate)}`} title="Correct attendance" onClick={() => open({ kind: 'attendance', record })}><Pencil size={16} /></button>}</article>)}</div> : <Empty icon={CalendarDays} title="No attendance in this view">{search || status !== 'ALL' || member !== 'ALL' ? 'Try a different search or filter.' : 'Check-ins and recorded attendance will appear here. Choose a month to review its working days.'}</Empty>}
      <HistoryLimit count={data.counts.attendance} loaded={data.attendance.length} limit={data.historyLimit} />
    </section>
  </>;
}

function ExpensesSection({ data, search, blocked, open, exportCsv, onReceiptBusy, onReceiptsChanged }: { data: OperationsData; search: string; blocked: boolean; open: OpenEditor; exportCsv: ExportCsv; onReceiptBusy: (busy: boolean) => void; onReceiptsChanged: () => Promise<void> }) {
  const [status, setStatus] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [summaryPeriod, setSummaryPeriod] = useState<'month' | 'allTime'>('month');
  const scoped = data.expenses.filter(expense => data.permissions.admin || expense.userId === data.user.userId);
  const records = scoped.filter(expense => (status === 'ALL' || expense.status === status) && (category === 'ALL' || expense.category === category)
    && matches(search, expense.title, expense.memberName, expense.site, expense.reference, expense.notes, expense.category));
  const personalTotal = (state: ExpenseStatus) => scoped.filter(expense => expense.userId === data.user.userId && expense.status === state).reduce((total, expense) => total + BigInt(expense.amountPaise), 0n);
  return <>
    {data.permissions.admin && data.expenseSummary ? <section className={styles.companySummary}><div className={styles.summaryHeading}><div><span className={styles.eyebrow}><ShieldCheck size={12} /> ADMINISTRATOR OVERVIEW</span><h2>Company expenses</h2><p>{summaryPeriod === 'month' ? monthLabel(data.month) : 'Across all recorded months'} · totals include every record in this period.</p></div><div className={styles.segmented} aria-label="Company expense summary period"><button aria-pressed={summaryPeriod === 'month'} onClick={() => setSummaryPeriod('month')}>Selected month</button><button aria-pressed={summaryPeriod === 'allTime'} onClick={() => setSummaryPeriod('allTime')}>All time</button></div></div><CompanyExpenseTotals totals={data.expenseSummary[summaryPeriod]} /></section> : <><div className={styles.personalNote}><ShieldCheck size={16} /><p>You can view your own expense requests. Your administrator reviews submissions and handles payments.</p></div><div className={styles.stats}><Stat label="Your pending requests" value={money(personalTotal('SUBMITTED'))} hint="Awaiting administrator review" icon={ReceiptText} tone="gold" /><Stat label="Your approved expenses" value={money(personalTotal('APPROVED'))} hint="Approved and awaiting payment" icon={CheckCircle2} /><Stat label="Your paid expenses" value={money(personalTotal('PAID'))} hint="Payment recorded by administrator" icon={IndianRupee} tone="sage" /></div>{data.counts.expenses > scoped.length && <p className={styles.subtleNote}>Your summary covers the latest {scoped.length} entries loaded for this month.</p>}</>}
    <section className={styles.card}><div className={styles.cardHeader}><div><span className={styles.eyebrow}>{monthLabel(data.month)}</span><h2>{data.permissions.admin ? 'Expense register' : 'Your expense requests'}</h2><p>{data.permissions.admin ? 'Review submissions, record decisions, and keep payment status clear.' : 'Record what you paid for, the amount, and a bill or payment reference.'}</p></div><div className={styles.actions}><CsvButton disabled={!records.length} onClick={() => exportCsv('expenses', ['Expense date', 'Employee', 'Title', 'Category', 'Amount (INR)', 'Site', 'Bill or reference', 'Status', 'Notes', 'Review note', 'Reviewed at (IST)'], records.map(expense => [expense.expenseDate, expense.memberName, expense.title, expense.category, decimal(expense.amountPaise, 2), expense.site, expense.reference, EXPENSE_LABELS[expense.status], expense.notes, expense.reviewNote, expense.reviewedAt ? dateTimeLabel(expense.reviewedAt) : '']))} />{data.permissions.canWrite && <button className="button button-primary button-small" disabled={blocked} onClick={() => open({ kind: 'expense' })}><Plus size={16} />Add expense</button>}</div></div>
      <div className={styles.filterBar}><div className={styles.filters}><label className={styles.compactField}><span>Status</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="ALL">All statuses</option>{Object.entries(EXPENSE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.compactField}><span>Category</span><select value={category} onChange={event => setCategory(event.target.value)}><option value="ALL">All categories</option>{EXPENSE_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select></label></div><span className={styles.resultCount}>{records.length} shown · {data.counts.expenses.toLocaleString('en-IN')} this month</span></div>
      {records.length ? <div className={styles.expenseList}>{records.map(expense => <ExpenseRow key={expense.id} expense={expense} userId={data.user.userId} admin={data.permissions.admin} canWrite={data.permissions.canWrite} blocked={blocked} open={open} receipts={data.extension.expenseReceipts.filter(receipt => receipt.expenseId === expense.id)} onReceiptBusy={onReceiptBusy} onReceiptsChanged={onReceiptsChanged} />)}</div> : <Empty icon={ReceiptText} title={scoped.length ? 'No expenses match this view' : 'Keep every expense accounted for'}>{scoped.length ? 'Change your status, category, or search to see more requests.' : data.permissions.canWrite ? 'Add the first expense for this month with its amount and reference. Each request keeps a clear review and payment status.' : 'Expense records will appear here when they are available for your account.'}</Empty>}
      <HistoryLimit count={data.counts.expenses} loaded={scoped.length} limit={data.historyLimit} />
    </section>
  </>;
}

function CompanyExpenseTotals({ totals }: { totals: ExpenseTotals }) {
  return <><div className={`${styles.stats} ${styles.fourStats}`}><Stat label="Awaiting review" value={money(totals.submittedPaise)} hint="Submitted expense requests" icon={ReceiptText} tone="gold" /><Stat label="Approved, unpaid" value={money(totals.approvedPaise)} hint="Ready for payment" icon={CheckCircle2} /><Stat label="Paid" value={money(totals.paidPaise)} hint="Payments recorded" icon={IndianRupee} tone="sage" /><Stat label="Recorded entries" value={totals.count.toLocaleString('en-IN')} hint="Across all expense statuses" icon={UsersRound} /></div><div className={styles.summaryFoot}><span>Rejected <strong>{money(totals.rejectedPaise)}</strong></span><span>Withdrawn <strong>{money(totals.withdrawnPaise)}</strong></span></div></>;
}

function ExpenseRow({ expense, userId, admin, canWrite, blocked, open, receipts, onReceiptBusy, onReceiptsChanged }: { expense: Expense; userId: string; admin: boolean; canWrite: boolean; blocked: boolean; open: OpenEditor; receipts: ExpenseReceipt[]; onReceiptBusy: (busy: boolean) => void; onReceiptsChanged: () => Promise<void> }) {
  const editable = canWrite && expense.userId === userId && ['SUBMITTED', 'REJECTED'].includes(expense.status);
  return <article className={styles.expenseRow}><div className={styles.expenseTop}><span className={styles.expenseIcon}><ReceiptText size={20} /></span><div className={styles.identity}><strong>{expense.title}</strong><small>{expense.category} · {dateLabel(expense.expenseDate)}{admin ? ` · ${expense.memberName}` : ''}</small>{expense.site && <span><MapPin size={12} />{expense.site}</span>}</div><div className={styles.expenseAmount}><strong>{money(expense.amountPaise)}</strong><Badge value={expense.status}>{EXPENSE_LABELS[expense.status]}</Badge></div></div><div className={styles.expenseBottom}><details className={styles.inlineDetails}><summary>View details <ChevronDown size={13} /></summary><dl className={styles.expenseDetails}><div><dt>Submitted by</dt><dd>{expense.memberName}</dd></div><div><dt>Bill / payment reference</dt><dd>{expense.reference || 'Not entered'}</dd></div><div><dt>Notes</dt><dd>{expense.notes || 'No additional notes'}</dd></div>{expense.reviewNote && <div><dt>Review note</dt><dd>{expense.reviewNote}</dd></div>}{expense.reviewedAt && <div><dt>Last review</dt><dd>{dateTimeLabel(expense.reviewedAt)} IST</dd></div>}</dl></details><div className={styles.actions}>{editable && <><button className={styles.textButton} disabled={blocked} onClick={() => open({ kind: 'expense', expense })}><Pencil size={14} />{expense.status === 'REJECTED' ? 'Edit & resubmit' : 'Edit'}</button><button className={`${styles.textButton} ${styles.negative}`} disabled={blocked} onClick={() => open({ kind: 'withdraw', expense })}>Withdraw</button></>}{admin && expense.status === 'SUBMITTED' && <><button className="button button-secondary button-small" disabled={blocked} onClick={() => open({ kind: 'review', expense, status: 'REJECTED' })}>Reject</button><button className="button button-primary button-small" disabled={blocked} onClick={() => open({ kind: 'review', expense, status: 'APPROVED' })}><Check size={15} />Approve</button></>}{admin && expense.status === 'APPROVED' && <button className="button button-primary button-small" disabled={blocked} onClick={() => open({ kind: 'review', expense, status: 'PAID' })}><IndianRupee size={15} />Mark paid</button>}</div></div>{expense.status === 'REJECTED' && expense.reviewNote && <div className={styles.reviewNote}><CircleAlert size={14} /><p>{expense.reviewNote}</p></div>}<ExpenseReceipts expense={expense} receipts={receipts} canEdit={editable} disabled={blocked} onBusyChange={onReceiptBusy} onChanged={onReceiptsChanged} /></article>;
}

function editorTitle(editor: Editor): string {
  switch (editor.kind) {
    case 'item': return editor.item ? 'Edit stock item' : 'Add a stock item';
    case 'movement': return 'Record a stock movement';
    case 'itemAccess': return editor.active ? 'Restore stock item' : 'Archive stock item';
    case 'checkIn': return 'Start your working day';
    case 'attendance': return editor.record ? 'Correct attendance' : 'Mark attendance';
    case 'expense': return editor.expense ? editor.expense.status === 'REJECTED' ? 'Edit and resubmit expense' : 'Edit your expense' : 'Submit an expense';
    case 'withdraw': return 'Withdraw your expense';
    case 'review': return editor.status === 'APPROVED' ? 'Approve expense' : editor.status === 'REJECTED' ? 'Reject expense' : 'Record expense payment';
  }
}
function editorKey(editor: Editor): string {
  if ('expense' in editor) return `${editor.kind}-${editor.expense?.id || 'new'}-${'status' in editor ? editor.status : ''}`;
  if ('item' in editor) return `${editor.kind}-${editor.item?.id || 'new'}`;
  return editor.kind === 'attendance' ? `attendance-${editor.record?.id || 'new'}` : editor.kind;
}
function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function FormFooter({ disabled, close, label, danger = false }: { disabled: boolean; close: () => void; label: string; danger?: boolean }) {
  return <div className={styles.formFooter}><button type="button" className="button button-secondary" disabled={disabled} onClick={close}>Cancel</button><button type="submit" className={`button ${danger ? 'button-danger' : 'button-primary'}`} disabled={disabled}>{disabled ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{label}</button></div>;
}
type EditorProps = { editor: Editor; data: OperationsData; members: Member[]; disabled: boolean; save: Save; close: () => void; reportError: (message: string) => void };
function RecordEditor(props: EditorProps) {
  const { editor, data, disabled, save, close } = props;
  if (editor.kind === 'item') return <ItemForm item={editor.item} disabled={disabled} save={save} close={close} />;
  if (editor.kind === 'movement') return <MovementForm item={editor.item} data={data} disabled={disabled} save={save} close={close} />;
  if (editor.kind === 'attendance') return <AttendanceForm {...props} record={editor.record} />;
  if (editor.kind === 'expense') return <ExpenseForm expense={editor.expense} today={data.today} disabled={disabled} save={save} close={close} />;
  if (editor.kind === 'checkIn') return <CheckInForm data={data} disabled={disabled} save={save} close={close} />;
  if (editor.kind === 'itemAccess') return <form onSubmit={event => { event.preventDefault(); void save('stock_item_active', { id: editor.item.id, active: editor.active }); }}><div className={styles.confirmation}><Package size={28} /><h3>{editor.item.name}</h3><p>{editor.active ? 'Restore this item so your team can record new stock movements. Its existing history stays available.' : 'Archive this empty stock item to remove it from active inventory. Its movement history stays available and an administrator can restore it later.'}</p><small>{editor.item.sku} · Current balance {quantity(editor.item.quantityMilli)} {editor.item.unit}</small></div><FormFooter disabled={disabled} close={close} label={editor.active ? 'Restore item' : 'Archive item'} /></form>;
  if (editor.kind === 'withdraw') return <form onSubmit={event => { event.preventDefault(); void save('expense_withdraw', { id: editor.expense.id }); }}><div className={styles.confirmation}><ReceiptText size={28} /><h3>{editor.expense.title}</h3><strong>{money(editor.expense.amountPaise)}</strong><p>This request will be marked withdrawn and remain in your history. A withdrawn request cannot be edited or submitted again.</p></div><FormFooter disabled={disabled} close={close} label="Withdraw expense" danger /></form>;
  return <form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); void save('expense_review', { id: editor.expense.id, status: editor.status, note: textField(fields, 'note') }); }}><div className={styles.reviewContext}><ReceiptText size={22} /><div><strong>{editor.expense.title}</strong><p>{editor.expense.memberName} · {dateLabel(editor.expense.expenseDate)}</p></div><b>{money(editor.expense.amountPaise)}</b></div><p className={styles.formIntro}>{editor.status === 'PAID' ? 'Record this payment after it has been completed. The expense will be marked paid and can no longer be changed.' : editor.status === 'REJECTED' ? 'Explain what needs to change. The employee can edit this request and submit it for review again.' : 'Confirm that this request is approved. You can mark it paid after completing the payment.'}</p><fieldset disabled={disabled}><Field label={editor.status === 'REJECTED' ? 'Reason for rejection *' : editor.status === 'PAID' ? 'Payment reference / note' : 'Review note'}><textarea name="note" maxLength={2000} required={editor.status === 'REJECTED'} rows={3} placeholder={editor.status === 'PAID' ? 'Payment date, transfer reference, or other useful details' : 'Add a clear note for this employee'} /></Field></fieldset><FormFooter disabled={disabled} close={close} label={editor.status === 'APPROVED' ? 'Approve expense' : editor.status === 'REJECTED' ? 'Reject expense' : 'Confirm payment recorded'} danger={editor.status === 'REJECTED'} /></form>;
}

function CheckInForm({ data, disabled, save, close }: { data: OperationsData; disabled: boolean; save: Save; close: () => void }) {
  const assignedId = data.extension.assignments.find(assignment => assignment.userId === data.user.userId)?.siteId;
  const sites = data.extension.sites.filter(site => site.active && site.kind === 'SITE' && (data.permissions.admin || site.id === assignedId));
  const missingAssignment = !data.permissions.admin && !sites.length;
  return <form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); if (!missingAssignment) void save('attendance_check_in', { siteId: textField(fields, 'siteId') || null, notes: textField(fields, 'notes') }); }}>
    <p className={styles.formIntro}>Your check-in time is recorded automatically in India Standard Time. Your current site and shift rules are saved with this working day.</p>
    {missingAssignment && <p className={styles.reviewNote}>Your Owner needs to assign you to an active construction site before you can check in.</p>}
    <fieldset disabled={disabled || missingAssignment}><div className={styles.formGrid}><Field label="Assigned construction site"><select name="siteId" required={!data.permissions.admin} defaultValue={assignedId || ''}>{data.permissions.admin && <option value="">Office / no construction site</option>}{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field><Field label="Notes" wide><textarea name="notes" maxLength={2000} rows={3} placeholder="Optional details for this working day" /></Field></div></fieldset>
    <FormFooter disabled={disabled || missingAssignment} close={close} label="Check in now" />
  </form>;
}

function ItemForm({ item, disabled, save, close }: { item?: StockItem; disabled: boolean; save: Save; close: () => void }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    void save('stock_item_save', { ...(item ? { id: item.id } : {}), sku: textField(fields, 'sku'), name: textField(fields, 'name'), unit: textField(fields, 'unit'), location: textField(fields, 'location'), minQuantity: textField(fields, 'minimum') || '0', openingQuantity: item ? '0' : textField(fields, 'opening') || '0' });
  }
  return <form onSubmit={submit}><p className={styles.formIntro}>{item ? 'Update the item details. Record a separate movement to change the stock balance.' : 'Give each material a stock code and unit. Opening stock starts in Main store and can then be transferred to a site.'}</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Stock code / SKU *"><input name="sku" required maxLength={64} defaultValue={item?.sku} placeholder="e.g. CEM-OPC-53" /></Field><Field label="Item name *"><input name="name" required maxLength={200} defaultValue={item?.name} placeholder="e.g. OPC cement, 53 grade" /></Field><Field label="Unit *" hint={item ? 'The unit cannot change after stock movements have been recorded.' : 'Use one consistent unit for all movements.'}><input name="unit" required maxLength={24} defaultValue={item?.unit} placeholder="bags, kg, tonnes, pieces…" /></Field><Field label="Storage note"><input name="location" maxLength={200} defaultValue={item?.location} placeholder="Site store / warehouse" /></Field><Field label="Minimum quantity" hint="The item is flagged when its balance reaches this level."><input name="minimum" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} defaultValue={item ? decimal(item.minQuantityMilli, 3) : '0'} /></Field>{!item && <Field label="Opening quantity" hint="Opening stock is added to Main store. Use a transfer to move it to a construction site."><input name="opening" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} defaultValue="0" /></Field>}</div></fieldset><FormFooter disabled={disabled} close={close} label={item ? 'Save item details' : 'Add stock item'} /></form>;
}

function MovementForm({ item, data, disabled, save, close }: { item?: StockItem; data: OperationsData; disabled: boolean; save: Save; close: () => void }) {
  const active = data.stockItems.filter(value => value.active);
  const [selected, setSelected] = useState(item?.id || active[0]?.id || '');
  const [type, setType] = useState<StockMovementType>('IN');
  const sites = data.extension.sites.filter(site => site.active);
  const [siteId, setSiteId] = useState(sites.find(site => site.system)?.id || sites[0]?.id || '');
  const current = active.find(value => value.id === selected);
  const siteBalance = data.extension.siteBalances.find(balance => balance.itemId === selected && balance.siteId === siteId)?.quantityMilli || 0;
  return <form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); void save('stock_location_move', { itemId: selected, siteId, type, quantity: textField(fields, 'quantity'), reference: textField(fields, 'reference'), note: textField(fields, 'note') }); }}><p className={styles.formIntro}>Record material received or consumed at the selected location. Use a transfer below when moving unused stock between sites.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Stock item *"><select value={selected} required onChange={event => setSelected(event.target.value)}>{active.map(value => <option value={value.id} key={value.id}>{value.name} · {value.sku}</option>)}</select></Field><Field label="Stock location *"><select required value={siteId} onChange={event => setSiteId(event.target.value)}>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></Field><Field label="Movement *"><select value={type} onChange={event => setType(event.target.value as StockMovementType)}><option value="IN">Stock in — received</option><option value="OUT">Stock out — used / issued</option>{data.permissions.admin && <option value="ADJUST">Adjustment — correct the balance</option>}</select></Field><Field label={`${type === 'ADJUST' ? 'Correct new balance' : 'Quantity'}${current ? ` (${current.unit})` : ''} *`} hint={current ? `Available at this location: ${quantity(siteBalance)} ${current.unit}. ${type === 'ADJUST' ? 'Enter the final count for this location.' : 'Up to 3 decimal places.'}` : undefined}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} placeholder={type === 'ADJUST' ? 'New on-hand balance' : 'Quantity moved'} /></Field><Field label="Bill / delivery / project reference"><input name="reference" maxLength={200} placeholder="Delivery note, work order, or site reference" /></Field><Field label={type === 'ADJUST' ? 'Reason for correction *' : 'Movement note'} wide><textarea name="note" maxLength={2000} required={type === 'ADJUST'} rows={3} placeholder={type === 'ADJUST' ? 'Explain the stock count or correction' : 'Where did the material come from or where was it used?'} /></Field></div></fieldset><FormFooter disabled={disabled} close={close} label={type === 'ADJUST' ? 'Record balance correction' : type === 'IN' ? 'Record stock received' : 'Record stock used'} /></form>;
}

function AttendanceForm({ record, data, members, disabled, save, close, reportError }: EditorProps & { record?: AttendanceRecord }) {
  const [status, setStatus] = useState<AttendanceStatus>(record?.status || 'PRESENT');
  const [workDate, setWorkDate] = useState(record?.workDate || data.today);
  const hasTimes = status === 'PRESENT' || status === 'HALF_DAY';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    const start = hasTimes ? textField(fields, 'checkIn') : '';
    const end = hasTimes ? textField(fields, 'checkOut') : '';
    if (end && !start) { reportError('Enter a check-in time before adding a check-out time.'); return; }
    if (start && start.slice(0, 10) !== workDate) { reportError('Check-in must fall on the attendance date in India Standard Time.'); return; }
    if (start && end && end <= start) { reportError('Check-out must be later than check-in.'); return; }
    try {
      void save('attendance_correct', { userId: record?.userId || textField(fields, 'userId'), workDate, status, checkIn: isoFromIST(start), checkOut: isoFromIST(end), siteId: textField(fields, 'siteId') || null, site: record?.site || '', notes: textField(fields, 'notes'), reason: textField(fields, 'reason') });
    } catch { reportError('Enter valid check-in and check-out times.'); }
  }
  return <form onSubmit={submit}><p className={styles.formIntro}>Mark or correct a working day with a reason. Present and half-day records may be entered without times; absent and leave records have no shift times.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Employee *"><select name="userId" required disabled={!!record} defaultValue={record?.userId || data.user.userId}>{members.map(member => <option key={member.userId} value={member.userId}>{member.name}{!member.active ? ' (removed account)' : ''}</option>)}</select></Field><Field label="Attendance date *"><input type="date" required readOnly={!!record} value={workDate} max={data.today} onChange={event => setWorkDate(event.target.value)} /></Field><Field label="Status *"><select value={status} onChange={event => setStatus(event.target.value as AttendanceStatus)}>{Object.entries(ATTENDANCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Construction site"><select name="siteId" defaultValue={record?.siteId || ''}><option value="">Office / no linked site</option>{data.extension.sites.filter(site => site.kind === 'SITE' && (site.active || site.id === record?.siteId)).map(site => <option key={site.id} value={site.id}>{site.name}{!site.active ? ' (archived)' : ''}</option>)}</select></Field>{hasTimes && <><Field label="Check-in date & time (IST)" hint="Optional. Must be on the selected attendance date."><input type="datetime-local" name="checkIn" defaultValue={istLocal(record?.checkIn || null)} max={istLocal(data.serverTime)} /></Field><Field label="Check-out date & time (IST)" hint="Optional. An overnight shift may end on the following date."><input type="datetime-local" name="checkOut" defaultValue={istLocal(record?.checkOut || null)} max={istLocal(data.serverTime)} /></Field></>}<Field label="Attendance notes" wide><textarea name="notes" maxLength={2000} rows={2} defaultValue={record?.notes} /></Field><Field label="Reason for this entry / correction *" hint="This reason is retained with the administrator’s change." wide><textarea name="reason" maxLength={2000} required rows={3} placeholder="Why are you marking or correcting this attendance?" /></Field></div></fieldset><FormFooter disabled={disabled} close={close} label={record ? 'Save attendance correction' : 'Record attendance'} /></form>;
}

function ExpenseForm({ expense, today, disabled, save, close }: { expense?: Expense; today: string; disabled: boolean; save: Save; close: () => void }) {
  return <form onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); void save('expense_save', { ...(expense ? { id: expense.id } : {}), expenseDate: textField(fields, 'expenseDate'), title: textField(fields, 'title'), category: textField(fields, 'category'), amount: textField(fields, 'amount'), site: textField(fields, 'site'), reference: textField(fields, 'reference'), notes: textField(fields, 'notes') }); }}><p className={styles.formIntro}>{expense?.status === 'REJECTED' ? 'Update the details requested by your administrator. Saving sends this expense back for review.' : 'Enter an expense you incurred. Your administrator will review the request and record its payment status.'}</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Expense title *" wide><input name="title" required maxLength={200} defaultValue={expense?.title} placeholder="What was the expense for?" /></Field><Field label="Expense date *"><input name="expenseDate" type="date" required max={today} defaultValue={expense?.expenseDate || today} /></Field><Field label="Category *"><select name="category" required defaultValue={expense?.category || 'Materials'}>{EXPENSE_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></Field><Field label="Amount (₹) *" hint="Enter the total paid, with up to 2 decimal places."><input name="amount" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={30} defaultValue={expense ? decimal(expense.amountPaise, 2) : undefined} placeholder="0.00" /></Field><Field label="Site / project"><input name="site" maxLength={200} defaultValue={expense?.site} placeholder="Project or site name" /></Field><Field label="Bill / payment reference" wide><input name="reference" maxLength={200} defaultValue={expense?.reference} placeholder="Bill number, vendor, or payment reference" /></Field><Field label="Notes" wide><textarea name="notes" maxLength={2000} rows={3} defaultValue={expense?.notes} placeholder="Add the details needed to review this expense" /></Field></div></fieldset><FormFooter disabled={disabled} close={close} label={expense?.status === 'REJECTED' ? 'Resubmit for review' : expense ? 'Save expense changes' : 'Submit expense'} /></form>;
}
