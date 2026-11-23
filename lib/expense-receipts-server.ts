import 'server-only';
import { createHash } from 'node:crypto';
import { authenticate } from './auth';
import { sameWorkspaceOrigin } from './auth-policy';
import { PRIVATE_HEADERS, readAuthInput } from './auth-http';
import { appOrigin } from './supabase/config';
import { createAdminClient } from './supabase/admin';
import { CRMError } from './server-actions';
import { operationsRpc } from './operations-server';
import { receiptIdSchema, receiptIdentitySchema } from './operations-extensions-validation';
import { inspectReceipt, receiptFileName, receiptContentDisposition, RECEIPT_MAX_BYTES, ReceiptValidationError } from './receipt-policy';
import { finishReceiptUpload, type ReceiptReservation } from './receipt-workflow';
import type { ExpenseReceipt } from './operations-extensions';
import { z } from 'zod';

const BUCKET = 'crm-expense-receipts';
function validatedId(input: string): string {
  const parsed = receiptIdSchema.safeParse(input);
  if (!parsed.success) throw new CRMError('Choose a valid receipt.');
  return parsed.data;
}
function checkStoredPath(value: { bucket: string; objectPath: string }) {
  if (value.bucket !== BUCKET || !/^expenses\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(value.objectPath)) {
    throw new CRMError('Receipt storage is unavailable. Please try again.', 503);
  }
}
async function multipart(request: Request): Promise<FormData> {
  if (!sameWorkspaceOrigin(request.headers.get('origin'), request.url, appOrigin(), request.headers.get('sec-fetch-site'))) throw new CRMError('Upload this receipt from your workspace.', 403);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) throw new CRMError('Choose a receipt file to upload.', 415);
  const limit = RECEIPT_MAX_BYTES + 65_536;
  if (Number(request.headers.get('content-length') || 0) > limit) throw new CRMError('The receipt is too large. Choose a file up to 3 MB.', 413);
  if (!request.body) throw new CRMError('The receipt file is missing.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CRMError('The receipt is too large. Choose a file up to 3 MB.', 413); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  try { return await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData(); }
  catch { throw new CRMError('The upload could not be read. Choose the receipt file again.'); }
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export async function uploadExpenseReceipt(request: Request): Promise<ExpenseReceipt> {
  const identity = await authenticate();
  const fields = await multipart(request);
  const allowed = ['file', 'expenseId', 'requestId'];
  if ([...fields.keys()].some(key => !allowed.includes(key)) || allowed.some(key => fields.getAll(key).length !== 1)) throw new CRMError('The receipt upload contains invalid fields.');
  const parsed = receiptIdentitySchema.safeParse({ expenseId: fields.get('expenseId'), requestId: fields.get('requestId') });
  if (!parsed.success) throw new CRMError('Choose a saved expense before uploading its receipt.');
  const file = fields.get('file');
  if (!(file instanceof File)) throw new CRMError('Choose a receipt file.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let mimeType: ExpenseReceipt['mimeType'];
  try { mimeType = inspectReceipt(bytes, file.type); } catch (error) {
    if (error instanceof ReceiptValidationError) throw new CRMError(error.message);
    throw error;
  }
  const fileName = receiptFileName(file.name, mimeType), sha256 = digest(bytes);
  const client = createAdminClient();
  return finishReceiptUpload({
    reserve: () => operationsRpc<ReceiptReservation>('crm_expense_receipt_reserve', {
      p_actor_id: identity.userId, p_expense_id: parsed.data.expenseId, p_request_id: parsed.data.requestId,
      p_file_name: fileName, p_mime_type: mimeType, p_size_bytes: bytes.length, p_sha256: sha256,
    }),
    upload: async reservation => {
      checkStoredPath(reservation);
      const { error } = await client.storage.from(BUCKET).upload(reservation.objectPath, bytes, { contentType: mimeType, upsert: false, cacheControl: '0' });
      if (!error) return 'CREATED';
      if ('statusCode' in error && ['409', '400'].includes(String(error.statusCode)) && /already exists|duplicate/i.test(error.message)) return 'EXISTS';
      throw new CRMError('The receipt could not be uploaded. Retry with the same file.', 503);
    },
    verifyExisting: async reservation => {
      checkStoredPath(reservation);
      const { data, error } = await client.storage.from(BUCKET).download(reservation.objectPath);
      if (error || !data || data.size !== bytes.length) return false;
      return digest(new Uint8Array(await data.arrayBuffer())) === sha256;
    },
    complete: reservation => operationsRpc<ExpenseReceipt>('crm_expense_receipt_complete', {
      p_actor_id: identity.userId, p_receipt_id: reservation.id, p_mime_type: mimeType,
      p_size_bytes: bytes.length, p_sha256: sha256,
    }),
  });
}

export async function downloadExpenseReceipt(id: string): Promise<Response> {
  const identity = await authenticate();
  const receipt = await operationsRpc<ExpenseReceipt & { bucket: string; objectPath: string; sha256: string }>('crm_expense_receipt_access', { p_actor_id: identity.userId, p_receipt_id: validatedId(id) });
  checkStoredPath(receipt);
  const { data, error } = await createAdminClient().storage.from(BUCKET).download(receipt.objectPath);
  if (error || !data) throw new CRMError('This receipt is temporarily unavailable. Please try again.', 503);
  if (data.size !== receipt.sizeBytes || data.size > RECEIPT_MAX_BYTES) throw new CRMError('The receipt could not be verified.', 503);
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (digest(bytes) !== receipt.sha256) throw new CRMError('The receipt could not be verified.', 503);
  // Recheck current membership and expense visibility after external storage IO.
  await operationsRpc('crm_expense_receipt_access', { p_actor_id: identity.userId, p_receipt_id: receipt.id });
  return new Response(bytes, { headers: {
    ...PRIVATE_HEADERS, 'Content-Type': receipt.mimeType, 'Content-Length': String(bytes.length),
    'Content-Disposition': receiptContentDisposition(receipt.fileName, receipt.mimeType === 'application/pdf'),
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
  } });
}

export async function removeExpenseReceipt(request: Request, id: string): Promise<void> {
  await readAuthInput(request, z.object({}).strict());
  const identity = await authenticate();
  const removed = await operationsRpc<{ bucket: string; objectPath: string }>('crm_expense_receipt_remove', { p_actor_id: identity.userId, p_receipt_id: validatedId(id) });
  checkStoredPath(removed);
  // Metadata is revoked before object deletion; retries can finish cleanup.
  const { error } = await createAdminClient().storage.from(BUCKET).remove([removed.objectPath]);
  if (error) throw new CRMError('The receipt is hidden, but file cleanup is still pending. Retry removal to finish.', 503);
}
