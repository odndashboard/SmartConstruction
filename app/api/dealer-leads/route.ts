import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { CRMError } from '../../../lib/server-actions';
import { createReadTiming, serverTiming } from '../../../lib/server-read';
import { getDealerLeads, createDealerLead } from '../../../lib/dealer-leads-server';

export const dynamic = 'force-dynamic';
function dealerError(error: unknown): Response {
  if (error instanceof CRMError) return Response.json({ error: error.message }, { status: error.status, headers: PRIVATE_HEADERS });
  console.error('Dealer lead request failed', { category: error instanceof Error ? error.name : 'UnknownError' });
  return Response.json({ error: 'Your lead request could not be completed. Please try again.' }, { status: 500, headers: PRIVATE_HEADERS });
}
export async function GET(request: Request): Promise<Response> {
  const timing = createReadTiming(); let response: Response;
  try {
    if (new URL(request.url).searchParams.size) throw new CRMError('This page only shows your own submitted leads.');
    response = Response.json(await getDealerLeads({ signal: request.signal, timing }), { headers: PRIVATE_HEADERS });
  } catch (error) { response = dealerError(error); }
  response.headers.set('Server-Timing', serverTiming(timing));
  return response;
}
export async function POST(request: Request): Promise<Response> {
  try { return Response.json(await createDealerLead(request), { headers: PRIVATE_HEADERS }); }
  catch (error) { return dealerError(error); }
}
