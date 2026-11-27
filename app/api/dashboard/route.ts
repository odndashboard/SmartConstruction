import { getInitialWorkspace } from '../../../lib/initial-workspace';
import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { errorResponse } from '../../../lib/server';
import { createReadTiming, serverTiming } from '../../../lib/server-read';
import { paymentResponse } from '../../../lib/payment-response';

export const dynamic = 'force-dynamic';

/** A dashboard refresh verifies one identity before reading both current snapshots. */
export async function GET(request: Request) {
  const timing = createReadTiming();
  let response: Response;
  try {
    const data = await getInitialWorkspace({ signal: request.signal, timing });
    response = Response.json({ ...data, operations: data.operations && paymentResponse(request, data.operations) }, { headers: PRIVATE_HEADERS });
  } catch (error) { response = errorResponse(error); }
  response.headers.set('Server-Timing', serverTiming(timing));
  return response;
}
