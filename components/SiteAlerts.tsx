'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Bell, Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { WorkOrder, WorkspaceData } from '@/lib/types';
import { ROLE_LABELS } from '@/lib/types';
import { SITE_ALERT_ROLES, canResolveSiteAlert, type SiteAlert, type SiteAlertsData, type CreateSiteAlertPayload } from '@/lib/site-alerts';
import { AlertRequestError, loadAlerts, saveAlert } from '@/lib/site-alerts-client';
import styles from './SiteAlerts.module.css';

export type SiteAlertsProps = {
  workspace: WorkspaceData; search?: string; order?: WorkOrder;
  onReported?: () => void; onBusyChange?: (busy: boolean) => void;
  onAccessError?: (message: string, status?: number) => void;
  onOpenWorkOrder?: (id: string) => void;
};
type AlertWrite = Parameters<typeof saveAlert>[0];
type ReportFields = { workOrderId: string; mode: 'catalogue' | 'named'; itemId: string; itemName: string; assigneeId: string; quantity: string; unit: string; note: string };
const STAFF_ROLES: readonly string[] = SITE_ALERT_ROLES;

function canUseAlerts(workspace: WorkspaceData): boolean { return workspace.user.active && STAFF_ROLES.includes(workspace.user.role); }
function canResolveAlert(data: SiteAlertsData, alert: SiteAlert): boolean {
  return canResolveSiteAlert(data.user, alert);
}
function when(value: string): string { return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }); }
function quantityLabel(value: number, unit: string): string {
  const amount = BigInt(value); const fraction = String(amount % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${(amount / 1000n).toLocaleString('en-IN')}${fraction ? `.${fraction}` : ''} ${unit}`;
}
function reportPayload(data: SiteAlertsData, fields: ReportFields): CreateSiteAlertPayload {
  if (!data.workOrders.some(order => order.id === fields.workOrderId)) throw new Error('Choose an In progress work order.');
  if (!data.assignees.some(member => member.userId === fields.assigneeId && STAFF_ROLES.includes(member.role))) throw new Error('Assign this alert to an active team member.');
  const stock = data.stockItems.find(item => item.id === fields.itemId);
  const payload: CreateSiteAlertPayload = { workOrderId: fields.workOrderId, assigneeId: fields.assigneeId, note: fields.note.trim() };
  if (fields.mode === 'catalogue') {
    if (!stock) throw new Error('Choose the stock item, or enter the missing item by name.');
    payload.itemId = stock.id;
  } else {
    if (!fields.itemName.trim()) throw new Error('Enter the missing item name.');
    payload.itemName = fields.itemName.trim();
  }
  const quantity = fields.quantity.trim();
  const unit = fields.mode === 'catalogue' ? stock?.unit || '' : fields.unit.trim();
  if (quantity) {
    if (quantity.length > 30 || !/^\d+(?:\.\d{1,3})?$/.test(quantity)) throw new Error('Enter a quantity with up to three decimal places.');
    const [whole, fraction = ''] = quantity.split('.');
    const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
    if (scaled <= 0n || scaled > 9_000_000_000_000n) throw new Error('Enter a positive quantity within the supported limit.');
    if (!unit) throw new Error('Enter the unit for the requested quantity.');
    payload.quantity = quantity; payload.unit = unit;
  } else if (fields.mode === 'named' && unit) throw new Error('Enter a quantity with the unit, or leave both blank.');
  return payload;
}

export default function SiteAlerts(props: SiteAlertsProps) {
  if (!canUseAlerts(props.workspace)) return <div className={styles.access}><ShieldCheck size={26} /><h3>Team access required</h3><p>This account does not have access to site alerts.</p></div>;
  return <AlertsWorkspace key={`${props.workspace.user.userId}-${props.order?.id || 'all'}`} {...props} />;
}

function AlertsWorkspace({ workspace, search = '', order, onReported, onBusyChange, onAccessError, onOpenWorkOrder }: SiteAlertsProps) {
  const [data, setData] = useState<SiteAlertsData | null>(null);
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const [workOrderId, setWorkOrderId] = useState(order?.id || '');
  const [paging, setPaging] = useState({ page: 1, search: '' });
  const [composing, setComposing] = useState(!!order);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState<AlertWrite | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revoked, setRevoked] = useState(false);
  const readVersion = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onReported, onBusyChange, onAccessError });
  useEffect(() => { callbacks.current = { onReported, onBusyChange, onAccessError }; }, [onReported, onBusyChange, onAccessError]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); callbacks.current.onBusyChange?.(false); }; }, []);
  useEffect(() => { callbacks.current.onBusyChange?.(saving || !!uncertain); }, [saving, uncertain]);
  const page = paging.search === search ? paging.page : 1;
  const blocked = saving || !!uncertain;
  const query = { ...(workOrderId ? { workOrderId } : {}), status, page, ...(search.trim() ? { search: search.trim() } : {}) };

  const refresh = useCallback(async (clearError = true) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const version = ++readVersion.current;
    setLoading(true); if (clearError) setError('');
    try {
      const next = await loadAlerts({ ...(workOrderId ? { workOrderId } : {}), status, page, ...(search.trim() ? { search: search.trim() } : {}) }, { signal: request.signal });
      if (mounted.current && version === readVersion.current && !request.signal.aborted) { setData(next); setRevoked(false); }
    } catch (cause) {
      if (!mounted.current || version !== readVersion.current || request.signal.aborted) return;
      const text = cause instanceof Error ? cause.message : 'Alerts could not be loaded. Try again.';
      setError(text);
      if (cause instanceof AlertRequestError && cause.accessRevoked) { setData(null); setRevoked(true); callbacks.current.onAccessError?.(text, cause.status); }
    } finally {
      if (mounted.current && version === readVersion.current) setLoading(false);
    }
  }, [workOrderId, status, page, search]);
  useEffect(() => {
    const timer = !saving && !uncertain && !revoked ? setTimeout(() => void refresh(false), search.trim() ? 200 : 0) : undefined;
    return () => { clearTimeout(timer); controller.current?.abort(); };
  }, [refresh, saving, uncertain, revoked, search]);

  async function commit(request: AlertWrite) {
    if (sending.current || revoked) return;
    sending.current = true; controller.current?.abort(); ++readVersion.current; setLoading(false); setSaving(true); setError(''); setMessage('');
    try {
      const result = await saveAlert(request);
      if (!mounted.current) return;
      setData(result.data); setUncertain(null); setMessage(result.message);
      if (request.action === 'material_alert_create') { setComposing(false); setStatus('OPEN'); setPaging({ page: 1, search }); callbacks.current.onReported?.(); }
    } catch (cause) {
      if (!mounted.current) return;
      const text = cause instanceof Error ? cause.message : 'The alert change could not be confirmed.';
      setError(text);
      if (cause instanceof AlertRequestError && cause.accessRevoked) { setData(null); setRevoked(true); setUncertain(null); callbacks.current.onAccessError?.(text, cause.status); }
      else if (!(cause instanceof AlertRequestError) || cause.uncertain) setUncertain(request);
      else setUncertain(null);
    } finally {
      sending.current = false; if (mounted.current) setSaving(false);
    }
  }
  function create(payload: CreateSiteAlertPayload) {
    if (!data || blocked) return;
    void commit({ action: 'material_alert_create', payload, expectedRevision: data.revision, requestId: crypto.randomUUID(), query: { ...query, status: 'OPEN', page: 1 } });
  }
  function resolve(alert: SiteAlert) {
    if (!data || blocked || !canResolveAlert(data, alert)) return;
    void commit({ action: 'material_alert_resolve', payload: { id: alert.id }, expectedRevision: data.revision, requestId: crypto.randomUUID(), query });
  }
  const workOrders = workspace.workorders.filter(item => !item.isDemo);

  return <div className={styles.workspace}>
    {!order && <header className={styles.headingActions}><button type="button" className="button button-secondary button-small" disabled={loading || blocked || revoked} onClick={() => void refresh()}><RefreshCw size={15} />Refresh</button><button type="button" className="button button-primary button-small" disabled={!data || blocked || revoked} onClick={() => { setComposing(true); setError(''); setMessage(''); }}><Plus size={15} />Report missing item</button></header>}
    {error && <div className={styles.error} role="alert"><CircleAlert size={19} /><div><strong>{uncertain ? 'Save not yet confirmed' : 'Please review this alert'}</strong><p>{error}</p>{uncertain ? <><p>Your report is kept unchanged. Retry this same save to confirm the result without creating a duplicate.</p><button type="button" className="button button-secondary button-small" disabled={saving} onClick={() => void commit(uncertain)}>{saving ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}Retry save</button></> : !revoked && <button type="button" className="text-link" disabled={loading || saving} onClick={() => void refresh()}>Refresh alerts</button>}</div></div>}
    {message && <p className={styles.success} role="status"><Check size={16} />{message}</p>}
    {revoked ? <p className={styles.empty}>Alert access is no longer available for this account.</p> : !data ? <div className={styles.empty} role="status">{loading ? <><LoaderCircle className="spin" size={24} /><p>Loading alerts and available team members…</p></> : <><Bell size={24} /><p>Alerts are unavailable. Use Refresh alerts to try again.</p></>}</div> : <>
      {loading && <p className={styles.refreshing} role="status"><LoaderCircle size={14} className="spin" />Refreshing alerts…</p>}
      {composing && <AlertReportForm key={order?.id || 'new-alert'} data={data} order={order} disabled={blocked} report={setError} submit={create} close={order ? undefined : () => { if (!blocked) setComposing(false); }} />}
      {!order && <>
        <div className={styles.filters}><div className={styles.tabs} aria-label="Alert status"><button type="button" aria-pressed={status === 'OPEN'} disabled={blocked} onClick={() => { setStatus('OPEN'); setPaging({ page: 1, search }); }}>Open <span>{data.openCount}</span></button><button type="button" aria-pressed={status === 'RESOLVED'} disabled={blocked} onClick={() => { setStatus('RESOLVED'); setPaging({ page: 1, search }); }}>Resolved <span>{data.resolvedCount}</span></button></div><label><span>Work order</span><select value={workOrderId} disabled={blocked} onChange={event => { setWorkOrderId(event.target.value); setPaging({ page: 1, search }); }}><option value="">All work orders</option>{workOrders.map(item => <option key={item.id} value={item.id}>{item.number} · {item.title}</option>)}</select></label></div>
        {data.alerts.length === 0 ? <div className={styles.empty}><Bell size={26} /><h3>{search.trim() ? 'No matching alerts' : status === 'OPEN' ? 'No open alerts' : 'No resolved alerts'}</h3><p>{search.trim() ? 'Try another search or work-order filter.' : status === 'OPEN' ? 'Report a missing item from an In progress work order and assign it to a team member.' : 'Resolved reports will remain here with their reporter and resolution details.'}</p></div> : <div className={styles.list}>{data.alerts.map(alert => <article key={alert.id} className={styles.card}>
          <header><div><span className={alert.status === 'OPEN' ? styles.open : styles.resolved}>{alert.status === 'OPEN' ? 'Open' : 'Resolved'}</span><h3>{alert.itemName}</h3></div>{alert.quantityMilli !== null && <strong className={styles.quantity}>{quantityLabel(alert.quantityMilli, alert.unit)}</strong>}</header>
          <button type="button" className={styles.orderLink} disabled={!onOpenWorkOrder || blocked} onClick={() => onOpenWorkOrder?.(alert.workOrderId)}>{alert.workOrderNumber} · {alert.workOrderTitle}{onOpenWorkOrder && <ArrowRight size={14} />}</button>
          {alert.siteAddress && <p className={styles.site}>{alert.siteAddress}</p>}
          <dl className={styles.people}><div><dt>Assigned to</dt><dd>{alert.assigneeName}</dd></div><div><dt>Reported by</dt><dd>{alert.reportedByName}</dd></div></dl>
          {alert.note && <p className={styles.note}>{alert.note}</p>}
          <footer><div><small>Reported {when(alert.createdAt)}</small>{alert.status === 'RESOLVED' && alert.resolvedAt && <small>Resolved by {alert.resolvedByName || 'Team member'} · {when(alert.resolvedAt)}</small>}</div>{canResolveAlert(data, alert) && <button type="button" className="button button-secondary button-small" disabled={blocked} onClick={() => resolve(alert)}><Check size={15} />Mark resolved</button>}</footer>
        </article>)}</div>}
        {data.total > data.pageSize && <nav className={styles.pagination} aria-label="Alerts pages"><button type="button" className="button button-secondary button-small" disabled={blocked || loading || page <= 1} onClick={() => setPaging({ page: page - 1, search })}><ChevronLeft size={16} />Previous</button><span>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button type="button" className="button button-secondary button-small" disabled={blocked || loading || page * data.pageSize >= data.total} onClick={() => setPaging({ page: page + 1, search })}>Next<ChevronRight size={16} /></button></nav>}
      </>}
    </>}
  </div>;
}

function AlertReportForm({ data, order, disabled, submit, close, report }: { data: SiteAlertsData; order?: WorkOrder; disabled: boolean; submit: (payload: CreateSiteAlertPayload) => void; close?: () => void; report: (message: string) => void }) {
  const [workOrderId, setWorkOrderId] = useState(order?.id || '');
  const [mode, setMode] = useState<'catalogue' | 'named'>(data.stockItems.length ? 'catalogue' : 'named');
  const [itemId, setItemId] = useState('');
  const [itemName, setItemName] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const stock = data.stockItems.find(item => item.id === itemId);
  const eligible = !order || data.workOrders.some(item => item.id === order.id);
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    try { submit(reportPayload(data, { workOrderId, mode, itemId, itemName, assigneeId, quantity, unit, note })); }
    catch (cause) { report(cause instanceof Error ? cause.message : 'Review the alert details.'); }
  }
  return <form className={styles.form} onSubmit={save} aria-label="Report missing item">
    <header><div><h3>Report missing item</h3><p>Choose an item or enter its name, then assign someone to follow it up.</p></div>{close && <button type="button" className="icon-button" aria-label="Close report form" disabled={disabled} onClick={close}><X size={18} /></button>}</header>
    {!eligible || !data.workOrders.length ? <p className={styles.empty}>Missing items can be reported for real work orders that are In progress.</p> : <>
      <fieldset disabled={disabled}>
        {order ? <div className={styles.context}><strong>{order.number} · {order.title}</strong>{order.siteAddress && <p>{order.siteAddress}</p>}</div> : <label><span>Work order *</span><select name="workOrderId" required value={workOrderId} onChange={event => setWorkOrderId(event.target.value)}><option value="">Choose an In progress work order</option>{data.workOrders.map(item => <option key={item.id} value={item.id}>{item.number} · {item.title}</option>)}</select></label>}
        <div className={styles.mode}><label><input type="radio" name="itemMode" value="catalogue" checked={mode === 'catalogue'} disabled={!data.stockItems.length} onChange={() => { setMode('catalogue'); setQuantity(''); setUnit(''); }} />Choose from stock list</label><label><input type="radio" name="itemMode" value="named" checked={mode === 'named'} onChange={() => { setMode('named'); setQuantity(''); setUnit(''); }} />Enter missing item name</label></div>
        {!data.stockItems.length && <p className={styles.hint}>The stock list is empty. You can still report the missing item by name.</p>}
        {mode === 'catalogue' ? <label><span>Stock item *</span><select name="itemId" required value={itemId} onChange={event => { setItemId(event.target.value); setQuantity(''); }}><option value="">Choose the exact item</option>{data.stockItems.map(item => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}</select></label> : <label><span>Missing item name *</span><input name="itemName" required maxLength={200} value={itemName} placeholder="Describe the missing item" onChange={event => setItemName(event.target.value)} /></label>}
        <label><span>Assign to *</span><select name="assigneeId" required value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">Choose an active team member</option>{data.assignees.filter(member => STAFF_ROLES.includes(member.role)).map(member => <option key={member.userId} value={member.userId}>{member.name} · {ROLE_LABELS[member.role]}</option>)}</select></label>
        <div className={styles.amounts}><label><span>Quantity needed (optional)</span><input name="quantity" type="number" min="0.001" step="0.001" inputMode="decimal" value={quantity} onChange={event => setQuantity(event.target.value)} /></label><label><span>Unit{mode === 'named' ? ' (with quantity)' : ''}</span><input name="unit" maxLength={24} readOnly={mode === 'catalogue'} value={mode === 'catalogue' ? stock?.unit || '' : unit} placeholder={mode === 'named' ? 'e.g. nos, m, kg' : 'From selected item'} onChange={event => setUnit(event.target.value)} /></label></div>
        <label><span>Notes (optional)</span><textarea name="note" rows={3} maxLength={2000} value={note} placeholder="What is needed at the site, and any useful details" onChange={event => setNote(event.target.value)} /></label>
        {!data.assignees.length && <p className={styles.hint}>An active team member must be available before this report can be assigned.</p>}
        <p className={styles.hint}>Reporting or resolving an alert does not change stock quantities.</p>
      </fieldset>
      <footer>{close && <button type="button" className="button button-secondary" disabled={disabled} onClick={close}>Cancel</button>}<button type="submit" className="button button-primary" disabled={disabled || !data.assignees.length}>{disabled ? <LoaderCircle size={16} className="spin" /> : <Bell size={16} />}Report missing item</button></footer>
    </>}
  </form>;
}
