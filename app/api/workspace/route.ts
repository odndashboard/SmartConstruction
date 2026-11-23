import { getWorkspace, mutateWorkspace, errorResponse } from '../../../lib/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return Response.json(await getWorkspace(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try { return Response.json(await mutateWorkspace(request), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}
