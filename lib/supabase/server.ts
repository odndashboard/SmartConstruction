import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { publicSupabaseConfig } from './config';

export async function createAuthClient() {
  const { url, key } = publicSupabaseConfig();
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
    cookies: {
      getAll() { return cookieStore.getAll(); },
      setAll(values) {
        try { for (const { name, value, options } of values) cookieStore.set(name, value, options); }
        catch {
          // Server Components cannot write cookies. The proxy refreshes them
          // before rendering; Route Handlers can and do persist every change.
        }
      },
    },
  });
}
