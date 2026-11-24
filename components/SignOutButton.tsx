'use client';

import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { accountRequest } from '@/lib/account-request';

export function SignOutButton({ className = 'auth-back' }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    if (busy) return; setBusy(true); setError('');
    try { await accountRequest('/api/auth/logout', {}); window.location.replace('/login'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); setBusy(false); }
  }
  return <><button type="button" className={className} disabled={busy} onClick={() => void logout()}><LogOut size={17} />{busy ? 'Signing out…' : 'Sign out'}</button>{error && <span role="alert" className="danger-text">{error}</span>}</>;
}
