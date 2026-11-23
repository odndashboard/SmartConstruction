import { uploadExpenseReceipt } from '@/lib/expense-receipts-server';
import { authError, authResponse } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return authResponse({ receipt: await uploadExpenseReceipt(request) }, 201); }
  catch (error) { return authError(error); }
}
