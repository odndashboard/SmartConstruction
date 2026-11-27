'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowDownLeft, ArrowRight, CalendarDays, Check, ChevronDown,
  CircleAlert, Clock3, FileText, IndianRupee, LoaderCircle, Plus, ReceiptText,
  ShieldCheck, Wallet, X,
} from 'lucide-react';
import type { AdvancedPanelProps, CustomerPayment, ExtensionAction, PaymentAccount, PaymentInstallment, PaymentMethod } from '@/lib/operations-extensions';
import styles from './PaymentsPanel.module.css';

type Editor =
  | { kind: 'installment'; workOrderId?: string }
  | { kind: 'payment'; workOrderId?: string }
  | { kind: 'cancel'; installment: PaymentInstallment }
  | { kind: 'void'; payment: CustomerPayment };
type Commit = (action: ExtensionAction, payload: Record<string, unknown>) => Promise<void>;
type TotalKey = 'contractPaise' | 'scheduledPaise' | 'receivedPaise' | 'outstandingPaise' | 'overduePaise' | 'unallocatedPaise';
type FormProps = AdvancedPanelProps & { editor: Editor; disabled: boolean; commit: Commit; close: () => void; report: (message: string) => void };
const METHOD_LABELS: Record<PaymentMethod, string> = { CASH: 'Cash', BANK: 'Bank transfer', UPI: 'UPI', CHEQUE: 'Cheque', OTHER: 'Other' };

function money(value: string | number | bigint): string {
  const scaled = BigInt(value); const absolute = scaled < 0n ? -scaled : scaled;
  return `${scaled < 0n ? '−' : ''}₹${(absolute / 100n).toLocaleString('en-IN')}.${String(absolute % 100n).padStart(2, '0')}`;
}
function date(value: string): string {
  return new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function field(fields: FormData, name: string): string { return String(fields.get(name) ?? '').trim(); }
function required(value: string, label: string): string { if (!value.trim()) throw new Error(`${label} is required.`); return value.trim(); }
function paymentAmount(value: string, maximum: bigint): string {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(clean) || clean.length > 30) throw new Error('Enter an INR amount with up to two decimal places.');
  const [whole, fraction = ''] = clean.split('.');
  const scaled = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (scaled <= 0n) throw new Error('The amount must be greater than zero.');
  if (scaled > maximum || scaled > 9_000_000_000_000n) throw new Error(`The amount cannot exceed ${money(maximum < 9_000_000_000_000n ? maximum : 9_000_000_000_000n)}.`);
  return clean;
}
function send(event: FormEvent<HTMLFormElement>, build: (fields: FormData) => [ExtensionAction, Record<string, unknown>], commit: Commit, report: (message: string) => void) {
  event.preventDefault();
  try { const [action, payload] = build(new FormData(event.currentTarget)); void commit(action, payload); }
  catch (error) { report(error instanceof Error ? error.message : 'Check the payment details.'); }
}
function canRecord(workspace: AdvancedPanelProps['workspace'], workOrderId: string): boolean {
  const order = workspace.workorders.find(row => row.id === workOrderId);
  return !!order && !!order.snapshot && !!order.quoteId && !order.isDemo && order.status !== 'CANCELLED';
}
function title(editor: Editor): string {
  return editor.kind === 'installment' ? 'Add a payment instalment' : editor.kind === 'payment' ? 'Record a customer payment' : editor.kind === 'cancel' ? 'Cancel a scheduled instalment' : 'Void a recorded payment';
}
function editorKey(editor: Editor): string {
  return `${editor.kind}-${editor.kind === 'cancel' ? editor.installment.id : editor.kind === 'void' ? editor.payment.id : editor.workOrderId || 'new'}`;
}

export default function PaymentsPanel(props: AdvancedPanelProps) {
  if (!props.data.permissions.admin || props.data.user.role !== 'OWNER' || !props.data.user.active) {
    return <div className={styles.access}><ShieldCheck size={28} /><h2>Administrator access required</h2><p>Customer payment accounts are available to the active workspace administrator.</p></div>;
  }
  return <AdministratorPayments key={props.data.user.userId} {...props} />;
}

function AdministratorPayments({ workspace, data, blocked, save }: AdvancedPanelProps) {
  const [selected, setSelected] = useState('all');
  const [view, setView] = useState<'schedule' | 'receipts'>('schedule');
  const [showCancelled, setShowCancelled] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const accounts = data.extension.paymentAccounts;
  const installments = data.extension.paymentInstallments;
  const receipts = data.extension.customerPayments;
  const disabled = blocked || pending;
  const currentAccounts = (accounts || []).filter(account => selected === 'all' || account.workOrderId === selected);
  const accountMap = new Map((accounts || []).map(account => [account.workOrderId, account]));
  const currentInstallments = (installments || []).filter(row => (selected === 'all' || row.workOrderId === selected) && (showCancelled || !row.cancelledAt))
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const currentReceipts = (receipts || []).filter(row => selected === 'all' || row.workOrderId === selected)
    .sort((left, right) => right.paymentDate.localeCompare(left.paymentDate) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  const total = (key: TotalKey) => currentAccounts.reduce((sum, account) => sum + BigInt(account[key]), 0n);
  const eligibleAccounts = currentAccounts.filter(account => canRecord(workspace, account.workOrderId));
  const canAddSchedule = eligibleAccounts.some(account => BigInt(account.contractPaise) > BigInt(account.scheduledPaise));
  const canAddReceipt = eligibleAccounts.some(account => BigInt(account.outstandingPaise) > 0n);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = useCallback(() => {
    if (blocked || pending) return;
    setEditor(null); setError('');
    requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
  }, [blocked, pending]);
  useEffect(() => {
    if (!editor) return;
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const back = (event: Event) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopImmediatePropagation(); close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); close(); } };
    window.addEventListener('smart-construction-back', back, true); document.addEventListener('keydown', escape);
    return () => { window.removeEventListener('smart-construction-back', back, true); document.removeEventListener('keydown', escape); };
  }, [editor, close]);
  useEffect(() => { if (error) errorElement.current?.focus({ preventScroll: false }); }, [error]);
  function open(value: Editor) {
    if (disabled) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setEditor(value);
  }
  async function commit(action: ExtensionAction, payload: Record<string, unknown>) {
    if (blocked || sending.current || !data.permissions.admin || !data.permissions.canWrite) return;
    sending.current = true; setPending(true); setError('');
    try {
      const saved = await save(action, payload);
      if (saved && mounted.current) {
        setEditor(null);
        requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
      } else if (mounted.current) {
        setError('This payment change has not been confirmed. Review the workspace message above before trying again.');
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The payment record could not be saved. Try again.'); }
    finally { sending.current = false; if (mounted.current) setPending(false); }
  }

  if (!accounts || !installments || !receipts) return <div className={styles.access}><CircleAlert size={28} /><h2>Payment accounts are unavailable</h2><p>Refresh the workspace to check your current access and account balances.</p></div>;

  return <div className={styles.workspace} aria-label="Customer payments">
    <div className={styles.toolbar}><div className={styles.intro}><span><Wallet size={20} /></span><div><strong>Customer payments, clearly recorded</strong><small>All-time work order balances · amounts in INR</small></div></div><span className={styles.adminBadge}><ShieldCheck size={13} />Administrator only</span></div>
    <div className={styles.accountFilter}><label><span>Work order account</span><select value={selected} disabled={disabled} onChange={event => { setSelected(event.target.value); setEditor(null); setError(''); }}><option value="all">All work order accounts</option>{accounts.map(account => <option key={account.workOrderId} value={account.workOrderId}>{account.number} · {account.title} · {account.customerName}</option>)}</select></label><div className={styles.actions}><button className="button button-secondary" disabled={disabled || !canAddSchedule} onClick={() => open({ kind: 'installment', workOrderId: selected === 'all' ? undefined : selected })}><CalendarDays size={16} />Add instalment</button><button className="button button-primary" disabled={disabled || !canAddReceipt} onClick={() => open({ kind: 'payment', workOrderId: selected === 'all' ? undefined : selected })}><Plus size={17} />Record payment</button></div></div>

    {editor && <section className={styles.editor} aria-label="Customer payment form"><header><div><span className={styles.eyebrow}>A CLEAR CUSTOMER ACCOUNT</span><h2 ref={heading} tabIndex={-1}>{title(editor)}</h2></div><button className={styles.iconButton} aria-label="Close payment form" disabled={disabled} onClick={close}><X size={19} /></button></header>{error && <div role="alert" tabIndex={-1} ref={errorElement} className={styles.error}><CircleAlert size={18} /><p>{error}</p></div>}<PaymentEditor key={editorKey(editor)} workspace={workspace} data={data} blocked={blocked} save={save} editor={editor} disabled={disabled} commit={commit} close={close} report={setError} /></section>}

    <div className={styles.stats}><Stat label="Contract value" value={money(total('contractPaise'))} hint={selected === 'all' ? `${accounts.length} work order accounts` : 'Agreed work order total'} icon={FileText} /><Stat label="Received" value={money(total('receivedPaise'))} hint="Valid customer payment receipts" icon={ArrowDownLeft} tone="green" /><Stat label="Outstanding" value={money(total('outstandingPaise'))} hint="Contract value less recorded receipts" icon={IndianRupee} /><Stat label="Overdue" value={money(total('overduePaise'))} hint="Unpaid instalments due before today" icon={Clock3} tone="gold" /></div>
    <div className={styles.balanceNote}><span>Active scheduled amount <strong>{money(total('scheduledPaise'))}</strong></span><span>Unallocated advance <strong>{money(total('unallocatedPaise'))}</strong></span></div>

    <section className={styles.card}><header className={styles.cardHeader}><div><span className={styles.eyebrow}>CONTRACTS &amp; COLLECTIONS</span><h2>Work order accounts</h2><p>Compare each contract with the receipts and instalments recorded against it.</p></div></header>{currentAccounts.length ? <div className={styles.accounts}>{currentAccounts.map(account => {
      const recordable = canRecord(workspace, account.workOrderId); const order = workspace.workorders.find(row => row.id === account.workOrderId);
      return <article className={styles.account} key={account.workOrderId}><div className={styles.accountTop}><span className={styles.accountIcon}><FileText size={21} /></span><div><small>{account.number}{order?.status === 'CANCELLED' ? ' · Cancelled work order' : ''}</small><h3>{account.title}</h3><p>{account.customerName}</p></div>{BigInt(account.overduePaise) > 0n && <span className={`${styles.badge} ${styles.overdue}`}>Overdue</span>}</div><div className={styles.accountAmounts}><div><small>Contract</small><strong>{money(account.contractPaise)}</strong></div><div><small>Received</small><strong>{money(account.receivedPaise)}</strong></div><div><small>Outstanding</small><strong>{money(account.outstandingPaise)}</strong></div></div><footer><span>Overdue <b>{money(account.overduePaise)}</b></span><div className={styles.actions}><button className={styles.textButton} disabled={disabled} onClick={() => { setSelected(account.workOrderId); setView('schedule'); setEditor(null); }}>View account <ArrowRight size={13} /></button>{recordable && BigInt(account.outstandingPaise) > 0n && <button className="button button-secondary button-small" disabled={disabled} onClick={() => open({ kind: 'payment', workOrderId: account.workOrderId })}><Plus size={14} />Record receipt</button>}</div></footer></article>;
    })}</div> : <Empty icon={FileText} title="Payment accounts for approved work">Accept a quotation to add approved pricing to its work order and start tracking instalments and customer receipts.</Empty>}</section>

    <section className={styles.card}><header className={styles.cardHeader}><div><span className={styles.eyebrow}>PAYMENT HISTORY</span><h2>{view === 'schedule' ? 'Payment schedule' : 'Recorded customer payments'}</h2><p>{view === 'schedule' ? 'Receipts are applied to active instalments in order of due date. Any remaining receipt amount stays as an unallocated advance.' : 'Record receipts after receiving money from the customer. Voided records remain visible in the history.'}</p></div><div className={styles.segmented} aria-label="Payment record view"><button aria-pressed={view === 'schedule'} onClick={() => setView('schedule')}><CalendarDays size={14} />Schedule</button><button aria-pressed={view === 'receipts'} onClick={() => setView('receipts')}><ReceiptText size={14} />Receipts</button></div></header>
      {view === 'schedule' && <><div className={styles.filterBar}><label className={styles.checkbox}><input type="checkbox" checked={showCancelled} onChange={event => setShowCancelled(event.target.checked)} />Include cancelled instalments</label><small>{currentInstallments.length} shown</small></div>{currentInstallments.length ? <div className={styles.records}>{currentInstallments.map(installment => {
        const account = accountMap.get(installment.workOrderId); const isOverdue = !installment.cancelledAt && installment.dueDate < data.today && BigInt(installment.balancePaise) > 0n;
        return <article key={installment.id} className={`${styles.installment} ${installment.cancelledAt ? styles.cancelledRecord : ''}`}><div className={styles.recordMain}><span className={styles.dateTile}><strong>{Number(installment.dueDate.slice(8))}</strong><small>{new Date(`${installment.dueDate}T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'Asia/Kolkata' })}</small></span><div className={styles.identity}><strong>{installment.title}</strong><small>{account?.number || 'Work order'} · {account?.customerName || ''}</small><small>Due {date(installment.dueDate)}</small></div><div className={styles.recordAmount}><strong>{money(installment.amountPaise)}</strong><span className={`${styles.badge} ${installment.cancelledAt ? styles.neutral : isOverdue ? styles.overdue : BigInt(installment.balancePaise) === 0n ? styles.paid : ''}`}>{installment.cancelledAt ? 'Cancelled' : isOverdue ? 'Overdue' : BigInt(installment.balancePaise) === 0n ? 'Paid' : 'Scheduled'}</span></div></div><div className={styles.installmentFoot}><div>{!installment.cancelledAt ? <><span>Applied <b>{money(installment.paidPaise)}</b></span><span>Balance <b>{money(installment.balancePaise)}</b></span></> : <span>Cancelled {date(installment.cancelledAt)}</span>}</div>{!installment.cancelledAt && <button className={styles.textButton} disabled={disabled} onClick={() => open({ kind: 'cancel', installment })}>Cancel instalment</button>}</div>{installment.cancelReason && <p className={styles.recordNote}><b>Cancellation reason:</b> {installment.cancelReason}</p>}</article>;
      })}</div> : <Empty icon={CalendarDays} title="Plan the next customer payment">Add instalments with clear amounts and due dates. Scheduled amounts stay within the agreed contract value.</Empty>}</>}
      {view === 'receipts' && (currentReceipts.length ? <div className={styles.records}>{currentReceipts.map(payment => {
        const account = accountMap.get(payment.workOrderId);
        return <article className={`${styles.payment} ${payment.voidedAt ? styles.cancelledRecord : ''}`} key={payment.id}><div className={styles.recordMain}><span className={`${styles.receiptIcon} ${payment.voidedAt ? styles.voidIcon : ''}`}><ArrowDownLeft size={20} /></span><div className={styles.identity}><strong>{METHOD_LABELS[payment.method]} · {date(payment.paymentDate)}</strong><small>{account?.number || 'Work order'} · {account?.customerName || ''}</small>{payment.reference && <small>{payment.reference}</small>}</div><div className={styles.recordAmount}><strong>{money(payment.amountPaise)}</strong><span className={`${styles.badge} ${payment.voidedAt ? styles.neutral : styles.paid}`}>{payment.voidedAt ? 'Voided' : 'Received'}</span></div></div><footer className={styles.paymentFoot}><details className={styles.details}><summary>Receipt details <ChevronDown size={13} /></summary><dl><div><dt>Work order</dt><dd>{account?.title || 'Work order'}</dd></div><div><dt>Reference</dt><dd>{payment.reference || 'Not recorded'}</dd></div><div><dt>Notes</dt><dd>{payment.notes || 'No additional notes'}</dd></div><div><dt>Recorded by</dt><dd>{workspace.members.find(member => member.userId === payment.actorId)?.name || 'Administrator'}</dd></div><div><dt>Recorded on</dt><dd>{date(payment.createdAt)}</dd></div>{payment.voidedAt && <div><dt>Voided on</dt><dd>{date(payment.voidedAt)}</dd></div>}{payment.voidReason && <div><dt>Void reason</dt><dd>{payment.voidReason}</dd></div>}</dl></details>{!payment.voidedAt && <button className={styles.textButton} disabled={disabled} onClick={() => open({ kind: 'void', payment })}>Void receipt</button>}</footer>{payment.voidReason && <p className={styles.recordNote}><b>Void reason:</b> {payment.voidReason}</p>}</article>;
      })}</div> : <Empty icon={ReceiptText} title="Record a payment when it arrives">Customer receipts will appear here with their date, amount, payment method and reference.</Empty>)}
    </section>
    <p className={styles.footnote}><ShieldCheck size={14} />These records track customer receipts and schedules. Keep payment references with each entry so the account remains easy to reconcile.</p>
  </div>;
}

function Stat({ label, value, hint, icon: Icon, tone = 'navy' }: { label: string; value: string; hint: string; icon: typeof Wallet; tone?: 'navy' | 'gold' | 'green' }) {
  return <article className={styles.stat}><div><span>{label}</span><span className={`${styles.statIcon} ${styles[tone]}`}><Icon size={18} /></span></div><strong>{value}</strong><small>{hint}</small></article>;
}
function Empty({ icon: Icon, title: heading, children }: { icon: typeof Wallet; title: string; children: ReactNode }) {
  return <div className={styles.empty}><span><Icon size={27} strokeWidth={1.6} /></span><h3>{heading}</h3><p>{children}</p></div>;
}
function Field({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Footer({ disabled, close, label, unavailable = false, danger = false }: { disabled: boolean; close: () => void; label: string; unavailable?: boolean; danger?: boolean }) {
  return <div className={styles.formFooter}><button className="button button-secondary" type="button" disabled={disabled} onClick={close}>Cancel</button><button className={`button ${danger ? 'button-danger' : 'button-primary'}`} type="submit" disabled={disabled || unavailable}>{disabled ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{label}</button></div>;
}
function AccountContext({ account }: { account: PaymentAccount | undefined }) {
  if (!account) return null;
  return <div className={styles.formContext}><FileText size={21} /><div><strong>{account.number} · {account.title}</strong><p>{account.customerName}</p><div><span>Contract <b>{money(account.contractPaise)}</b></span><span>Outstanding <b>{money(account.outstandingPaise)}</b></span></div></div></div>;
}

function PaymentEditor(props: FormProps) {
  const { editor, data, disabled, close, commit, report } = props;
  if (editor.kind === 'installment') return <InstallmentForm {...props} initialWorkOrder={editor.workOrderId} />;
  if (editor.kind === 'payment') return <ReceiptForm {...props} initialWorkOrder={editor.workOrderId} />;
  if (editor.kind === 'cancel') {
    const installment = data.extension.paymentInstallments?.find(row => row.id === editor.installment.id) || editor.installment;
    const account = data.extension.paymentAccounts?.find(row => row.workOrderId === installment.workOrderId);
    return <form onSubmit={event => send(event, fields => ['payment_installment_cancel', { id: installment.id, reason: required(field(fields, 'reason'), 'Cancellation reason') }], commit, report)}><p className={styles.formIntro}>Cancel <b>{installment.title}</b> for <b>{money(installment.amountPaise)}</b>, due {date(installment.dueDate)}. Recorded receipts remain in the account and are reapplied to the remaining active schedule.</p><AccountContext account={account} /><fieldset disabled={disabled}><Field label="Reason for cancelling this instalment *"><textarea name="reason" required maxLength={2000} rows={3} /></Field></fieldset><Footer disabled={disabled} close={close} unavailable={!!installment.cancelledAt} label="Cancel scheduled instalment" danger /></form>;
  }
  const payment = data.extension.customerPayments?.find(row => row.id === editor.payment.id) || editor.payment;
  const account = data.extension.paymentAccounts?.find(row => row.workOrderId === payment.workOrderId);
  return <form onSubmit={event => send(event, fields => ['payment_void', { id: payment.id, reason: required(field(fields, 'reason'), 'Void reason') }], commit, report)}><p className={styles.formIntro}>Void the recorded receipt of <b>{money(payment.amountPaise)}</b> dated {date(payment.paymentDate)}. The receipt and reason remain in the history, and the outstanding balance and instalment allocations are recalculated.</p><AccountContext account={account} /><div className={styles.receiptContext}><ReceiptText size={17} /><span>{METHOD_LABELS[payment.method]}{payment.reference ? ` · ${payment.reference}` : ' · No reference recorded'}</span></div><fieldset disabled={disabled}><Field label="Reason for voiding this receipt *"><textarea name="reason" required maxLength={2000} rows={3} placeholder="Explain the duplicate, incorrect amount, or other correction." /></Field></fieldset><Footer disabled={disabled} close={close} unavailable={!!payment.voidedAt} label="Void recorded payment" danger /></form>;
}

function InstallmentForm({ workspace, data, disabled, commit, close, report, initialWorkOrder }: FormProps & { initialWorkOrder?: string }) {
  const eligible = (data.extension.paymentAccounts || []).filter(account => canRecord(workspace, account.workOrderId) && BigInt(account.contractPaise) > BigInt(account.scheduledPaise));
  const [workOrderId, setWorkOrder] = useState(eligible.some(account => account.workOrderId === initialWorkOrder) ? initialWorkOrder! : eligible[0]?.workOrderId || '');
  const account = eligible.find(row => row.workOrderId === workOrderId);
  const available = account ? BigInt(account.contractPaise) - BigInt(account.scheduledPaise) : 0n;
  return <form onSubmit={event => send(event, fields => {
    if (!account) throw new Error('Choose an active work order with an unscheduled balance.');
    return ['payment_installment_add', { workOrderId, title: required(field(fields, 'title'), 'Instalment title'), dueDate: required(field(fields, 'dueDate'), 'Due date'), amount: paymentAmount(field(fields, 'amount'), available) }];
  }, commit, report)}><p className={styles.formIntro}>Add a clear payment milestone within the contract value. Customer receipts are applied to the earliest active due instalments first.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Work order *" wide><select required value={workOrderId} onChange={event => setWorkOrder(event.target.value)}>{eligible.map(row => <option key={row.workOrderId} value={row.workOrderId}>{row.number} · {row.title} · {row.customerName}</option>)}</select></Field></div><AccountContext account={account} /><div className={styles.formGrid}><Field label="Instalment title *" wide><input name="title" required maxLength={200} placeholder="e.g. Foundation completion payment" /></Field><Field label="Due date *"><input name="dueDate" type="date" required defaultValue={data.today} /></Field><Field label="Amount (₹) *" hint={`Available to schedule: ${money(available)}.`}><input name="amount" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={30} placeholder="0.00" /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!account || available <= 0n} label="Add payment instalment" /></form>;
}
function ReceiptForm({ workspace, data, disabled, commit, close, report, initialWorkOrder }: FormProps & { initialWorkOrder?: string }) {
  const eligible = (data.extension.paymentAccounts || []).filter(account => canRecord(workspace, account.workOrderId) && BigInt(account.outstandingPaise) > 0n);
  const [workOrderId, setWorkOrder] = useState(eligible.some(account => account.workOrderId === initialWorkOrder) ? initialWorkOrder! : eligible[0]?.workOrderId || '');
  const account = eligible.find(row => row.workOrderId === workOrderId);
  return <form onSubmit={event => send(event, fields => {
    if (!account) throw new Error('Choose an active work order with an outstanding balance.');
    return ['payment_record', { workOrderId, paymentDate: required(field(fields, 'paymentDate'), 'Payment date'), amount: paymentAmount(field(fields, 'amount'), BigInt(account.outstandingPaise)), method: field(fields, 'method'), reference: field(fields, 'reference'), notes: field(fields, 'notes') }];
  }, commit, report)}><p className={styles.formIntro}>Record money already received from the customer. The receipt is automatically applied to due instalments; amounts beyond the current schedule remain as an unallocated advance.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Work order *" wide><select required value={workOrderId} onChange={event => setWorkOrder(event.target.value)}>{eligible.map(row => <option key={row.workOrderId} value={row.workOrderId}>{row.number} · {row.title} · {row.customerName}</option>)}</select></Field></div><AccountContext account={account} /><div className={styles.formGrid}><Field label="Payment date *"><input name="paymentDate" type="date" required max={data.today} defaultValue={data.today} /></Field><Field label="Amount received (₹) *" hint={`Remaining contract balance: ${money(account?.outstandingPaise || '0')}.`}><input name="amount" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" maxLength={30} placeholder="0.00" /></Field><Field label="Payment method *"><select name="method" required defaultValue="BANK">{Object.entries(METHOD_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="Transfer / receipt reference"><input name="reference" maxLength={200} placeholder="Bank, UPI, cheque, or receipt reference" /></Field><Field label="Payment notes" wide><textarea name="notes" maxLength={2000} rows={3} placeholder="Useful details for reconciling this receipt" /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!account} label="Record payment received" /></form>;
}
