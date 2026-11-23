'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, Copy, KeyRound, LoaderCircle, Plus, ShieldCheck, UserRound, X } from 'lucide-react';
import type { WorkspaceData } from '@/lib/types';
import { ROLE_LABELS } from '@/lib/types';

type Mutation = (action: string, payload: Record<string, unknown>, close?: boolean) => Promise<WorkspaceData | undefined>;
export default function TeamSettings({ data, owner, busy, mutate, onUpdated }: { data: WorkspaceData; owner: boolean; busy: boolean; mutate: Mutation; onUpdated: (value: WorkspaceData) => void }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ link: string; email: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const blocked = busy || pending;

  async function createLink(payload: Record<string, unknown>) {
    if (blocked) return;
    setPending(true); setError(''); setCreated(null); setCopied(false);
    try {
      const response = await fetch('/api/team', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload) });
      const result = await response.json() as { data?: WorkspaceData; link?: string; email?: string; error?: string };
      if (!response.ok || !result.data || !result.link || !result.email) throw new Error(result.error || 'The account link could not be created. Please try again.');
      onUpdated(result.data); setCreated({ link: result.link, email: result.email }); setAdding(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); }
    finally { setPending(false); }
  }
  function addEmployee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void createLink({ action: 'add', name: fields.get('name'), email: fields.get('email'), role: fields.get('role') });
  }
  async function copyLink() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.link); setCopied(true); }
    catch { linkInput.current?.select(); setError('Select and copy the account link below.'); }
  }

  return <section className="panel team-manager">
    <div className="panel-heading"><div><span className="eyebrow">PEOPLE &amp; PERMISSIONS</span><h2>Your team</h2></div>{owner && <button className="button button-primary button-small" disabled={blocked} onClick={() => { setAdding(v => !v); setCreated(null); setError(''); }}><Plus size={16} />Add employee</button>}</div>
    <div className="settings-intro"><p>Everyone signs in with their own email and password. All active team members can view and export the shared workspace; their role controls which changes they can make.</p></div>
    {error && <div className="inline-alert error team-message" role="alert"><CircleAlert size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
    {owner && adding && <form className="team-add-form" onSubmit={addEmployee}><h3>Bring someone onto the team</h3><p>Create a private account link, then share it directly with your employee.</p><fieldset disabled={blocked}><div className="form-grid"><label className="field"><span>Employee name *</span><input name="name" autoComplete="name" required maxLength={200} placeholder="Full name" /></label><label className="field"><span>Email address *</span><input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="employee@company.com" /></label><label className="field"><span>Role</span><select name="role" defaultValue="VIEWER">{Object.entries(ROLE_LABELS).filter(([role]) => role !== 'OWNER').map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select></label></div></fieldset><div className="team-form-footer"><button type="button" className="button button-secondary button-small" onClick={() => setAdding(false)} disabled={blocked}>Cancel</button><button className="button button-primary button-small" disabled={blocked}>{pending ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}Create setup link</button></div></form>}
    {owner && created && <div className="team-account-link" role="status"><header><ShieldCheck size={20} /><div><strong>Account link ready</strong><p>Share privately with <b>{created.email}</b>. No email has been sent.</p></div><button className="icon-button" aria-label="Hide account link" onClick={() => setCreated(null)}><X size={17} /></button></header><div className="team-link-copy"><input ref={linkInput} type="text" value={created.link} readOnly aria-label="Private account setup link" autoComplete="off" spellCheck={false} /><button className="button button-secondary button-small" onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy link'}</button></div><small>This link grants access to the account, expires, and works once. The employee opens it and chooses their own password.</small></div>}
    <div className="team-members">{data.members.map(member => <article key={member.userId} className={!member.active ? 'team-member-disabled' : ''}>
      <span className="team-person-icon"><UserRound size={19} /></span><div className="team-member-identity"><strong>{member.name}{member.userId === data.user.userId && <span className="you-label">You</span>}</strong><small>{member.email}</small></div>
      <select aria-label={`Role for ${member.name}`} value={member.role} disabled={!owner || blocked || member.userId === data.user.userId} onChange={event => void mutate('member_role', { userId: member.userId, role: event.target.value }, false)}>{Object.entries(ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>
      <span className={`team-member-status${member.active ? '' : ' disabled'}`}><span />{member.active ? 'Active' : 'Disabled'}</span>
      {owner && <div className="team-member-actions"><button className="text-link" disabled={blocked || !member.active} onClick={() => void createLink({ action: 'access_link', userId: member.userId })}><KeyRound size={14} />Password link</button><button className={`text-link${member.active ? ' danger-text' : ''}`} disabled={blocked || member.userId === data.user.userId} onClick={() => { setCreated(null); void mutate('member_active', { userId: member.userId, active: !member.active }, false); }}>{member.active ? 'Disable' : 'Enable'}</button></div>}
    </article>)}</div>
    <div className="role-guide"><h3>A role for every responsibility</h3><div>{[['Owner', 'Company settings, employee access and all CRM actions.'], ['Manager', 'Sales, quotations, approval and delivery.'], ['Sales', 'Customers, leads, follow-ups and draft quotations.'], ['Operations', 'Follow-ups, work orders and milestones.'], ['Viewer', 'Read and export the workspace without making changes.']].map(([role, description]) => <p key={role}><strong>{role}</strong><span>{description}</span></p>)}</div></div>
  </section>;
}
