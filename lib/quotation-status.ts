import { todayIST } from './finance.ts';
import type { Quotation, QuoteStatus } from './types';

/** Display calendar expiry without rewriting the immutable commercial record. */
export function effectiveQuoteStatus(quote: Pick<Quotation, 'status' | 'validUntil'>, today = todayIST()): QuoteStatus {
  return quote.status === 'ISSUED' && quote.validUntil < today ? 'EXPIRED' : quote.status;
}
