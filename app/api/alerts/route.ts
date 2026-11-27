import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { CRMError } from '../../../lib/server-actions';
import { createReadTiming, serverTiming } from '../../../lib/server-read';
import { AlertAccessError, getSiteAlerts, mutateSiteAlerts } from '../../../lib/site-alerts-server';

export const dynamic = 'force-dynamic';
function alertError(error: unknown): Response {
  if (error instanceof CRMError) return Response.json({ error: error.message, accessRevoked: error instanceof AlertAccessError || error.status === 401 }, { status: error.status, headers: PRIVATE_HEADERS });
  console.error('Alerts request failed', { category: error instanceof Error ? error.name : 'UnknownError' });
  return Response.json({ error: 'The alerts request could not be completed. Please try again.', accessRevoked: false }, { status: 500, headers: PRIVATE_HEADERS });
}
export async function GET(request: Request): Promise<Response> {
  const timing = createReadTiming();
  let response: Response;
  try { response = Response.json(await getSiteAlerts(new URL(request.url).searchParams, { signal: request.signal, timing }), { headers: PRIVATE_HEADERS }); }
  catch (error) { response = alertError(error); }
  response.headers.set('Server-Timing', serverTiming(timing));
  return response;
}
export async function POST(request: Request): Promise<Response> {
  try { return Response.json(await mutateSiteAlerts(request), { headers: PRIVATE_HEADERS }); }
  catch (error) { return alertError(error); }
}
