import { getOperations, mutateOperations } from '../../../lib/operations-server';
import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { errorResponse } from '../../../lib/server';
import { createReadTiming, serverTiming } from '../../../lib/server-read';
import { paymentResponse } from '../../../lib/payment-response';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const timing = createReadTiming();
  let response: Response;
  try {
    const data = await getOperations(new URL(request.url).searchParams.get('month'), { signal: request.signal, timing });
    response = Response.json(paymentResponse(request, data), { headers: PRIVATE_HEADERS });
  } catch (error) { response = errorResponse(error); }
  response.headers.set('Server-Timing', serverTiming(timing));
  return response;
}

export async function POST(request: Request) {
  try {
    const result = await mutateOperations(request);
    return Response.json({ ...result, data: paymentResponse(request, result.data) }, { headers: PRIVATE_HEADERS });
  }
  catch (error) { return errorResponse(error); }
}
