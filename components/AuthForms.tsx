'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowRight, CircleAlert, KeyRound, LoaderCircle, CheckCircle2 } from 'lucide-react';
import { parseAccountFragment, type AccountLink } from '@/lib/auth-policy';
import { accountRequest } from '@/lib/account-request';
import { SignOutButton } from './SignOutButton';
export { SignOutButton } from './SignOutButton';

function ErrorMessage({ message }: { message: string }) { return message ? <div className="auth-error" role="alert"><CircleAlert size={18} /><p>{message}</p></div> : null; }

export function LoginForm({ passwordChanged = false }: { passwordChanged?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    const fields = new FormData(event.currentTarget);
    try {
      await accountRequest('/api/auth/login', { email: fields.get('email'), password: fields.get('password') });
      window.location.replace('/');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign in.'); setBusy(false); }
  }
  return <><form className="auth-form" onSubmit={submit}>{passwordChanged && <div className="auth-note" role="status"><CheckCircle2 size={22} /><strong>Use your new password</strong><p>Your password change is complete. Sign in again to open your workspace.</p></div>}<ErrorMessage message={error} /><label className="field"><span>Work email</span><input autoComplete="username" type="email" name="email" placeholder="you@company.com" required maxLength={254} disabled={busy} /></label><label className="field"><span>Password</span><input autoComplete="current-password" type="password" name="password" placeholder="Enter your password" required maxLength={256} disabled={busy} /></label><button className="button button-primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? 'Signing in…' : 'Sign in to your workspace'}</button></form><button className="auth-help" onClick={() => setHelp(v => !v)} aria-expanded={help}>Need help signing in?</button>{help && <div className="auth-note"><strong>Ask your workspace owner</strong><p>For first-time access or a forgotten password, your owner can create a private account link in Settings → Team &amp; roles.</p></div>}<p className="auth-membership">Access is provided by your workspace owner. Use your own account on mobile or computer.</p></>;
}

export function ConfirmAccountForm() {
  const consumedFragment = useRef(false);
  const [link, setLink] = useState<AccountLink | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /* eslint-disable react-hooks/set-state-in-effect -- The one-time URL fragment is only available after hydration and is immediately removed from browser history. */
  useEffect(() => {
    if (consumedFragment.current) return;
    consumedFragment.current = true;
    const parsed = parseAccountFragment(window.location.hash);
    // Do not leave bearer credentials in history, analytics, or visible URLs.
    window.history.replaceState(null, '', '/auth/confirm');
    if (parsed) setLink(parsed);
    else setError('Open the complete private account link supplied by your workspace owner. If it has expired, ask for a new one.');
    setReady(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  async function confirm() {
    if (!link || busy) return;
    setBusy(true); setError('');
    try { await accountRequest('/api/auth/confirm', link); setLink(null); window.location.replace('/set-password'); }
    catch (e) { setError(e instanceof Error ? e.message : 'This account link could not be confirmed.'); setBusy(false); }
  }
  return <div className="auth-form"><ErrorMessage message={error} />{!ready ? <div className="auth-loading"><LoaderCircle size={23} className="spin" /><span>Checking your account link…</span></div> : link && <><div className="auth-note"><KeyRound size={24} /><strong>{link.type === 'invite' ? 'Your workspace is ready for you' : 'Choose a new password'}</strong><p>Continue to verify this private link. You will then choose the password you use to sign in.</p></div><button className="button button-primary auth-submit" disabled={busy} onClick={() => void confirm()}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? 'Verifying your link…' : 'Continue to set your password'}</button></>}<a className="auth-back" href="/login">Return to sign in</a></div>;
}

export function PasswordForm({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try { await accountRequest('/api/auth/password', { password: fields.get('password'), confirmPassword: fields.get('confirmPassword') }); setSaved(true); }
    catch (e) { setError(e instanceof Error ? e.message : 'Your password could not be saved.'); }
    finally { setBusy(false); }
  }
  return saved ? <div className="auth-form"><div className="auth-success"><CheckCircle2 size={30} /><h3>You’re ready to work.</h3><p>Your password has been saved.</p></div><Link className="button button-primary auth-submit" href="/" prefetch={false}>Open your workspace <ArrowRight size={18} /></Link></div> : <form className="auth-form" onSubmit={submit}><div className="auth-account"><span>Setting password for</span><strong>{email}</strong></div><ErrorMessage message={error} /><label className="field"><span>New password</span><input name="password" type="password" minLength={12} maxLength={128} required autoComplete="new-password" disabled={busy} /><small>Use at least 12 characters. A unique passphrase works well.</small></label><label className="field"><span>Confirm password</span><input name="confirmPassword" type="password" minLength={12} maxLength={128} required autoComplete="new-password" disabled={busy} /></label><button className="button button-primary auth-submit" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" /> : <KeyRound size={18} />}{busy ? 'Saving your password…' : 'Save password'}</button><SignOutButton /></form>;
}

