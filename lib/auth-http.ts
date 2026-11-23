import 'server-only';
import { z } from 'zod';
import { CRMError } from './server-actions';
import { appOrigin } from './supabase/config';
import { sameWorkspaceOrigin } from './auth-policy';

export const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0', Expires: '0', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' };

export function assertSameOrigin(request: Request): void {
  if (!sameWorkspaceOrigin(request.headers.get('origin'), request.url, appOrigin(), request.headers.get('sec-fetch-site'))) throw new CRMError('Submit this request from your workspace.', 403);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CRMError('Send this request as application/json.', 415);
}

export async function readAuthInput<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  assertSameOrigin(request);
  if (Number(request.headers.get('content-length') || 0) > 16_384) throw new CRMError('This request is too large.', 413);
  if (!request.body) throw new CRMError('The request body is missing.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '', length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new CRMError('This request is too large.', 413); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof CRMError) throw error;
    throw new CRMError('The request contains invalid text.');
  } finally { reader.releaseLock(); }
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new CRMError('This request is not valid JSON.'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CRMError(parsed.error.issues[0]?.message || 'Check the submitted details.');
  return parsed.data;
}

export function authResponse(body: unknown, status = 200): Response { return Response.json(body, { status, headers: PRIVATE_HEADERS }); }
export function authError(error: unknown): Response {
  if (error instanceof CRMError) return authResponse({ error: error.message }, error.status);
  // Do not log request bodies, email addresses, passwords, or account links.
  console.error('Account request failed', { category: error instanceof Error ? error.name : 'UnknownError' });
  return authResponse({ error: 'Your request could not be completed. Please try again.' }, 500);
}

export function databaseError(code?: string): CRMError {
  if (code === 'PT403' || code === '42501') return new CRMError('You do not have permission to manage this account.', 403);
  if (code === 'PT404') return new CRMError('The team member was not found.', 404);
  if (code === 'PT409' || code === '23505') return new CRMError('Team access changed. Refresh the workspace and try again.', 409);
  if (code === 'PT400') return new CRMError('Check the team member details and try again.');
  return new CRMError('Team access could not be updated. Please try again.', 503);
}
