import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isPublicSupabaseKey } from './lib/auth-policy';

/** Refresh cookies without caching private responses or authorizing from cookies. */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  const preventCaching = () => {
    response.headers.set('Cache-Control', 'private, no-cache, no-store, must-revalidate, max-age=0');
    response.headers.set('Expires', '0');
    response.headers.set('Pragma', 'no-cache');
  };
  preventCaching();
  if (!url || !key || !isPublicSupabaseKey(key)) return response;

  const client = createServerClient(url, key, {
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, cacheHeaders) {
        for (const { name, value } of values) request.cookies.set(name, value);
        const priorCookies = response.cookies.getAll();
        response = NextResponse.next({ request });
        for (const cookie of priorCookies) response.cookies.set(cookie);
        for (const { name, value, options } of values) response.cookies.set(name, value, options);
        for (const [name, value] of Object.entries(cacheHeaders)) response.headers.set(name, value);
        preventCaching();
      },
    },
  });
  // Renew the session with verified claims (usually local signature validation).
  // Claims never authorize CRM data: protected pages and APIs still obtain a
  // fresh Auth user and the database checks current membership and permissions.
  await client.auth.getClaims();
  // Return the same response carrying all refreshed cookies. Each protected
  // handler separately verifies the user and active database membership.
  return response;
}

// Route Handlers refresh cookies and verify the current user themselves. Running
// this proxy for APIs would add a second serial Auth request to every refresh.
// Pages keep the proxy because Server Components cannot persist renewed cookies.
export const config = { matcher: ['/', '/dealer', '/login', '/set-password', '/auth/:path*'] };
