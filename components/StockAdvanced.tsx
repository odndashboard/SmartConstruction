'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeftRight, ArrowRight, Check, ChevronDown, CircleAlert, ClipboardList, CornerDownLeft, LoaderCircle,
  MapPin, Package, Plus, ShieldCheck, ShoppingCart, Truck, X,
} from 'lucide-react';
import type { AdvancedPanelProps, ConstructionSite, ExtensionAction, MaterialRequest, PurchaseOrder } from '@/lib/operations-extensions';
import type { StockMovement } from '@/lib/operations-types';
import styles from './StockAdvanced.module.css';

type Tab = 'locations' | 'movements' | 'requests' | 'purchases';
type Editor =
  | { kind: 'move'; siteId?: string; itemId?: string }
  | { kind: 'transfer'; siteId?: string; itemId?: string }
  | { kind: 'return'; movement?: StockMovement }
  | { kind: 'request' }
  | { kind: 'review'; request: MaterialRequest; status: 'APPROVED' | 'REJECTED' }
  | { kind: 'fulfill'; request: MaterialRequest }
  | { kind: 'cancelRequest'; request: MaterialRequest }
  | { kind: 'purchase' }
  | { kind: 'receive'; order: PurchaseOrder }
  | { kind: 'cancelPurchase'; order: PurchaseOrder };
type Commit = (action: ExtensionAction, payload: Record<string, unknown>) => Promise<void>;
type EditorProps = AdvancedPanelProps & { editor: Editor; disabled: boolean; commit: Commit; close: () => void; report: (message: string) => void };
const REQUEST_LABELS = { SUBMITTED: 'Awaiting review', APPROVED: 'Approved', REJECTED: 'Rejected', FULFILLED: 'Fulfilled', CANCELLED: 'Cancelled' };
const ORDER_LABELS = { OPEN: 'Awaiting delivery', PART_RECEIVED: 'Part received', RECEIVED: 'Received', CANCELLED: 'Cancelled' };

function amount(value: number | string | bigint): string {
  const scaled = BigInt(value); const absolute = scaled < 0n ? -scaled : scaled;
  const fraction = String(absolute % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${scaled < 0n ? '−' : ''}${(absolute / 1000n).toLocaleString('en-IN')}${fraction ? `.${fraction}` : ''}`;
}
function date(value: string | null): string {
  if (!value) return 'Not scheduled';
  return new Date(value.length === 10 ? `${value}T12:00:00+05:30` : value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}
function dateTime(value: string): string {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function field(fields: FormData, name: string): string { return String(fields.get(name) ?? '').trim(); }
function quantity(value: string, label = 'Quantity', maximum = 9_000_000_000_000n, allowZero = false): string {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(clean) || clean.length > 30) throw new Error(`${label} needs up to three decimal places.`);
  const [whole, fraction = ''] = clean.split('.');
  const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if ((!allowZero && scaled <= 0n) || scaled < 0n) throw new Error(`${label} must be greater than zero.`);
  if (scaled > maximum) throw new Error(`${label} cannot exceed ${amount(maximum)}.`);
  return clean;
}
function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
function available(data: AdvancedPanelProps['data'], siteId: string, itemId: string): number {
  return data.extension.siteBalances.find(row => row.siteId === siteId && row.itemId === itemId)?.quantityMilli ?? 0;
}
function returnable(move: StockMovement): bigint { return BigInt(move.quantityMilli) - BigInt(move.returnedMilli ?? '0'); }
function send(event: FormEvent<HTMLFormElement>, build: (fields: FormData) => [ExtensionAction, Record<string, unknown>], commit: Commit, report: (message: string) => void) {
  event.preventDefault();
  try { const [action, payload] = build(new FormData(event.currentTarget)); void commit(action, payload); }
  catch (error) { report(error instanceof Error ? error.message : 'Check the entered details.'); }
}
function title(editor: Editor): string {
  switch (editor.kind) {
    case 'move': return 'Record stock at a location';
    case 'transfer': return 'Transfer materials';
    case 'return': return 'Return unused materials';
    case 'request': return 'Request materials for your site';
    case 'review': return editor.status === 'APPROVED' ? 'Approve material request' : 'Reject material request';
    case 'fulfill': return 'Supply an approved request';
    case 'cancelRequest': return 'Cancel material request';
    case 'purchase': return 'Create a purchase order';
    case 'receive': return 'Record a purchase delivery';
    case 'cancelPurchase': return 'Cancel the outstanding order';
  }
}
function editorKey(editor: Editor): string {
  return `${editor.kind}-${'request' in editor ? editor.request.id : 'order' in editor ? editor.order.id : 'movement' in editor ? editor.movement?.id || 'new' : 'itemId' in editor ? `${editor.itemId || ''}-${editor.siteId || ''}` : 'new'}`;
}

export default function StockAdvanced({ workspace, data, blocked, save }: AdvancedPanelProps) {
  const [tab, setTab] = useState<Tab>('locations');
  const [siteFilter, setSiteFilter] = useState('all');
  const [itemFilter, setItemFilter] = useState('all');
  const [requestFilter, setRequestFilter] = useState('OPEN');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  const admin = data.permissions.admin;
  const canWrite = data.permissions.canWrite;
  const visibleTab = tab === 'purchases' && !admin ? 'locations' : tab;
  const disabled = blocked || pending;
  const extension = data.extension;
  const siteMap = new Map(extension.sites.map(site => [site.id, site]));
  const itemMap = new Map(data.stockItems.map(item => [item.id, item]));
  const activeSites = extension.sites.filter(site => site.active);
  const activeItems = data.stockItems.filter(item => item.active);
  const myAssignment = extension.assignments.find(row => row.userId === data.user.userId);
  const assignedSite = siteMap.get(myAssignment?.siteId || '');
  const canRequest = canWrite && (admin ? activeSites.some(site => site.kind === 'SITE') : assignedSite?.active && assignedSite.kind === 'SITE');
  const requests = extension.materialRequests.filter(request => (admin || request.userId === data.user.userId)
    && (requestFilter === 'ALL' || (requestFilter === 'OPEN' ? ['SUBMITTED', 'APPROVED'].includes(request.status) : request.status === requestFilter)));
  const editorPermitted = !!editor && canWrite
    && (admin || !['review', 'fulfill', 'purchase', 'receive', 'cancelPurchase'].includes(editor.kind))
    && (editor.kind !== 'cancelRequest' || admin || (editor.request.userId === data.user.userId && editor.request.status === 'SUBMITTED'));
  const eligibleReturns = data.stockMovements.filter(move => move.type === 'OUT' && returnable(move) > 0n && itemMap.get(move.itemId)?.active);
  const balances = extension.siteBalances.filter(row => (siteFilter === 'all' || row.siteId === siteFilter) && (itemFilter === 'all' || row.itemId === itemFilter));
  const visibleSites = extension.sites.filter(site => (siteFilter === 'all' ? site.active || balances.some(row => row.siteId === site.id && row.quantityMilli > 0) : site.id === siteFilter));

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = useCallback(() => {
    if (blocked || pending) return;
    setEditor(null); setError('');
    requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
  }, [blocked, pending]);
  useEffect(() => {
    if (!editor) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    if (disabled || !canWrite) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setEditor(value);
  }
  async function commit(action: ExtensionAction, payload: Record<string, unknown>) {
    if (blocked || sending.current || !canWrite) return;
    sending.current = true; setPending(true); setError('');
    try {
      const saved = await save(action, payload);
      if (saved && mounted.current) {
        setEditor(null);
        requestAnimationFrame(() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); });
      } else if (mounted.current) {
        setError('This change has not been confirmed. Review the workspace message above before trying again.');
      }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The change could not be saved. Try again.'); }
    finally { sending.current = false; if (mounted.current) setPending(false); }
  }

  return <section className={styles.workspace} aria-label="Materials and purchasing">
    <div className={styles.sectionIntro}><span><Package size={21} /></span><div><h2>Materials, from store to site</h2><p>Track where materials are held, move supplies between locations, and keep requests traceable.</p></div></div>
    <div className={styles.tabs} aria-label="Stock management views">{([
      ['locations', 'By location', MapPin], ['movements', 'Transfers & returns', ArrowLeftRight], ['requests', 'Material requests', ClipboardList],
      ...(admin ? [['purchases', 'Purchase orders', ShoppingCart] as const] : []),
    ] as const).map(([key, label, Icon]) => <button key={key} type="button" aria-pressed={visibleTab === key} disabled={disabled} onClick={() => { setTab(key); setEditor(null); setError(''); }}><Icon size={16} />{label}</button>)}</div>

    {editor && editorPermitted && <section className={styles.editor} aria-label="Material record form"><header><div><span className={styles.eyebrow}>KEEP THE DETAILS CLEAR</span><h3 ref={heading} tabIndex={-1}>{title(editor)}</h3></div><button className={styles.iconButton} type="button" aria-label="Close material form" disabled={disabled} onClick={close}><X size={19} /></button></header>
      {error && <div className={styles.error} role="alert" tabIndex={-1} ref={errorElement}><CircleAlert size={18} /><p>{error}</p></div>}
      <StockEditor key={`${editorKey(editor)}-${admin ? 'owner' : 'employee'}`} workspace={workspace} data={data} blocked={blocked} save={save} editor={editor} disabled={disabled} commit={commit} close={close} report={setError} />
    </section>}

    {visibleTab === 'locations' && <section className={styles.card}><Header eyebrow="CURRENT BALANCES" title="Stock by location" description="The Main store and each construction site have their own available balance."><div className={styles.actions}>{canWrite && <><button className="button button-secondary button-small" disabled={disabled || activeSites.length < 2 || !activeItems.length} onClick={() => open({ kind: 'transfer', siteId: siteFilter === 'all' ? undefined : siteFilter })}><ArrowLeftRight size={15} />Transfer stock</button><button className="button button-primary button-small" disabled={disabled || !activeSites.length || !activeItems.length} onClick={() => open({ kind: 'move', siteId: siteFilter === 'all' ? undefined : siteFilter })}><Plus size={16} />Record movement</button></>}</div></Header>
      <div className={styles.filterBar}><label><span>Location</span><select value={siteFilter} onChange={event => setSiteFilter(event.target.value)}><option value="all">All locations</option>{extension.sites.map(site => <option key={site.id} value={site.id}>{site.name}{site.active ? '' : ' (archived)'}</option>)}</select></label><label><span>Material</span><select value={itemFilter} onChange={event => setItemFilter(event.target.value)}><option value="all">All materials</option>{data.stockItems.map(item => <option key={item.id} value={item.id}>{item.name} · {item.unit}</option>)}</select></label></div>
      {visibleSites.length ? <div className={styles.locations}>{visibleSites.map(site => {
        const rows = balances.filter(row => row.siteId === site.id);
        const work = workspace.workorders.find(order => order.id === site.workOrderId);
        return <article className={styles.location} key={site.id}><div className={styles.locationHeader}><span className={styles.locationIcon}><MapPin size={19} /></span><div><h3>{site.name}</h3><p>{site.kind === 'STORE' ? 'Main store' : work ? `${work.number} · ${work.title}` : 'Construction site'}{!site.active ? ' · Archived' : ''}</p>{site.address && <small>{site.address}</small>}</div></div>{rows.length ? <div className={styles.balanceRows}>{rows.map(row => {
          const item = itemMap.get(row.itemId);
          return <div className={styles.balanceRow} key={row.itemId}><div><strong>{item?.name || 'Stock item'}</strong><small>{item?.sku || ''}</small></div><strong className={styles.balance}>{amount(row.quantityMilli)} <small>{item?.unit}</small></strong>{canWrite && site.active && item?.active && <button className={styles.textButton} disabled={disabled} onClick={() => open({ kind: 'move', siteId: site.id, itemId: row.itemId })}>In / out <ArrowRight size={12} /></button>}</div>;
        })}</div> : <p className={styles.locationEmpty}>{itemFilter === 'all' ? 'No materials recorded at this location yet.' : 'This material has no recorded balance at this location.'}</p>}</article>;
      })}</div> : <Empty icon={MapPin} title="No location in this view">Choose another location to see its materials.</Empty>}
      {admin && <p className={styles.footnote}><ShieldCheck size={14} />Manage construction sites and employee assignments in Attendance.</p>}
    </section>}

    {visibleTab === 'movements' && <><section className={styles.card}><Header eyebrow="BETWEEN LOCATIONS" title="Transfers" description="Moving stock between stores and sites preserves the company’s total remaining quantity.">{canWrite && <button className="button button-primary button-small" disabled={disabled || activeSites.length < 2 || !activeItems.length} onClick={() => open({ kind: 'transfer' })}><ArrowLeftRight size={16} />New transfer</button>}</Header>
      {extension.transfers.length ? <div className={styles.ledger}>{extension.transfers.map(row => <article className={styles.ledgerRow} key={row.id}><span className={styles.rowIcon}><ArrowLeftRight size={18} /></span><div className={styles.identity}><strong>{itemMap.get(row.itemId)?.name || 'Stock item'}</strong><p>{siteMap.get(row.fromSiteId)?.name || 'Location'} <ArrowRight size={12} /> {siteMap.get(row.toSiteId)?.name || 'Location'}</p><small>{row.actorName} · {dateTime(row.createdAt)} IST{row.requestId ? ' · Material request' : ''}</small>{(row.note || row.reference) && <Details>{row.reference && <p><b>Reference:</b> {row.reference}</p>}{row.note && <p>{row.note}</p>}</Details>}</div><strong className={styles.rowQuantity}>{amount(row.quantityMilli)}<small>{itemMap.get(row.itemId)?.unit}</small></strong></article>)}</div> : <Empty icon={ArrowLeftRight} title="No transfers this month">Record a transfer when material moves from one location to another.</Empty>}
    </section><section className={styles.card}><Header eyebrow="UNUSED MATERIALS" title="Returns against usage" description="Link each return to its original stock-out record. The returned quantity becomes available again and reduces net usage.">{canWrite && <button className="button button-secondary button-small" disabled={disabled || !eligibleReturns.length} onClick={() => open({ kind: 'return' })}><CornerDownLeft size={16} />Return materials</button>}</Header>
      {!eligibleReturns.length && canWrite && <p className={styles.contextNote}>A return needs an outstanding stock-out record. Choose the month containing that issue in the history filter above.</p>}
      {extension.returns.length ? <div className={styles.ledger}>{extension.returns.map(row => <article className={styles.ledgerRow} key={row.id}><span className={`${styles.rowIcon} ${styles.green}`}><CornerDownLeft size={18} /></span><div className={styles.identity}><strong>{itemMap.get(row.itemId)?.name || 'Stock item'}</strong><p>Returned to {siteMap.get(row.siteId)?.name || 'location'}</p><small>{row.actorName} · {dateTime(row.createdAt)} IST</small><Details><p>{row.reason}</p></Details></div><strong className={styles.rowQuantity}>{amount(row.quantityMilli)}<small>{itemMap.get(row.itemId)?.unit}</small></strong></article>)}</div> : <Empty icon={CornerDownLeft} title="No returns this month">Unused materials returned against an issue will appear here.</Empty>}
    </section></>}

    {visibleTab === 'requests' && <section className={styles.card}><Header eyebrow={admin ? 'YOUR TEAM’S REQUIREMENTS' : 'YOUR SITE’S REQUIREMENTS'} title="Material requests" description={admin ? 'Review requirements, approve them, then transfer available stock into the requested site.' : 'Ask for materials for your assigned site and follow the request through to delivery.'}>{canWrite && <button className="button button-primary button-small" disabled={disabled || !canRequest || !activeItems.length} onClick={() => open({ kind: 'request' })}><Plus size={16} />Request materials</button>}</Header>
      {!admin && !assignedSite?.active && <p className={styles.contextNote}>Your administrator needs to assign an active construction site before you can request materials.</p>}
      <div className={styles.filterBar}><label><span>Status</span><select value={requestFilter} onChange={event => setRequestFilter(event.target.value)}><option value="OPEN">Outstanding requests</option><option value="ALL">All requests</option>{Object.entries(REQUEST_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span className={styles.scopeNote}>{admin ? 'All team requests' : 'Your own requests'}</span></div>
      {requests.length ? <div className={styles.records}>{requests.map(request => {
        const item = itemMap.get(request.itemId); const remaining = request.quantityMilli - request.fulfilledMilli;
        const mayCancel = canWrite && (admin ? ['SUBMITTED', 'APPROVED'].includes(request.status) : request.userId === data.user.userId && request.status === 'SUBMITTED');
        return <article className={styles.request} key={request.id}><div className={styles.recordTop}><span className={styles.rowIcon}><ClipboardList size={19} /></span><div className={styles.identity}><strong>{item?.name || 'Stock item'}</strong><p>{siteMap.get(request.siteId)?.name || 'Construction site'}{admin ? ` · ${request.memberName}` : ''}</p><small>{request.neededOn ? `Needed ${date(request.neededOn)}` : `Requested ${date(request.createdAt)}`}</small></div><Badge value={request.status}>{REQUEST_LABELS[request.status]}</Badge></div><div className={styles.requestProgress}><div><small>Requested</small><strong>{amount(request.quantityMilli)} {item?.unit}</strong></div><div><small>Supplied</small><strong>{amount(request.fulfilledMilli)} {item?.unit}</strong></div><div><small>Remaining</small><strong>{amount(remaining)} {item?.unit}</strong></div></div>
          {(request.note || request.reviewNote) && <div className={styles.recordNotes}>{request.note && <p>{request.note}</p>}{request.reviewNote && <p><b>Review:</b> {request.reviewNote}</p>}</div>}
          <footer className={styles.recordFooter}><small>{dateTime(request.createdAt)} IST</small><div className={styles.actions}>{mayCancel && <button className={styles.textButton} disabled={disabled} onClick={() => open({ kind: 'cancelRequest', request })}>Cancel request</button>}{admin && request.status === 'SUBMITTED' && <><button className="button button-secondary button-small" disabled={disabled} onClick={() => open({ kind: 'review', request, status: 'REJECTED' })}>Reject</button><button className="button button-primary button-small" disabled={disabled} onClick={() => open({ kind: 'review', request, status: 'APPROVED' })}><Check size={14} />Approve</button></>}{admin && request.status === 'APPROVED' && remaining > 0 && <button className="button button-primary button-small" disabled={disabled} onClick={() => open({ kind: 'fulfill', request })}><Truck size={15} />Supply materials</button>}</div></footer></article>;
      })}</div> : <Empty icon={ClipboardList} title="No requests in this view">{requestFilter === 'OPEN' ? 'Outstanding material requests will appear here. Change the status filter to review past requests.' : 'Material requests will appear here when they are submitted.'}</Empty>}
    </section>}

    {visibleTab === 'purchases' && admin && <section className={styles.card}><Header eyebrow="ORDER · RECEIVE · RECONCILE" title="Purchase orders" description="Order material quantities from a supplier and record each delivery against the outstanding order."><button className="button button-primary button-small" disabled={disabled || !activeItems.length || !activeSites.length} onClick={() => open({ kind: 'purchase' })}><Plus size={16} />New purchase order</button></Header>
      {extension.purchaseOrders === null ? <Empty icon={ShieldCheck} title="Purchasing records are unavailable">Refresh the workspace to check your current access.</Empty> : extension.purchaseOrders.length ? <div className={styles.records}>{extension.purchaseOrders.map(order => <article className={styles.purchase} key={order.id}><div className={styles.recordTop}><span className={styles.rowIcon}><ShoppingCart size={19} /></span><div className={styles.identity}><strong>{order.number} · {order.supplier}</strong><p>Delivery to {siteMap.get(order.siteId)?.name || 'location'}</p><small>{order.expectedOn ? `Expected ${date(order.expectedOn)}` : `Created ${date(order.createdAt)}`}{order.reference ? ` · ${order.reference}` : ''}</small></div><Badge value={order.status}>{ORDER_LABELS[order.status]}</Badge></div><div className={styles.orderLines}>{order.lines.map(line => <div key={line.id}><span>{itemMap.get(line.itemId)?.name || 'Stock item'}</span><strong>{amount(line.receivedMilli)} / {amount(line.quantityMilli)} <small>{itemMap.get(line.itemId)?.unit} received</small></strong></div>)}</div>{(order.notes || order.cancelReason) && <div className={styles.recordNotes}>{order.notes && <p>{order.notes}</p>}{order.cancelReason && <p><b>Cancellation:</b> {order.cancelReason}</p>}</div>}<footer className={styles.recordFooter}><small>{order.lines.length} {order.lines.length === 1 ? 'material' : 'materials'}</small><div className={styles.actions}>{['OPEN', 'PART_RECEIVED'].includes(order.status) && <><button className={styles.textButton} disabled={disabled} onClick={() => open({ kind: 'cancelPurchase', order })}>Cancel remainder</button><button className="button button-primary button-small" disabled={disabled || !siteMap.get(order.siteId)?.active} onClick={() => open({ kind: 'receive', order })}><Truck size={15} />Record delivery</button></>}</div></footer></article>)}</div> : <Empty icon={ShoppingCart} title="Your next delivery, accounted for">Create a quantity-based purchase order, then record full or partial deliveries as they arrive.</Empty>}
    </section>}
  </section>;
}

function Header({ eyebrow, title: heading, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <header className={styles.cardHeader}><div><span className={styles.eyebrow}>{eyebrow}</span><h3>{heading}</h3><p>{description}</p></div>{children && <div className={styles.headerActions}>{children}</div>}</header>;
}
function Empty({ icon: Icon, title: heading, children }: { icon: typeof Package; title: string; children: ReactNode }) {
  return <div className={styles.empty}><span><Icon size={26} /></span><h4>{heading}</h4><p>{children}</p></div>;
}
function Badge({ value, children }: { value: string; children: ReactNode }) { return <span className={`${styles.badge} ${styles[`status${value}`] || ''}`}><i />{children}</span>; }
function Details({ children }: { children: ReactNode }) { return <details className={styles.details}><summary>View details <ChevronDown size={13} /></summary>{children}</details>; }
function Field({ label, hint, wide = false, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return <label className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Footer({ disabled, close, label, unavailable = false }: { disabled: boolean; close: () => void; label: string; unavailable?: boolean }) {
  return <div className={styles.formFooter}><button type="button" className="button button-secondary" disabled={disabled} onClick={close}>Cancel</button><button type="submit" className="button button-primary" disabled={disabled || unavailable}>{disabled ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{label}</button></div>;
}
function SiteOptions({ sites }: { sites: ConstructionSite[] }) { return <>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</>; }

function StockEditor(props: EditorProps) {
  const { editor, data, disabled, commit, close, report } = props;
  if (editor.kind === 'move') return <LocationMovement {...props} initialSite={editor.siteId} initialItem={editor.itemId} />;
  if (editor.kind === 'transfer') return <TransferForm {...props} initialSite={editor.siteId} initialItem={editor.itemId} />;
  if (editor.kind === 'return') return <ReturnForm {...props} initialMovement={editor.movement} />;
  if (editor.kind === 'request') return <RequestForm {...props} />;
  if (editor.kind === 'purchase') return <PurchaseForm {...props} />;
  if (editor.kind === 'receive') return <ReceiveForm {...props} order={data.extension.purchaseOrders?.find(order => order.id === editor.order.id) || editor.order} />;
  if (editor.kind === 'fulfill') return <FulfillForm {...props} request={data.extension.materialRequests.find(request => request.id === editor.request.id) || editor.request} />;
  if (editor.kind === 'review') return <form onSubmit={event => send(event, fields => ['material_request_review', { id: editor.request.id, status: editor.status, note: editor.status === 'REJECTED' ? required(field(fields, 'note'), 'Rejection reason') : field(fields, 'note') }], commit, report)}><p className={styles.formIntro}>{editor.status === 'APPROVED' ? 'Approve this requirement so available stock can be supplied to the requested site. Approval keeps the stock balance unchanged until materials are supplied.' : 'Explain what needs to change so the employee can follow up.'}</p><RequestContext request={editor.request} data={data} /><fieldset disabled={disabled}><Field label={editor.status === 'REJECTED' ? 'Reason for rejection *' : 'Review note'}><textarea name="note" required={editor.status === 'REJECTED'} rows={3} maxLength={2000} /></Field></fieldset><Footer disabled={disabled} close={close} label={editor.status === 'APPROVED' ? 'Approve request' : 'Reject request'} /></form>;
  if (editor.kind === 'cancelRequest') return <form onSubmit={event => send(event, fields => ['material_request_cancel', { id: editor.request.id, reason: required(field(fields, 'reason'), 'Cancellation reason') }], commit, report)}><p className={styles.formIntro}>Cancel the outstanding requirement. Materials already supplied remain recorded in the request and location history.</p><RequestContext request={editor.request} data={data} /><fieldset disabled={disabled}><Field label="Reason for cancellation *"><textarea name="reason" rows={3} required maxLength={2000} /></Field></fieldset><Footer disabled={disabled} close={close} label="Cancel material request" /></form>;
  return <form onSubmit={event => send(event, fields => ['purchase_order_cancel', { id: editor.order.id, reason: required(field(fields, 'reason'), 'Cancellation reason') }], commit, report)}><p className={styles.formIntro}>Cancel the undelivered remainder of {editor.order.number}. Deliveries already recorded remain in stock and in the order’s history.</p><fieldset disabled={disabled}><Field label="Reason for cancellation *"><textarea name="reason" rows={3} required maxLength={2000} /></Field></fieldset><Footer disabled={disabled} close={close} label="Cancel outstanding order" /></form>;
}

function LocationMovement({ data, disabled, commit, close, report, initialSite, initialItem }: EditorProps & { initialSite?: string; initialItem?: string }) {
  const sites = data.extension.sites.filter(site => site.active);
  const items = data.stockItems.filter(item => item.active);
  const [siteId, setSite] = useState(sites.some(site => site.id === initialSite) ? initialSite! : sites.find(site => site.kind === 'STORE')?.id || sites[0]?.id || '');
  const [itemId, setItem] = useState(items.some(item => item.id === initialItem) ? initialItem! : items[0]?.id || '');
  const [type, setType] = useState<'IN' | 'OUT' | 'ADJUST'>('IN');
  const item = items.find(row => row.id === itemId);
  const balance = available(data, siteId, itemId);
  return <form onSubmit={event => send(event, fields => ['stock_location_move', { siteId, itemId, type, quantity: quantity(field(fields, 'quantity'), type === 'ADJUST' ? 'New balance' : 'Quantity', type === 'OUT' ? BigInt(balance) : 9_000_000_000_000n, type === 'ADJUST'), note: type === 'ADJUST' ? required(field(fields, 'note'), 'Correction reason') : field(fields, 'note'), reference: field(fields, 'reference') }], commit, report)}><p className={styles.formIntro}>Select the location where materials were received or used. Use a transfer when materials move between company locations.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Location *"><select required value={siteId} onChange={event => setSite(event.target.value)}><SiteOptions sites={sites} /></select></Field><Field label="Material *"><select required value={itemId} onChange={event => setItem(event.target.value)}>{items.map(row => <option key={row.id} value={row.id}>{row.name} · {row.unit}</option>)}</select></Field><Field label="Movement *"><select value={type} onChange={event => setType(event.target.value as typeof type)}><option value="IN">Stock received</option><option value="OUT">Stock used / issued</option>{data.permissions.admin && <option value="ADJUST">Correct location balance</option>}</select></Field><Field label={`${type === 'ADJUST' ? 'Correct new balance' : 'Quantity'}${item ? ` (${item.unit})` : ''} *`} hint={`Available here: ${amount(balance)} ${item?.unit || ''}. ${type === 'ADJUST' ? 'Enter the final balance at this location.' : 'Up to three decimal places.'}`}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><Field label="Delivery / work reference" wide><input name="reference" maxLength={200} /></Field><Field label={type === 'ADJUST' ? 'Reason for correction *' : 'Movement note'} wide><textarea name="note" required={type === 'ADJUST'} rows={3} maxLength={2000} /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!siteId || !itemId} label={type === 'IN' ? 'Record stock received' : type === 'OUT' ? 'Record stock used' : 'Save corrected balance'} /></form>;
}

function TransferForm({ data, disabled, commit, close, report, initialSite, initialItem }: EditorProps & { initialSite?: string; initialItem?: string }) {
  const sites = data.extension.sites.filter(site => site.active);
  const items = data.stockItems.filter(item => item.active);
  const initialFrom = sites.some(site => site.id === initialSite) ? initialSite! : sites.find(site => site.kind === 'STORE')?.id || sites[0]?.id || '';
  const [fromSiteId, setFrom] = useState(initialFrom);
  const [toSiteId, setTo] = useState(sites.find(site => site.id !== initialFrom)?.id || '');
  const [itemId, setItem] = useState(items.some(item => item.id === initialItem) ? initialItem! : items[0]?.id || '');
  const item = items.find(row => row.id === itemId);
  const balance = available(data, fromSiteId, itemId);
  return <form onSubmit={event => send(event, fields => {
    if (!fromSiteId || !toSiteId || fromSiteId === toSiteId) throw new Error('Choose two different active locations.');
    return ['stock_transfer', { itemId, fromSiteId, toSiteId, quantity: quantity(field(fields, 'quantity'), 'Transfer quantity', BigInt(balance)), reference: field(fields, 'reference'), note: field(fields, 'note') }];
  }, commit, report)}><p className={styles.formIntro}>Stock leaves the source location and becomes available at the destination in the same saved transfer.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="From location *"><select value={fromSiteId} required onChange={event => { setFrom(event.target.value); if (toSiteId === event.target.value) setTo(sites.find(site => site.id !== event.target.value)?.id || ''); }}><SiteOptions sites={sites} /></select></Field><Field label="To location *"><select value={toSiteId} required onChange={event => setTo(event.target.value)}><SiteOptions sites={sites.filter(site => site.id !== fromSiteId)} /></select></Field><Field label="Material *"><select value={itemId} required onChange={event => setItem(event.target.value)}>{items.map(row => <option key={row.id} value={row.id}>{row.name} · {row.unit}</option>)}</select></Field><Field label={`Quantity${item ? ` (${item.unit})` : ''} *`} hint={`Available at source: ${amount(balance)} ${item?.unit || ''}`}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><Field label="Transfer / delivery reference" wide><input name="reference" maxLength={200} /></Field><Field label="Transfer note" wide><textarea name="note" maxLength={2000} rows={3} /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!itemId || !toSiteId || balance <= 0} label="Record transfer" /></form>;
}

function ReturnForm({ data, disabled, commit, close, report, initialMovement }: EditorProps & { initialMovement?: StockMovement }) {
  const moves = data.stockMovements.filter(move => move.type === 'OUT' && returnable(move) > 0n && data.stockItems.some(item => item.id === move.itemId && item.active));
  const [movementId, setMovement] = useState(initialMovement?.id || moves[0]?.id || '');
  const movement = moves.find(move => move.id === movementId);
  const sites = data.extension.sites.filter(site => site.active);
  const [destination, setDestination] = useState('original');
  const item = data.stockItems.find(row => row.id === movement?.itemId);
  const remaining = movement ? returnable(movement) : 0n;
  const original = data.extension.sites.find(site => site.id === movement?.siteId);
  return <form onSubmit={event => send(event, fields => {
    if (!movement) throw new Error('Select an outstanding stock-out record.');
    if (destination === 'original' && !original?.active) throw new Error('Choose an active destination for this return.');
    return ['stock_return', { movementId, quantity: quantity(field(fields, 'quantity'), 'Return quantity', remaining), ...(destination === 'original' ? {} : { siteId: destination }), reason: required(field(fields, 'reason'), 'Return reason') }];
  }, commit, report)}><p className={styles.formIntro}>Return unused material against an original issue from the selected history month. Total returns cannot exceed that issue’s quantity.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Original stock-out record *" wide><select required value={movementId} onChange={event => setMovement(event.target.value)}>{moves.map(move => { const material = data.stockItems.find(row => row.id === move.itemId); return <option key={move.id} value={move.id}>{material?.name} · {data.extension.sites.find(site => site.id === move.siteId)?.name || 'Location'} · {dateTime(move.createdAt)} IST · {amount(returnable(move))} {material?.unit} returnable{move.reference ? ` · ${move.reference}` : ''}</option>; })}</select></Field><Field label="Return to *"><select required value={destination} onChange={event => setDestination(event.target.value)}><option value="original" disabled={!original?.active}>Original location{original ? ` · ${original.name}` : ''}</option><SiteOptions sites={sites} /></select></Field><Field label={`Quantity${item ? ` (${item.unit})` : ''} *`} hint={`Available to return: ${amount(remaining)} ${item?.unit || ''}`}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><Field label="Reason for return *" wide><textarea name="reason" required rows={3} maxLength={2000} placeholder="Why is this material being returned unused?" /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!movementId || remaining <= 0n} label="Record unused-material return" /></form>;
}

function RequestForm({ data, disabled, commit, close, report }: EditorProps) {
  const ownSite = data.extension.assignments.find(row => row.userId === data.user.userId)?.siteId;
  const sites = data.extension.sites.filter(site => site.active && site.kind === 'SITE' && (data.permissions.admin || site.id === ownSite));
  const [siteId, setSite] = useState(sites[0]?.id || '');
  const items = data.stockItems.filter(item => item.active);
  const [itemId, setItem] = useState(items[0]?.id || '');
  const item = items.find(row => row.id === itemId);
  return <form onSubmit={event => send(event, fields => ['material_request_create', { siteId, itemId, quantity: quantity(field(fields, 'quantity')), neededOn: field(fields, 'neededOn') || null, note: field(fields, 'note') }], commit, report)}><p className={styles.formIntro}>Your administrator reviews the requirement and supplies approved quantities from available stock.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Construction site *"><select value={siteId} required onChange={event => setSite(event.target.value)}><SiteOptions sites={sites} /></select></Field><Field label="Material *"><select value={itemId} required onChange={event => setItem(event.target.value)}>{items.map(row => <option key={row.id} value={row.id}>{row.name} · {row.unit}</option>)}</select></Field><Field label={`Required quantity${item ? ` (${item.unit})` : ''} *`}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><Field label="Needed on"><input name="neededOn" type="date" /></Field><Field label="Requirement details" wide><textarea name="note" maxLength={2000} rows={3} placeholder="Describe the work or stage these materials are needed for." /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!siteId || !itemId} label="Submit material request" /></form>;
}
function RequestContext({ request, data }: { request: MaterialRequest; data: AdvancedPanelProps['data'] }) {
  const item = data.stockItems.find(row => row.id === request.itemId); const site = data.extension.sites.find(row => row.id === request.siteId);
  return <div className={styles.formContext}><ClipboardList size={20} /><div><strong>{item?.name || 'Stock item'} · {amount(request.quantityMilli)} {item?.unit}</strong><p>{request.memberName} · {site?.name || 'Construction site'} · {amount(request.fulfilledMilli)} {item?.unit} supplied</p></div></div>;
}
function FulfillForm({ data, disabled, commit, close, report, request }: EditorProps & { request: MaterialRequest }) {
  const sources = data.extension.sites.filter(site => site.active && site.id !== request.siteId);
  const [fromSiteId, setFrom] = useState(sources.find(site => site.kind === 'STORE')?.id || sources[0]?.id || '');
  const item = data.stockItems.find(row => row.id === request.itemId);
  const outstanding = request.quantityMilli - request.fulfilledMilli;
  const balance = available(data, fromSiteId, request.itemId);
  return <form onSubmit={event => send(event, fields => ['material_request_fulfill', { id: request.id, fromSiteId, quantity: quantity(field(fields, 'quantity'), 'Supply quantity', BigInt(Math.min(outstanding, balance))), reference: field(fields, 'reference') }], commit, report)}><p className={styles.formIntro}>Supply all or part of the approved request. Stock transfers into the requested site when this change is saved.</p><RequestContext request={request} data={data} /><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Supply from *"><select required value={fromSiteId} onChange={event => setFrom(event.target.value)}><SiteOptions sites={sources} /></select></Field><Field label={`Quantity to supply${item ? ` (${item.unit})` : ''} *`} hint={`Requested remainder: ${amount(outstanding)}. Available at source: ${amount(balance)}.`}><input name="quantity" required inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><Field label="Delivery / issue reference" wide><input name="reference" maxLength={200} /></Field></div></fieldset><Footer disabled={disabled} close={close} unavailable={!fromSiteId || balance <= 0 || outstanding <= 0 || request.status !== 'APPROVED'} label="Supply materials" /></form>;
}

function PurchaseForm({ data, disabled, commit, close, report }: EditorProps) {
  const sites = data.extension.sites.filter(site => site.active);
  const items = data.stockItems.filter(item => item.active);
  const [lines, setLines] = useState([{ key: 0, itemId: items[0]?.id || '', quantity: '' }]);
  const nextKey = useRef(1);
  function change(index: number, update: Partial<{ itemId: string; quantity: string }>) { setLines(current => current.map((line, position) => position === index ? { ...line, ...update } : line)); }
  return <form onSubmit={event => send(event, fields => {
    const seen = new Set<string>();
    const validated = lines.map((line, index) => {
      if (!line.itemId || seen.has(line.itemId)) throw new Error('Choose each material once in the purchase order.');
      seen.add(line.itemId);
      return { itemId: line.itemId, quantity: quantity(line.quantity, `Line ${index + 1} quantity`) };
    });
    return ['purchase_order_create', { supplier: required(field(fields, 'supplier'), 'Supplier'), siteId: field(fields, 'siteId'), expectedOn: field(fields, 'expectedOn') || null, reference: field(fields, 'reference'), notes: field(fields, 'notes'), lines: validated }];
  }, commit, report)}><p className={styles.formIntro}>List the quantities to procure and the destination for deliveries. Each delivery reduces the outstanding quantities and adds stock at that location.</p><fieldset disabled={disabled}><div className={styles.formGrid}><Field label="Supplier *"><input name="supplier" required maxLength={200} placeholder="Supplier / vendor name" /></Field><Field label="Delivery location *"><select name="siteId" required defaultValue={sites.find(site => site.kind === 'STORE')?.id || sites[0]?.id}><SiteOptions sites={sites} /></select></Field><Field label="Expected delivery"><input name="expectedOn" type="date" /></Field><Field label="Supplier / purchase reference"><input name="reference" maxLength={200} /></Field></div><div className={styles.lineEditor}><div className={styles.lineHeading}><h4>Materials to order</h4><small>{lines.length} of 25 lines</small></div>{lines.map((line, index) => <div className={styles.lineFields} key={line.key}><Field label={`Material ${index + 1} *`}><select required value={line.itemId} onChange={event => change(index, { itemId: event.target.value })}>{items.map(item => <option key={item.id} value={item.id} disabled={lines.some((other, position) => position !== index && other.itemId === item.id)}>{item.name} · {item.unit}</option>)}</select></Field><Field label={`Quantity (${items.find(item => item.id === line.itemId)?.unit || 'units'}) *`}><input required value={line.quantity} onChange={event => change(index, { quantity: event.target.value })} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} /></Field><button type="button" className={styles.removeLine} aria-label={`Remove purchase line ${index + 1}`} disabled={lines.length <= 1} onClick={() => setLines(current => current.filter((_, position) => position !== index))}><X size={17} /></button></div>)}<button type="button" className={styles.textButton} disabled={lines.length >= 25 || lines.length >= items.length} onClick={() => { const item = items.find(row => !lines.some(line => line.itemId === row.id)); if (item) setLines(current => [...current, { key: nextKey.current++, itemId: item.id, quantity: '' }]); }}><Plus size={15} />Add material</button></div><Field label="Order notes"><textarea name="notes" rows={3} maxLength={2000} /></Field></fieldset><Footer disabled={disabled} close={close} unavailable={!items.length || !sites.length} label="Create purchase order" /></form>;
}
function ReceiveForm({ data, disabled, commit, close, report, order }: EditorProps & { order: PurchaseOrder }) {
  const outstanding = order.lines.filter(line => line.quantityMilli > line.receivedMilli);
  return <form onSubmit={event => send(event, fields => {
    const lines = outstanding.flatMap(line => {
      const input = field(fields, `line-${line.id}`);
      if (!input || /^0+(?:\.0{1,3})?$/.test(input)) return [];
      return [{ lineId: line.id, quantity: quantity(input, 'Delivery quantity', BigInt(line.quantityMilli - line.receivedMilli)) }];
    });
    if (!lines.length) throw new Error('Enter the quantity received for at least one material.');
    return ['purchase_order_receive', { id: order.id, lines, reference: field(fields, 'reference') }];
  }, commit, report)}><p className={styles.formIntro}>{order.number} · {order.supplier}. Enter only the quantities received in this delivery. Leave other lines blank for a later delivery.</p><div className={styles.formContext}><Truck size={20} /><div><strong>Delivery to {data.extension.sites.find(site => site.id === order.siteId)?.name || 'location'}</strong><p>Recorded quantities become available in this location’s stock.</p></div></div><fieldset disabled={disabled}><div className={styles.receiptLines}>{outstanding.map(line => {
    const item = data.stockItems.find(row => row.id === line.itemId);
    return <div key={line.id}><div><strong>{item?.name || 'Stock item'}</strong><small>Ordered {amount(line.quantityMilli)} · received {amount(line.receivedMilli)} · remaining {amount(line.quantityMilli - line.receivedMilli)} {item?.unit}</small></div><Field label={`Received now (${item?.unit || 'units'})`}><input name={`line-${line.id}`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,3})?" maxLength={30} placeholder="0" /></Field></div>;
  })}</div><Field label="Delivery note / bill reference"><input name="reference" maxLength={200} /></Field></fieldset><Footer disabled={disabled} close={close} unavailable={!outstanding.length || !['OPEN', 'PART_RECEIVED'].includes(order.status)} label="Record delivery received" /></form>;
}
