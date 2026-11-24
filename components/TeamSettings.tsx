'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronDown, CircleAlert, Copy, KeyRound, LoaderCircle, Plus, RotateCcw, ShieldCheck, UserRound, UserRoundMinus, X } from 'lucide-react';
import type { Member, WorkspaceData } from '@/lib/types';
import { ROLE_LABELS } from '@/lib/types';

type Mutation = (action: string, payload: Record<string, unknown>, close?: boolean) => Promise<WorkspaceData | undefined>;
export default function TeamSettings({ data, owner, busy, mutate, onUpdated }: { data: WorkspaceData; owner: boolean; busy: boolean; mutate: Mutation; onUpdated: (value: WorkspaceData) => void }) {
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ link: string; email: string; name: string; reset: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [changingMemberId, setChangingMemberId] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const removedAccountsId = useId();
  const blocked = busy || pending || changingMemberId !== null;
  const activeMembers = data.members.filter(member => member.active);
  const removedMembers = data.members.filter(member => !member.active);
  const activeOwners = activeMembers.filter(member => member.role === 'OWNER').length;

  async function createLink(payload: Record<string, unknown>) {
    if (!owner || blocked) return;
    setPending(true); setError(''); setCreated(null); setCopied(false);
    try {
      const response = await fetch('/api/team', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(payload) });
      const result = await response.json() as { data?: WorkspaceData; link?: string; email?: string; error?: string };
      if (!response.ok || !result.data || !result.link || !result.email) throw new Error(result.error || 'The account link could not be created. Please try again.');
      const email = result.email;
      const member = result.data.members.find(account => account.email.toLowerCase() === email.toLowerCase());
      onUpdated(result.data); setCreated({ link: result.link, email, name: member?.name || email, reset: payload.action === 'access_link' }); setAdding(false);
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
  async function changeMemberAccess(member: Member, active: boolean) {
    if (!owner || blocked || member.userId === data.user.userId) return;
    setChangingMemberId(member.userId); setError(''); setCreated(null);
    try {
      const updated = await mutate('member_active', { userId: member.userId, active }, false);
      if (updated) {
        setRemovingId(null);
        if (!active) setShowRemoved(false);
      }
    } catch {
      setError('Team access could not be updated. Please try again.');
    } finally { setChangingMemberId(null); }
  }

  return <section className="panel team-manager">
    <div className="panel-heading"><div><span className="eyebrow">PEOPLE &amp; PERMISSIONS</span><h2>Your team</h2></div>{owner && <button className="button button-primary button-small" disabled={blocked} onClick={() => { setAdding(v => !v); setRemovingId(null); setCreated(null); setError(''); }}><Plus size={16} />Add employee</button>}</div>
    <div className="settings-intro"><p>Everyone signs in with their own email and password. Team members can view shared CRM and stock records. Employees see only their own attendance and expenses; the Owner sees company-wide records, reviews team activity and approves expenses. Viewer accounts cannot make changes.</p></div>
    {error && <div className="inline-alert error team-message" role="alert"><CircleAlert size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
    {owner && adding && <form className="team-add-form" onSubmit={addEmployee}><h3>Bring someone onto the team</h3><p>Create a private account link, then share it directly with your employee.</p><fieldset disabled={blocked}><div className="form-grid"><label className="field"><span>Employee name *</span><input name="name" autoComplete="name" required maxLength={200} placeholder="Full name" /></label><label className="field"><span>Email address *</span><input name="email" type="email" autoComplete="email" required maxLength={254} placeholder="employee@company.com" /></label><label className="field"><span>Role</span><select name="role" defaultValue="VIEWER">{Object.entries(ROLE_LABELS).filter(([role]) => role !== 'OWNER').map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select></label></div></fieldset><div className="team-form-footer"><button type="button" className="button button-secondary button-small" onClick={() => setAdding(false)} disabled={blocked}>Cancel</button><button className="button button-primary button-small" disabled={blocked}>{pending ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}Create setup link</button></div></form>}
    {owner && created && activeMembers.some(member => member.email.toLowerCase() === created.email.toLowerCase()) && <div className="team-account-link" role="status"><header><ShieldCheck size={20} /><div><strong>{created.reset ? 'Password reset link ready' : 'Account setup link ready'}</strong><p>Share privately with <b>{created.name}</b> at <b>{created.email}</b>. No email has been sent.</p></div><button className="icon-button" aria-label="Hide account link" onClick={() => setCreated(null)}><X size={17} /></button></header><div className="team-link-copy"><input ref={linkInput} type="text" value={created.link} readOnly aria-label={created.reset ? 'Private password reset link' : 'Private account setup link'} autoComplete="off" spellCheck={false} /><button className="button button-secondary button-small" onClick={() => void copyLink()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Copied' : 'Copy link'}</button></div><small>This private link expires and can be used once. {created.name} should open it, confirm the account, and choose a password. If it expires, create a fresh link for this account.</small></div>}
    <div className="team-members">{activeMembers.map(member => <article key={member.userId}>
      <span className="team-person-icon"><UserRound size={19} /></span><div className="team-member-identity"><strong>{member.name}{member.userId === data.user.userId && <span className="you-label">You</span>}</strong><small>{member.email}</small></div>
      <select aria-label={`Role for ${member.name}`} value={member.role} disabled={!owner || blocked || member.userId === data.user.userId} onChange={event => void mutate('member_role', { userId: member.userId, role: event.target.value }, false)}>{Object.entries(ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select>
      <span className="team-member-status"><span />Active</span>
      {owner && <div className="team-member-actions">{member.userId === data.user.userId ? <span className="team-self-access-note">Change your password in Account security.</span> : <><button className="text-link" disabled={blocked} aria-label={`Reset password for ${member.name}`} onClick={() => { setRemovingId(null); void createLink({ action: 'access_link', userId: member.userId }); }}><KeyRound size={14} />Reset password</button><button className="text-link danger-text" disabled={blocked || (member.role === 'OWNER' && activeOwners <= 1)} aria-expanded={removingId === member.userId} aria-controls={`remove-member-${member.userId}`} aria-label={`Remove ${member.name}`} onClick={() => { setRemovingId(member.userId); setAdding(false); setCreated(null); setError(''); }}><UserRoundMinus size={14} />Remove</button></>}</div>}
      {owner && removingId === member.userId && member.userId !== data.user.userId && <div className="team-remove-confirmation" id={`remove-member-${member.userId}`} role="group" aria-labelledby={`remove-member-title-${member.userId}`}>
        <div><strong id={`remove-member-title-${member.userId}`}>Remove {member.name} from your team?</strong><p><b>{member.email}</b> will lose CRM access immediately. Existing work and activity history will be retained. You can restore access from Removed accounts.</p></div>
        <div className="team-remove-confirmation-actions"><button className="button button-secondary button-small" disabled={blocked} onClick={() => setRemovingId(null)}>Cancel</button><button className="button button-danger button-small" disabled={blocked || (member.role === 'OWNER' && activeOwners <= 1)} onClick={() => void changeMemberAccess(member, false)}>{changingMemberId === member.userId ? <LoaderCircle className="spin" size={16} /> : <UserRoundMinus size={16} />}{changingMemberId === member.userId ? 'Removing…' : 'Remove access'}</button></div>
      </div>}
    </article>)}</div>
    {owner && removedMembers.length > 0 && <div className="team-removed-section">
      <button className="team-removed-toggle" aria-expanded={showRemoved} aria-controls={removedAccountsId} onClick={() => setShowRemoved(value => !value)}><span>Removed accounts <span className="count-pill">{removedMembers.length}</span></span><ChevronDown size={17} /></button>
      {showRemoved && <div id={removedAccountsId} className="team-removed-list"><p>These accounts cannot access the CRM. Restoring access keeps their previous role.</p><div className="team-members">{removedMembers.map(member => <article key={member.userId} className="team-member-disabled">
        <span className="team-person-icon"><UserRound size={19} /></span><div className="team-member-identity"><strong>{member.name}</strong><small>{member.email}</small></div>
        <span className="team-member-role">{ROLE_LABELS[member.role]}</span><span className="team-member-status disabled"><span />Removed</span>
        <div className="team-member-actions"><button className="text-link" disabled={blocked || member.userId === data.user.userId} aria-label={`Restore access for ${member.name}`} onClick={() => void changeMemberAccess(member, true)}>{changingMemberId === member.userId ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}{changingMemberId === member.userId ? 'Restoring…' : 'Restore access'}</button></div>
      </article>)}</div></div>}
    </div>}
    <div className="role-guide"><h3>A role for every responsibility</h3><div>{[['Owner', 'Administrator access: lead status, company settings, employee access, team attendance, private activity history, all expenses and final expense approval.'], ['Manager', 'Sales, lead status, quotation approval and delivery. Stock entries, own attendance and own expenses.'], ['Sales', 'Lead details, follow-ups and draft quotations. Stock entries, own attendance and own expenses. Lead status is managed by the Owner or Manager.'], ['Operations', 'Delivery workflow, stock entries, own attendance and own expenses.'], ['Accountant', 'Read and export CRM records. Stock entries, own attendance and own expenses with receipts. Company expense totals, payments and final approvals remain with the Owner.'], ['Viewer', 'Read and export permitted records. Attendance and expenses stay limited to their own account.']].map(([role, description]) => <p key={role}><strong>{role}</strong><span>{description}</span></p>)}</div></div>
  </section>;
}
