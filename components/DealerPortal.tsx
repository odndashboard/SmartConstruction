'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleAlert, LoaderCircle, MapPin, Plus, RefreshCw, UsersRound, X } from 'lucide-react';
import type { CreateDealerLeadRequest, DealerLead, DealerLeadInput, DealerLeadsData, DeleteDealerLeadRequest } from '@/lib/dealer-leads';
import { createDealerLead, deleteDealerLead, DealerLeadRequestError, loadDealerLeads } from '@/lib/dealer-leads-client';
import { LEAD_STAGES } from '@/lib/types';
import { WORK_LABELS } from '@/lib/work-order-status';
import { SignOutButton } from './SignOutButton';
import styles from './DealerPortal.module.css';

export type DealerPortalProps = { initialData?: DealerLeadsData | null; initialError?: string };
type LeadFields = { title: string; contact: string; phone: string; siteAddress: string; expectedKw: string };
type DealerMutation = { kind: 'create'; request: CreateDealerLeadRequest } | { kind: 'delete'; request: DeleteDealerLeadRequest; title: string };
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
  const [uncertain, setUncertain] = useState<DealerMutation | null>(null);
  const [deleting, setDeleting] = useState<DealerLead | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [filter, setFilter] = useState<'ALL' | 'OPEN' | 'WON' | 'LOST'>('ALL');
  const sending = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refreshAfterSave = useRef(false);
  const reading = useRef(false);
  const confirmation = useRef<HTMLElement | null>(null);
  const blocked = saving || !!uncertain;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (deleting) confirmation.current?.focus(); }, [deleting]);

  const refresh = useCallback(async (keepError = false) => {
    if (reading.current) return;
    reading.current = true;
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    const version = ++sequence.current; setLoading(true); if (!keepError) setError('');
    try {
      const next = await loadDealerLeads({ signal: request.signal });
      if (mounted.current && version === sequence.current && !request.signal.aborted) { setData(next); setRevoked(false); setDeleting(current => current ? next.leads.find(lead => lead.id === current.id && lead.status === 'NEW' && lead.canDelete) || null : null); }
    } catch (cause) {
      if (!mounted.current || version !== sequence.current || request.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Your leads could not be refreshed. Try again.');
      if (cause instanceof DealerLeadRequestError && cause.accessRevoked) { setData(null); setRevoked(true); setAdding(false); setDeleting(null); setUncertain(null); setMessage(''); }
    } finally { if (version === sequence.current) { reading.current = false; if (mounted.current) setLoading(false); } }
  }, []);
  useEffect(() => {
    const timer = !initialData && !initialError ? setTimeout(() => void refresh(), 0) : undefined;
    return () => clearTimeout(timer);
  }, [initialData, initialError, refresh]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      if (sending.current) refreshAfterSave.current = true;
      else void refresh(true);
    };
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [refresh]);

  async function commit(mutation: DealerMutation) {
    if (sending.current || revoked) return;
    sending.current = true; controller.current?.abort(); reading.current = false; const version = ++sequence.current; setLoading(false); setSaving(true); setError(''); setMessage('');
    try {
      const next = mutation.kind === 'create' ? await createDealerLead(mutation.request) : (await deleteDealerLead(mutation.request)).data;
      if (mounted.current && version === sequence.current) { setData(next); setUncertain(null); setAdding(false); setDeleting(null); setFilter('ALL'); setMessage(mutation.kind === 'create' ? 'Lead submitted. Its current stage will appear below.' : `“${mutation.title}” was deleted.`); }
    } catch (cause) {
      if (!mounted.current || version !== sequence.current) return;
      setError(cause instanceof Error ? cause.message : 'We could not confirm whether this change was saved.');
      if (cause instanceof DealerLeadRequestError && cause.accessRevoked) { setData(null); setRevoked(true); setUncertain(null); setAdding(false); setDeleting(null); }
      else if (!(cause instanceof DealerLeadRequestError) || cause.uncertain) setUncertain(mutation);
      else { setUncertain(null); if (mutation.kind === 'delete') { setDeleting(null); refreshAfterSave.current = true; } }
    } finally {
      sending.current = false;
      if (mounted.current) { setSaving(false); if (refreshAfterSave.current) { refreshAfterSave.current = false; void refresh(true); } }
    }
  }
  function submit(payload: DealerLeadInput) { if (!blocked && !loading && data && !revoked) void commit({ kind: 'create', request: { requestId: crypto.randomUUID(), payload } }); }
  function confirmDelete() {
    if (!blocked && !loading && data && deleting?.canDelete && deleting.status === 'NEW' && !revoked) void commit({ kind: 'delete', title: deleting.title, request: { requestId: crypto.randomUUID(), expectedRevision: data.revision, leadId: deleting.id } });
  }
  const leads = data?.leads.filter(lead => filter === 'ALL' || (filter === 'OPEN' ? !['WON', 'LOST'].includes(lead.status) : lead.status === filter)) || [];

  return <div className={styles.portal}>
    <header className={styles.header}><div><span className={styles.brand}>Smart Construction</span><strong>Dealer portal</strong></div><SignOutButton className="button button-secondary button-small" /></header>
    <main className={styles.main}>
      <section className={styles.heading}><div><span className={styles.eyebrow}>{data?.user.name || 'Your dealer account'}</span><h1>Your leads</h1><p>Add an enquiry, follow its stage and check your assigned sites.</p></div><div className={styles.headingActions}><button type="button" className="button button-secondary" disabled={loading || blocked || revoked} onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button><button type="button" className="button button-primary" disabled={!data || loading || blocked || revoked} onClick={() => { setAdding(true); setDeleting(null); setError(''); setMessage(''); }}><Plus size={17} />Add lead</button></div></section>
      {error && <div className={styles.error} role="alert"><CircleAlert size={20} /><div><strong>{uncertain ? uncertain.kind === 'delete' ? 'Deletion not yet confirmed' : 'Submission not yet confirmed' : 'Please review this message'}</strong><p>{error}</p>{uncertain ? <><p>{uncertain.kind === 'delete' ? `Retry the confirmed deletion of “${uncertain.title}” to check its result. No other enquiry will be deleted.` : 'Your entered details are kept unchanged. Retry this submission to confirm the result without creating another lead.'}</p><button type="button" className="button button-secondary button-small" disabled={saving || loading} onClick={() => void commit(uncertain)}>{saving ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}{uncertain.kind === 'delete' ? 'Retry deletion' : 'Retry submission'}</button></> : !revoked && <button type="button" className="text-link" disabled={loading || saving} onClick={() => void refresh()}>Try refreshing</button>}</div></div>}
      {message && <p className={styles.success} role="status"><Check size={17} />{message}</p>}
      {revoked ? <div className={styles.empty}><h2>Dealer access has changed</h2><p>Sign out and sign in again to continue with your current access.</p></div> : !data ? <div className={styles.empty} role="status">{loading ? <><LoaderCircle size={25} className="spin" /><p>Loading your leads…</p></> : <p>Your leads could not be loaded. Use Try refreshing to continue.</p>}</div> : <>
        {loading && <p className={styles.refreshing} role="status"><LoaderCircle size={14} className="spin" />Refreshing your leads…</p>}
        {adding && <DealerLeadForm disabled={blocked || loading} submit={submit} report={setError} close={() => { if (!blocked) setAdding(false); }} />}
        {data.assignedSites.length > 0 && data.leads.length > 0 && <a className={styles.submissionsLink} href="#dealer-submitted-leads">Your submitted leads ({data.leads.length})</a>}
        <DealerAssignments sites={data.assignedSites || []} ownLeadCount={data.leads.length} />
        {deleting && <section ref={confirmation} tabIndex={-1} className={styles.confirmDelete} role="alertdialog" aria-labelledby="dealer-delete-title" aria-describedby="dealer-delete-description"><h2 id="dealer-delete-title">Delete “{deleting.title}”?</h2><p id="dealer-delete-description">This permanently removes your new enquiry and cannot be undone. Assigned enquiries and enquiries already being worked on are protected.</p><div><button type="button" className="button button-secondary" disabled={blocked} onClick={() => setDeleting(null)}>Keep enquiry</button><button type="button" className={`button ${styles.confirmDeleteButton}`} disabled={blocked || loading} onClick={confirmDelete}>Delete lead</button></div></section>}
        <div className={styles.listHeading} id="dealer-submitted-leads"><h2>Submitted leads <span>{data.leads.length}</span></h2><label><span>Show</span><select value={filter} disabled={blocked} onChange={event => setFilter(event.target.value as typeof filter)}><option value="ALL">All your leads</option><option value="OPEN">In progress</option><option value="WON">Won</option><option value="LOST">Lost</option></select></label></div>
        {leads.length === 0 ? <div className={styles.empty}><UsersRound size={28} /><h2>{data.leads.length ? 'No leads in this stage' : 'Your first lead starts here'}</h2><p>{data.leads.length ? 'Choose another filter to see your other submissions.' : 'Use Add lead to submit an enquiry. You can follow its stage here after it is saved.'}</p></div> : <div className={styles.leads}>{leads.map(lead => <article className={styles.lead} key={lead.id}>
          <header><h3>{lead.title}</h3><span className={lead.status === 'WON' ? styles.won : lead.status === 'LOST' ? styles.lost : styles.stage}>{LEAD_STAGES.find(stage => stage.value === lead.status)?.label || lead.status}</span></header>
          <p className={styles.progress}><ArrowRight size={14} />{STAGE_DETAILS[lead.status]}</p>
          {(lead.contact || lead.phone) && <div className={styles.contact}>{lead.contact && <strong>{lead.contact}</strong>}{lead.phone && <span>{lead.phone}</span>}</div>}
          {lead.siteAddress && <p className={styles.address}><MapPin size={14} /><span>{lead.siteAddress}</span></p>}
          {lead.expectedKw !== null && lead.expectedKw !== undefined && <p className={styles.capacity}>Expected capacity <strong>{lead.expectedKw} kW</strong></p>}
          <button type="button" className={styles.deleteButton} disabled={!lead.canDelete || lead.status !== 'NEW' || blocked || loading} aria-label={`Delete lead: ${lead.title}`} aria-describedby={!lead.canDelete || lead.status !== 'NEW' ? `dealer-delete-reason-${lead.id}` : undefined} onClick={lead.canDelete && lead.status === 'NEW' ? () => { setDeleting(lead); setAdding(false); setError(''); setMessage(''); } : undefined}>Delete lead</button>
          {(!lead.canDelete || lead.status !== 'NEW') && <p id={`dealer-delete-reason-${lead.id}`} className={styles.protected}>Unavailable: {lead.deleteBlockedReason || 'Only your untouched new enquiries can be deleted.'}</p>}
          <footer><span>Submitted {dateLabel(lead.createdAt)}</span><span>Updated {dateLabel(lead.updatedAt)}</span></footer>
        </article>)}</div>}
      </>}
    </main>
  </div>;
}

function DealerAssignments({ sites, ownLeadCount }: { sites: DealerLeadsData['assignedSites']; ownLeadCount: number }) {
  return <section className={styles.assignments} aria-labelledby="dealer-sites-title"><div className={styles.listHeading}><h2 id="dealer-sites-title">Assigned sites <span>{sites.length}</span></h2></div><p className={styles.assignmentHint}>Sites assigned to you by the team. These are separate from the enquiries you submit.</p>
    {sites.length > 0 && <p className={styles.assignmentHint}>{ownLeadCount > 0 ? 'Use Delete lead in Submitted leads for your eligible new enquiries.' : 'You have no submitted leads to delete.'} For a lead you did not submit, contact Admin to review its removal.</p>}
    {sites.length === 0 ? <p className={styles.noAssignments}>No sites are assigned to you yet.</p> : <div className={styles.leads}>{sites.map(site => <article className={styles.lead} key={site.id}><header><h3>{site.title}</h3>{(site.workOrderStatus || site.leadStatus) && <span className={styles.stage}>{site.workOrderStatus ? WORK_LABELS[site.workOrderStatus] : LEAD_STAGES.find(stage => stage.value === site.leadStatus)?.label}</span>}</header>
      {site.workOrderNumber && <p className={styles.progress}>{site.workOrderNumber}</p>}
      {site.siteName && site.siteName !== site.title && <p className={styles.contact}>{site.siteName}</p>}
      {site.siteAddress && <p className={styles.address}><MapPin size={14} /><span>{site.siteAddress}</span></p>}
      {site.expectedKw != null && <p className={styles.capacity}>Expected capacity <strong>{site.expectedKw} kW</strong></p>}
      {site.totalMilestones > 0 && <p className={styles.progress}>{site.completedMilestones} of {site.totalMilestones} milestones completed</p>}
      <p className={styles.assignmentKind}>{site.assignedVia.map(via => via === 'WORK_ORDER' ? 'Work order assignment' : via === 'LEAD' ? 'Lead assignment' : 'Site assignment').join(' · ')}</p>
    </article>)}</div>}
  </section>;
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
