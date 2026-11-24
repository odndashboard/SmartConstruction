import { getWorkspace, mutateWorkspace, errorResponse } from '../../../lib/server';
import { createReadTiming, serverTiming } from '../../../lib/server-read';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const timing = createReadTiming();
  let response: Response;
  try { response = Response.json(await getWorkspace(false, { signal: request.signal, timing }), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { response = errorResponse(error); }
  response.headers.set('Server-Timing', serverTiming(timing));
  return response;
}
export async function POST(request: Request) {
  try { return Response.json(await mutateWorkspace(request), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}
