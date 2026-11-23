'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import { Check, FileImage, FileText, LoaderCircle, Paperclip, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import type { Expense } from '@/lib/operations-types';
import type { ExpenseReceipt } from '@/lib/operations-extensions';
import { RECEIPT_MAX_BYTES, RECEIPT_MAX_COUNT } from '@/lib/receipt-policy';
import styles from './ExpenseReceipts.module.css';

type Props = {
  expense: Expense; receipts: ExpenseReceipt[]; canEdit: boolean; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onChanged: () => Promise<void>;
};
type Pending = { file: File; requestId: string };
const noSubscription = () => () => {};
function needsAndroidUpdate() { const version = /SmartConstructionAndroid\/(\d+)\.(\d+)/.exec(navigator.userAgent); return !!version && Number(version[1]) === 1 && Number(version[2]) < 1; }

export default function ExpenseReceipts({ expense, receipts, canEdit, disabled, onBusyChange, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const oldAndroid = useSyncExternalStore(noSubscription, needsAndroidUpdate, () => false);

  async function upload(attempt: Pending) {
    if (sending.current || disabled) return;
    sending.current = true; setBusy(true); onBusyChange(true); setError(''); setNotice('');
    try {
      const form = new FormData(); form.append('file', attempt.file); form.append('expenseId', expense.id); form.append('requestId', attempt.requestId);
      const response = await fetch('/api/expense-receipts', { method: 'POST', credentials: 'same-origin', body: form });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) await onChanged();
        throw new Error(result.error || 'The upload could not be confirmed. Retry the same file.');
      }
      setPending(null); if (picker.current) picker.current.value = '';
      await onChanged(); setNotice('Receipt attached.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The upload could not be confirmed. Retry the same file.'); }
    finally { sending.current = false; setBusy(false); onBusyChange(false); }
  }
  async function remove(id: string) {
    if (sending.current || disabled) return;
    sending.current = true; setBusy(true); onBusyChange(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/expense-receipts/${id}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json() as { error?: string };
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) await onChanged();
        throw new Error(result.error || 'Removal could not be confirmed. Try again.');
      }
      await onChanged(); setRemoveId(null); setNotice('Receipt removed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Removal could not be confirmed. Try again.'); }
    finally { sending.current = false; setBusy(false); onBusyChange(false); }
  }

  return <section className={styles.receipts} aria-label={`Receipts for ${expense.title}`} aria-busy={busy}>
    <div className={styles.heading}><span><Paperclip size={14} />Receipts <small>{receipts.length}/{RECEIPT_MAX_COUNT}</small></span>{canEdit && receipts.length < RECEIPT_MAX_COUNT && <>
      <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" className={styles.picker} aria-label={`Choose a receipt for ${expense.title}`} disabled={disabled || busy || !!pending || oldAndroid} onChange={event => {
        const file = event.target.files?.[0]; if (!file) return;
        if (!file.size || file.size > RECEIPT_MAX_BYTES) { setError('Choose a JPG, PNG, WebP or PDF receipt up to 3 MB.'); event.target.value = ''; return; }
        const attempt = { file, requestId: crypto.randomUUID() }; setPending(attempt); void upload(attempt);
      }} />
      <button type="button" disabled={disabled || busy || !!pending || oldAndroid} onClick={() => picker.current?.click()}><Upload size={13} />Attach receipt</button>
    </>}</div>
    {oldAndroid && canEdit && <p className={styles.help}>Receipt uploads need Android app 1.1 or later. Use the app menu’s Open in browser option, or install the latest app update.</p>}
    {!receipts.length && <p className={styles.help}>No receipt attached.{canEdit ? ' JPG, PNG, WebP or PDF · up to 3 MB each.' : ''}</p>}
    {receipts.map(receipt => <div className={styles.file} key={receipt.id}>
      <div className={styles.fileHeading}>{receipt.mimeType === 'application/pdf' ? <FileText size={17} /> : <FileImage size={17} />}<div><strong>{receipt.fileName}</strong><small>{(receipt.sizeBytes / 1024).toFixed(0)} KB</small></div><a href={`/api/expense-receipts/${receipt.id}`} download={receipt.fileName}>Download</a>{canEdit && <button type="button" disabled={disabled || busy} aria-label={`Remove ${receipt.fileName}`} onClick={() => { setRemoveId(receipt.id); setError(''); }}><Trash2 size={14} /></button>}</div>
      {receipt.mimeType !== 'application/pdf' && <details className={styles.preview}><summary>Preview image</summary><Image unoptimized src={`/api/expense-receipts/${receipt.id}`} alt={`Receipt: ${receipt.fileName}`} width={800} height={1000} /></details>}
      {removeId === receipt.id && <div className={styles.confirm}><span>Remove this receipt from the expense?</span><button disabled={disabled || busy} onClick={() => void remove(receipt.id)}><Trash2 size={12} />Remove</button><button disabled={busy} onClick={() => setRemoveId(null)}><X size={12} />Cancel</button></div>}
    </div>)}
    {busy && <p className={styles.progress} role="status"><LoaderCircle size={14} className="spin" />Saving the receipt…</p>}
    {error && <div className={styles.error} role="alert"><span>{error}</span>{pending && <button disabled={busy || disabled} onClick={() => void upload(pending)}><RefreshCw size={13} />Retry same upload</button>}</div>}
    {pending && !busy && <p className={styles.help}>If the upload was interrupted, retrying the same file will avoid duplicates. <button onClick={() => { setPending(null); setError(''); if (picker.current) picker.current.value = ''; }}>Choose another file</button></p>}
    {notice && <p className={styles.success} role="status"><Check size={13} />{notice}</p>}
  </section>;
}
