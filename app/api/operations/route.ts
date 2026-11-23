import { getOperations, mutateOperations } from '../../../lib/operations-server';
import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { errorResponse } from '../../../lib/server';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const data = await getOperations(new URL(request.url).searchParams.get('month'));
    return Response.json(data, { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try { return Response.json(await mutateOperations(request), { headers: PRIVATE_HEADERS }); }
  catch (error) { return errorResponse(error); }
}
