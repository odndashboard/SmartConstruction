import { getTeamActivity } from '../../../lib/operations-server';
import { PRIVATE_HEADERS } from '../../../lib/auth-http';
import { errorResponse } from '../../../lib/server';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    return Response.json(await getTeamActivity(new URL(request.url).searchParams), { headers: PRIVATE_HEADERS });
  } catch (error) { return errorResponse(error); }
}
