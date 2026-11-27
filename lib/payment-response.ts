import type { OperationsData } from './operations-types';

export const PAYMENT_ACCOUNT_HEADERS = { 'X-CRM-Payment-Accounts': '2' };

/** Already-open older clients expect every payment account to have an agreed numeric total. */
export function paymentResponse(request: Request, data: OperationsData): OperationsData {
  const accounts = data.extension?.paymentAccounts;
  if (request.headers.get('X-CRM-Payment-Accounts') === '2' || !accounts) return data;
  const unpriced = new Set(accounts.filter(account => account.contractPaise === null).map(account => account.workOrderId));
  if (!unpriced.size) return data;
  const extension = data.extension;
  return { ...data, extension: { ...extension,
    paymentAccounts: accounts.filter(account => !unpriced.has(account.workOrderId)),
    customerPayments: extension.customerPayments?.filter(payment => !unpriced.has(payment.workOrderId)) ?? null,
  } };
}
