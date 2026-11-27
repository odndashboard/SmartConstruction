'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, LoaderCircle, Package, Plus } from 'lucide-react';
import type { AdvancedPanelProps, JobMaterialEntry } from '@/lib/operations-extensions';
import type { QuoteItemCategory, WorkOrder } from '@/lib/types';
import { REQUIRED_QUOTE_CATEGORIES } from '@/lib/quotation-categories';
import styles from './JobMaterials.module.css';

export type JobMaterialsProps = AdvancedPanelProps & { order: WorkOrder };
type JobAction = 'job_material_issue' | 'job_filing_complete';
type Commit = (action: JobAction, payload: Record<string, unknown>) => Promise<void>;

function quantityLabel(value: bigint | number | string): string {
  const amount = BigInt(value);
  const fraction = String(amount % 1000n).padStart(3, '0').replace(/0+$/, '');
  return `${(amount / 1000n).toLocaleString('en-IN')}${fraction ? `.${fraction}` : ''}`;
}
function quantityInput(value: number): string {
  const amount = BigInt(value);
  return `${amount / 1000n}.${String(amount % 1000n).padStart(3, '0')}`;
}
function recordedAt(value: string): string {
  return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}
function netQuantity(entry: JobMaterialEntry): bigint {
  return BigInt(entry.quantityMilli ?? 0) - BigInt(entry.returnedMilli);
}
function canRecordJobMaterials(data: AdvancedPanelProps['data'], order: WorkOrder): boolean {
  return data.user.active && data.permissions.canWrite && ['OWNER', 'MANAGER', 'OPERATIONS'].includes(data.user.role)
    && order.status === 'ACTIVE' && !order.isDemo;
}
function materialIssuePayload(data: AdvancedPanelProps['data'], order: WorkOrder, category: QuoteItemCategory, itemId: string, siteId: string, quantity: string): Record<string, unknown> {
  if (!canRecordJobMaterials(data, order)) throw new Error('Material use can be recorded only for an In progress job by an authorised team member.');
  if (!REQUIRED_QUOTE_CATEGORIES.includes(category)) throw new Error('Choose a job category.');
  const item = data.stockItems.find(row => row.id === itemId && row.active);
  if (!item) throw new Error('Choose the exact active stock item being used.');
  const site = data.extension.sites.find(row => row.id === siteId && row.active);
  if (!site) throw new Error('Choose an active source location.');
  const clean = quantity.trim();
  if (clean.length > 30 || !/^\d+(?:\.\d{1,3})?$/.test(clean)) throw new Error('Enter the actual quantity with up to three decimal places.');
  const [whole, fraction = ''] = clean.split('.');
  const amount = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (amount <= 0n) throw new Error('The quantity must be greater than zero.');
  const available = data.extension.siteBalances.find(row => row.itemId === item.id && row.siteId === site.id)?.quantityMilli ?? 0;
  if (amount > BigInt(available)) throw new Error(`Only ${quantityLabel(available)} ${item.unit} is available at ${site.name}.`);
  return { workOrderId: order.id, category, itemId: item.id, siteId: site.id, quantity: clean };
}
function usageSummary(entries: JobMaterialEntry[], data: AdvancedPanelProps['data']): { itemId: string; name: string; unit: string; quantity: bigint }[] {
  const totals = new Map<string, { itemId: string; name: string; unit: string; quantity: bigint }>();
  for (const entry of entries) {
    if (!entry.itemId || !entry.movementId) continue;
    const item = data.stockItems.find(row => row.id === entry.itemId);
    const existing = totals.get(entry.itemId);
    if (existing) existing.quantity += netQuantity(entry);
    else totals.set(entry.itemId, { itemId: entry.itemId, name: item?.name || 'Stock item unavailable', unit: item?.unit || '(unit unavailable)', quantity: netQuantity(entry) });
  }
  return [...totals.values()];
}

export default function JobMaterials({ data, order, blocked, save }: JobMaterialsProps) {
  const [editing, setEditing] = useState<QuoteItemCategory | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const entries = (data.extension.jobMaterialEntries ?? []).filter(entry => entry.workOrderId === order.id);
  const editable = canRecordJobMaterials(data, order);
  const disabled = blocked || pending;
  const filingDone = entries.some(entry => entry.category === 'Filing' && entry.movementId === null);
  const recorded = REQUIRED_QUOTE_CATEGORIES.filter(category => category === 'Filing' ? filingDone : entries.some(entry => entry.category === category && netQuantity(entry) > 0n)).length;

  async function commit(action: JobAction, payload: Record<string, unknown>) {
    if (!editable || blocked || sending.current || (action === 'job_filing_complete' && filingDone)) return;
    sending.current = true; setPending(true); setError('');
    try {
      const saved = await save(action, payload);
      if (mounted.current) {
        if (saved) setEditing(null);
        else setError('This entry has not been confirmed. Review the workspace message before trying again.');
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'This entry could not be saved. Try again.');
    } finally {
      sending.current = false;
      if (mounted.current) setPending(false);
    }
  }

  if (order.status === 'CANCELLED' && entries.length === 0) return <p className={styles.empty}>No recorded job activity.</p>;

  return <div className={styles.workspace}>
    <div className={styles.intro}><Package size={22} /><div><h3>Job materials &amp; filing</h3><p>{recorded} of 9 categories recorded. Save actual material use as the work progresses.</p></div></div>
    <p className={styles.note}>Quantities follow the stock item’s unit. Saving the quantity used deducts it from the selected location. The quotation shows the planned quantity.</p>
    {!editable && <p className={styles.readOnly}>{order.isDemo ? 'Example work orders do not use real stock.' : order.status === 'PLANNED' ? 'Set the work order to In progress to record material use or complete Filing.' : order.status !== 'ACTIVE' ? 'This work order is read-only. Recorded material use and returns remain visible.' : 'The Owner, Manager or Operations team can record material use and complete Filing.'}</p>}
    {error && <div className={styles.error} role="alert"><CircleAlert size={18} /><p>{error}</p></div>}
    <div className={styles.categories}>{REQUIRED_QUOTE_CATEGORIES.map(category => {
      const history = entries.filter(entry => entry.category === category).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
      const usage = usageSummary(history, data);
      const planned = order.snapshot?.items.find(item => item.category === category);
      const hasUse = usage.some(row => row.quantity > 0n);
      const complete = category === 'Filing' ? filingDone : hasUse;
      return <section className={styles.category} key={category} aria-label={category}>
        <header><h4>{category}</h4><span className={complete ? styles.recorded : styles.needed}>{category === 'Filing' ? filingDone ? 'Completed' : 'Required' : hasUse ? 'Usage recorded' : history.length > 0 ? 'Fully returned' : 'Required'}</span></header>
        {planned && <div className={styles.planned}><strong>Quotation reference</strong><p>{planned.description}</p><span>{planned.quantity} {planned.unit}</span></div>}
        {usage.length > 0 ? <ul className={styles.balances}>{usage.map(row => <li key={row.itemId}><span>{row.name}</span><strong>{quantityLabel(row.quantity)} {row.unit} net used</strong></li>)}</ul> : <p className={styles.empty}>{category === 'Filing' && filingDone ? 'Filing completion recorded.' : 'No material use recorded.'}</p>}
        {history.length > 0 && <details className={styles.history}><summary>View history ({history.length})</summary><ol>{history.map(entry => {
          const item = data.stockItems.find(row => row.id === entry.itemId);
          const site = data.extension.sites.find(row => row.id === entry.siteId);
          return <li key={entry.id}><strong>{entry.movementId ? item?.name || 'Stock item unavailable' : 'Filing completed'}</strong>{entry.movementId && <p>{quantityLabel(entry.quantityMilli ?? 0)} {item?.unit || '(unit unavailable)'} used from {site?.name || 'Location unavailable'}{BigInt(entry.returnedMilli) > 0n && ` · ${quantityLabel(entry.returnedMilli)} returned · ${quantityLabel(netQuantity(entry))} net used`}</p>}<small>{entry.actorName} · {recordedAt(entry.createdAt)}</small></li>;
        })}</ol></details>}
        {editable && <div className={styles.actions}>
          <button type="button" className="button button-secondary button-small" disabled={disabled} onClick={() => { setError(''); setEditing(category); }}><Plus size={15} />{hasUse ? 'Record more use' : 'Record material use'}</button>
          {category === 'Filing' && !filingDone && <button type="button" className="button button-primary button-small" disabled={disabled} onClick={() => void commit('job_filing_complete', { workOrderId: order.id })}><Check size={15} />Complete Filing without stock</button>}
        </div>}
        {editable && editing === category && <MaterialIssueForm key={`${order.id}-${category}`} data={data} order={order} category={category} disabled={disabled} commit={commit} close={() => { if (!disabled) setEditing(null); }} report={setError} />}
      </section>;
    })}</div>
  </div>;
}

function MaterialIssueForm({ data, order, category, disabled, commit, close, report }: Pick<JobMaterialsProps, 'data' | 'order'> & { category: QuoteItemCategory; disabled: boolean; commit: Commit; close: () => void; report: (message: string) => void }) {
  const [itemId, setItemId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [quantity, setQuantity] = useState('');
  const items = data.stockItems.filter(item => item.active);
  const sites = data.extension.sites.filter(site => site.active);
  const item = items.find(row => row.id === itemId);
  const available = data.extension.siteBalances.find(row => row.itemId === itemId && row.siteId === siteId)?.quantityMilli ?? 0;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    try { void commit('job_material_issue', materialIssuePayload(data, order, category, itemId, siteId, quantity)); }
    catch (cause) { report(cause instanceof Error ? cause.message : 'Check the material details.'); }
  }
  return <form className={styles.form} onSubmit={submit} aria-label={`Record ${category} material use`}>
    <fieldset disabled={disabled}>
      <legend>Record {category} material use</legend>
      <label><span>Stock item *</span><select name="itemId" value={itemId} required onChange={event => { setItemId(event.target.value); setSiteId(''); setQuantity(''); }}><option value="">Choose the exact stock item</option>{items.map(row => <option key={row.id} value={row.id}>{row.name}{row.sku ? ` · ${row.sku}` : ''} ({row.unit})</option>)}</select></label>
      <label><span>Source location *</span><select name="siteId" value={siteId} required disabled={!item} onChange={event => setSiteId(event.target.value)}><option value="">Choose source location</option>{sites.map(site => {
        const balance = data.extension.siteBalances.find(row => row.itemId === itemId && row.siteId === site.id)?.quantityMilli ?? 0;
        return <option key={site.id} value={site.id} disabled={!item || balance <= 0}>{site.name}{item ? ` · ${quantityLabel(balance)} ${item.unit} available` : ''}</option>;
      })}</select></label>
      <label><span>Actual quantity{item ? ` (${item.unit})` : ''} *</span><input name="quantity" type="number" inputMode="decimal" min="0.001" step="0.001" max={quantityInput(available)} value={quantity} required disabled={!item || !siteId || available <= 0} onChange={event => setQuantity(event.target.value)} /></label>
      {item && siteId && <p className={styles.availability}>{quantityLabel(available)} {item.unit} available at the selected source.</p>}
      {(!items.length || !sites.length) && <p className={styles.note}>Add active stock items and source locations in Stock before recording material use.</p>}
    </fieldset>
    <div className={styles.formActions}><button type="button" className="button button-secondary button-small" disabled={disabled} onClick={close}>Cancel</button><button type="submit" className="button button-primary button-small" disabled={disabled || !item || !siteId || available <= 0 || !quantity.trim()}>{disabled ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Save material use</button></div>
  </form>;
}
