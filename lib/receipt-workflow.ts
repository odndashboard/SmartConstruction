import type { ExpenseReceipt } from './operations-extensions';

export interface ReceiptReservation extends ExpenseReceipt {
  state: 'PENDING' | 'READY'; bucket: string; objectPath: string; sha256: string;
}
export interface ReceiptUploadDependencies {
  reserve: () => Promise<ReceiptReservation>;
  upload: (reservation: ReceiptReservation) => Promise<'CREATED' | 'EXISTS'>;
  verifyExisting: (reservation: ReceiptReservation) => Promise<boolean>;
  complete: (reservation: ReceiptReservation) => Promise<ExpenseReceipt>;
}

/** Immutable object names and a payload-bound reservation make network retries
 * safe. Never delete an object after an uncertain completion: it may be READY. */
export async function finishReceiptUpload(dependencies: ReceiptUploadDependencies): Promise<ExpenseReceipt> {
  const reservation = await dependencies.reserve();
  if (reservation.state === 'READY') {
    // The reservation RPC rechecks actor, expense, and complete file identity.
    const { id, expenseId, fileName, mimeType, sizeBytes, uploadedBy, createdAt } = reservation;
    return { id, expenseId, fileName, mimeType, sizeBytes, uploadedBy, createdAt };
  }
  const state = await dependencies.upload(reservation);
  if (state === 'EXISTS' && !(await dependencies.verifyExisting(reservation))) throw new Error('RECEIPT_OBJECT_MISMATCH');
  return dependencies.complete(reservation);
}
