'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, LoaderCircle, MapPin, Plus, RefreshCw, UsersRound, X } from 'lucide-react';
import type { CreateDealerLeadRequest, DealerLead, DealerLeadInput, DealerLeadsData } from '@/lib/dealer-leads';
import { createDealerLead, DealerLeadRequestError, loadDealerLeads } from '@/lib/dealer-leads-client';
import { LEAD_STAGES } from '@/lib/types';
import { SignOutButton } from './SignOutButton';
import styles from './DealerPortal.module.css';

export type DealerPortalProps = { initialData?: DealerLeadsData | null; initialError?: string };
type LeadFields = { title: string; contact: string; phone: string; siteAddress: string; expectedKw: string };
const STAGE_DETAILS: Record<DealerLead['status'], string> = {
  NEW: 'Submitted for review', CONTACTED: 'Contact stage', SITE_VISIT: 'Site visit stage',
  QUOTED: 'Quotation stage', NEGOTIATION: 'Under discussion', WON: 'Lead confirmed', LOST: 'Lead closed',
};
function dateLabel(value: string): string { return new Date(value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }); }
function dealerLeadPayload(fields: LeadFields): DealerLeadInput {
  if (!fields.title.trim()) throw new Error('Enter the project or lead name.');
  const raw = fields.expectedKw.trim();
  const expectedKw = raw === '' ? null : Number(raw);
  if (raw && (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(expectedKw) || expectedKw! < 0)) throw new Error('Expected kW must be a finite, nonnegative number.');
  return { title: fields.title.trim(), contact: fields.contact.trim(), phone: fields.phone.trim(), siteAddress: fields.siteAddress.trim(), expectedKw };
}

export default function DealerPortal({ initialData = null, initialError = '' }: DealerPortalProps) {
  const [data, setData] = useState<DealerLeadsData | null>(initialData);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(!initialData && !initialError);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [uncertain, setUncertain] = useState<CreateDealerLeadRequest | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'WON' | 'LOST'>('ALL');
  const sending = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const blocked = saving || !!uncertain;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);

  const refresh = useCallback(async () => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const version = ++sequence.current; setLoading(true); setError('');
    try {
      const next = await loadDealerLeads({ signal: request.signal });
      if (mounted.current && version === sequence.current && !request.signal.aborted) { setData(next); setRevoked(false); }
    } catch (cause) {
      if (!mounted.current || version !== sequence.current || request.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Your leads could not be refreshed. Try again.');
      if (cause instanceof DealerLeadRequestError && cause.accessRevoked) { setData(null); setRevoked(true); }
    } finally { if (mounted.current && version === sequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = !initialData && !initialError ? setTimeout(() => void refresh(), 0) : undefined;
    return () => clearTimeout(timer);
  }, [initialData, initialError, refresh]);

  async function commit(request: CreateDealerLeadRequest) {
    if (sending.current || revoked) return;
    sending.current = true; controller.current?.abort(); ++sequence.current; setLoading(false); setSaving(true); setError(''); setMessage('');
    try {
      const next = await createDealerLead(request);
      if (mounted.current) { setData(next); setUncertain(null); setAdding(false); setFilter('ALL'); setMessage('Lead submitted. Its current stage will appear below.'); }
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'We could not confirm whether the lead was saved.');
      if (cause instanceof DealerLeadRequestError && cause.accessRevoked) { setData(null); setRevoked(true); setUncertain(null); }
      else if (!(cause instanceof DealerLeadRequestError) || cause.uncertain) setUncertain(request);
      else setUncertain(null);
    } finally { sending.current = false; if (mounted.current) setSaving(false); }
  }
  function submit(payload: DealerLeadInput) { if (!blocked && data && !revoked) void commit({ requestId: crypto.randomUUID(), payload }); }
  const leads = data?.leads.filter(lead => filter === 'ALL' || (filter === 'OPEN' ? !['WON', 'LOST'].includes(lead.status) : lead.status === filter)) || [];

  return <div className={styles.portal}>
    <header className={styles.header}><div><span className={styles.brand}>Smart Construction</span><strong>Dealer portal</strong></div><SignOutButton className="button button-secondary button-small" /></header>
    <main className={styles.main}>
      <section className={styles.heading}><div><span className={styles.eyebrow}>{data?.user.name || 'Your dealer account'}</span><h1>Your leads</h1><p>Add an enquiry and follow its current stage.</p></div><div className={styles.headingActions}><button type="button" className="button button-secondary" disabled={loading || blocked || revoked} onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button><button type="button" className="button button-primary" disabled={!data || blocked || revoked} onClick={() => { setAdding(true); setError(''); setMessage(''); }}><Plus size={17} />Add lead</button></div></section>
      {error && <div className={styles.error} role="alert"><CircleAlert size={20} /><div><strong>{uncertain ? 'Submission not yet confirmed' : 'Please review this message'}</strong><p>{error}</p>{uncertain ? <><p>Your entered details are kept unchanged. Retry this submission to confirm the result without creating another lead.</p><button type="button" className="button button-secondary button-small" disabled={saving} onClick={() => void commit(uncertain)}>{saving ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}Retry submission</button></> : !revoked && <button type="button" className="text-link" disabled={loading || saving} onClick={() => void refresh()}>Try refreshing</button>}</div></div>}
      {message && <p className={styles.success} role="status"><Check size={17} />{message}</p>}
      {revoked ? <div className={styles.empty}><h2>Dealer access has changed</h2><p>Sign out and sign in again to continue with your current access.</p></div> : !data ? <div className={styles.empty} role="status">{loading ? <><LoaderCircle size={25} className="spin" /><p>Loading your leads…</p></> : <p>Your leads could not be loaded. Use Try refreshing to continue.</p>}</div> : <>
        {loading && <p className={styles.refreshing} role="status"><LoaderCircle size={14} className="spin" />Refreshing your leads…</p>}
        {adding && <DealerLeadForm disabled={blocked} submit={submit} report={setError} close={() => { if (!blocked) setAdding(false); }} />}
        <div className={styles.listHeading}><h2>Submitted leads <span>{data.leads.length}</span></h2><label><span>Show</span><select value={filter} disabled={blocked} onChange={event => setFilter(event.target.value as typeof filter)}><option value="ALL">All your leads</option><option value="OPEN">In progress</option><option value="WON">Won</option><option value="LOST">Lost</option></select></label></div>
        {leads.length === 0 ? <div className={styles.empty}><UsersRound size={28} /><h2>{data.leads.length ? 'No leads in this stage' : 'Your first lead starts here'}</h2><p>{data.leads.length ? 'Choose another filter to see your other submissions.' : 'Use Add lead to submit an enquiry. You can follow its stage here after it is saved.'}</p></div> : <div className={styles.leads}>{leads.map(lead => <article className={styles.lead} key={lead.id}>
          <header><h3>{lead.title}</h3><span className={lead.status === 'WON' ? styles.won : lead.status === 'LOST' ? styles.lost : styles.stage}>{LEAD_STAGES.find(stage => stage.value === lead.status)?.label || lead.status}</span></header>
          <p className={styles.progress}><ArrowRight size={14} />{STAGE_DETAILS[lead.status]}</p>
          {(lead.contact || lead.phone) && <div className={styles.contact}>{lead.contact && <strong>{lead.contact}</strong>}{lead.phone && <span>{lead.phone}</span>}</div>}
          {lead.siteAddress && <p className={styles.address}><MapPin size={14} /><span>{lead.siteAddress}</span></p>}
          {lead.expectedKw !== null && lead.expectedKw !== undefined && <p className={styles.capacity}>Expected capacity <strong>{lead.expectedKw} kW</strong></p>}
          <footer><span>Submitted {dateLabel(lead.createdAt)}</span><span>Updated {dateLabel(lead.updatedAt)}</span></footer>
        </article>)}</div>}
      </>}
    </main>
  </div>;
}

function DealerLeadForm({ disabled, submit, close, report }: { disabled: boolean; submit: (payload: DealerLeadInput) => void; close: () => void; report: (message: string) => void }) {
  const [fields, setFields] = useState<LeadFields>({ title: '', contact: '', phone: '', siteAddress: '', expectedKw: '' });
  const change = (key: keyof LeadFields, value: string) => setFields(current => ({ ...current, [key]: value }));
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return;
    try { submit(dealerLeadPayload(fields)); }
    catch (cause) { report(cause instanceof Error ? cause.message : 'Review the lead details.'); }
  }
  return <form className={styles.form} onSubmit={save} aria-label="Add lead"><header><div><h2>Add lead</h2><p>Enter the project and contact details you have.</p></div><button type="button" className="icon-button" aria-label="Close Add lead" disabled={disabled} onClick={close}><X size={19} /></button></header><fieldset disabled={disabled}>
    <label className={styles.wide}><span>Project / lead name *</span><input name="title" required maxLength={200} value={fields.title} onChange={event => change('title', event.target.value)} placeholder="Project or customer enquiry" /></label>
    <label><span>Contact person</span><input name="contact" maxLength={200} value={fields.contact} onChange={event => change('contact', event.target.value)} /></label>
    <label><span>Phone number</span><input name="phone" type="tel" maxLength={40} value={fields.phone} onChange={event => change('phone', event.target.value)} /></label>
    <label><span>Expected kW (optional)</span><input name="expectedKw" type="number" inputMode="decimal" min="0" step="any" value={fields.expectedKw} onChange={event => change('expectedKw', event.target.value)} /></label>
    <label className={styles.wide}><span>Project site address</span><textarea name="siteAddress" rows={3} maxLength={2000} value={fields.siteAddress} onChange={event => change('siteAddress', event.target.value)} /></label>
  </fieldset><footer><button type="button" className="button button-secondary" disabled={disabled} onClick={close}>Cancel</button><button type="submit" className="button button-primary" disabled={disabled}>{disabled ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}Submit lead</button></footer></form>;
}
