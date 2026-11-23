'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, CircleAlert, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react';
import { changePasswordSchema } from '@/lib/password-policy';
import { SignOutButton } from './AuthForms';
import styles from './AccountSecurity.module.css';

export default function AccountSecurity({ email, owner }: { email: string; owner: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<{ message: string; redirect?: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const parsed = changePasswordSchema.safeParse({ currentPassword: fields.get('currentPassword'), password: fields.get('password'), confirmPassword: fields.get('confirmPassword') });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || 'Check the password fields.'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/change-password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data), cache: 'no-store' });
      const result = await response.json() as { error?: string; saved?: boolean; message?: string; redirect?: string };
      if (!response.ok || !result.saved) throw new Error(result.error || 'Your password could not be changed. Please try again.');
      form.reset();
      setSaved({ message: result.message || 'Your password has been changed.', redirect: result.redirect === '/login?password=updated' ? result.redirect : undefined });
      if (result.redirect === '/login?password=updated') window.location.replace(result.redirect);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Your password could not be changed. Please try again.'); }
    finally { setBusy(false); }
  }

  return <section className={`panel settings-panel ${styles.root}`}>
    <div className="panel-heading"><div><span className="eyebrow">YOUR ACCOUNT</span><h2>Account security</h2></div><ShieldCheck size={24} aria-hidden="true" /></div>
    <p className="settings-intro">Change the password for <strong>{email}</strong>. Enter your current password to confirm it is you. You will sign in again after saving.</p>
    {saved ? <div className={styles.result} role="status"><CheckCircle2 size={30} /><h3>Password changed</h3><p>{saved.message}</p>{saved.redirect ? <a className="button button-primary" href={saved.redirect}>Sign in with your new password</a> : <SignOutButton className="button button-secondary" />}</div> : <form onSubmit={submit}>
      {error && <div className="inline-alert error" role="alert"><CircleAlert size={18} /><span>{error}</span></div>}
      <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
      <fieldset disabled={busy}>
        <label className="field"><span>Current password</span><input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} /></label>
        <div className="form-grid">
          <label className="field"><span>New password</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /><small>Use 12–128 characters. Choose a password you do not use elsewhere.</small></label>
          <label className="field"><span>Confirm new password</span><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
        </div>
      </fieldset>
      <div className="settings-form-footer"><span><ShieldCheck size={16} />Only your own password changes here.</span><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />}{busy ? 'Changing password…' : 'Change password'}</button></div>
    </form>}
    <div className={styles.recovery}><h3>{owner ? 'Help an employee recover access' : 'Forgotten password'}</h3><p>{owner ? 'Open Team & roles, choose Reset password next to an active employee, and share the generated private link directly with that person. They choose their own new password. No email is sent automatically.' : 'Ask your workspace owner for a private reset link. Open the link, confirm it, and choose a new password.'}</p></div>
  </section>;
}
