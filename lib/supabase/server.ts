import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicSupabaseConfig } from './config';
import { assertReadActive } from '../server-read';

export async function createAuthClient(options: { signal?: AbortSignal } = {}) {
  const signal = options.signal;
  assertReadActive(signal);
  const { url, key } = publicSupabaseConfig();
  const cookieStore = await cookies();
  assertReadActive(signal);
  return createServerClient(url, key, {
    ...(signal ? { global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      assertReadActive(signal);
      const existing = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetch(input, { ...init, signal: existing ? AbortSignal.any([signal, existing]) : signal });
    } } } : {}),
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(values) {
        if (signal?.aborted) return;
        try { for (const { name, value, options } of values) cookieStore.set(name, value, options); }
        catch {
          // Server Components cannot write cookies. The proxy refreshes them
          // before rendering; Route Handlers can and do persist every change.
        }
      },
    },
  });
}
