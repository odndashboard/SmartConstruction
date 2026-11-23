import { downloadExpenseReceipt, removeExpenseReceipt } from '@/lib/expense-receipts-server';
import { authError, authResponse } from '@/lib/auth-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { return await downloadExpenseReceipt((await context.params).id); }
  catch (error) { return authError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { await removeExpenseReceipt(request, (await context.params).id); return authResponse({ message: 'Receipt removed.' }); }
  catch (error) { return authError(error); }
}
