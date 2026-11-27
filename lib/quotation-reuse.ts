import { getMissingQuoteCategories } from './quotation-categories.ts';
import { computeQuote } from './finance.ts';
import type { PackagePricing, Quotation, QuoteItemInput } from './types';

/** Copy the specifications and pricing only. The target draft keeps its client and project details. */
export function reusableQuoteScope(source: Quotation): PackagePricing & { items: QuoteItemInput[]; gstEnabled: boolean } {
  const items: QuoteItemInput[] = source.items.map(row => ({
    id: crypto.randomUUID(), ...(row.category ? { category: row.category } : {}), description: row.description,
    quantity: row.quantity, unit: row.unit, warranty: row.warranty ?? '',
    hsnSac: '', unitPrice: '0', discount: '0', gstRate: '0',
  }));
  for (const category of getMissingQuoteCategories(items)) {
    items.push({ id: crypto.randomUUID(), category, description: '', quantity: '', unit: '', warranty: '',
      hsnSac: '', unitPrice: '0', discount: '0', gstRate: '0' });
  }

  const gstEnabled = source.gstEnabled !== false && source.totals.mode !== 'NO_GST';
  const packagePrice = source.packagePrice ?? (source.totals.taxable / 100).toFixed(2);
  let packageGstRate = '0';
  if (gstEnabled) {
    const rates = new Set(source.items.filter(row => row.taxable > 0).map(row => Number(row.gstRate).toString()));
    const [commonRate] = rates;
    packageGstRate = source.packageGstRate ?? (rates.size === 1 ? commonRate : '');
  }
  return { items, packagePrice, packageGstRate, gstEnabled };
}

/** An explicit draft conversion uses current inputs, retaining their identities
 * and specifications. Incomplete prices stay blank for deliberate entry. */
export function packageScopeFromItems(items: QuoteItemInput[], supplierState: string, placeOfSupply: string, gstEnabled: boolean): PackagePricing & { items: QuoteItemInput[] } {
  let packagePrice = '';
  let rateRows = items;
  try {
    const computed = computeQuote(items, supplierState, placeOfSupply, gstEnabled);
    packagePrice = (computed.totals.taxable / 100).toFixed(2);
    const priced = computed.items.filter(item => item.taxable > 0);
    if (priced.length) rateRows = priced;
  } catch { /* Incomplete input must be reviewed, not silently priced. */ }
  const rates = rateRows.map(item => item.gstRate.trim());
  const validRates = rates.length > 0 && rates.every(rate => /^\d+(?:\.\d{1,2})?$/.test(rate) && Number(rate) <= 100);
  const distinct = new Set(rates.map(rate => Number(rate).toString()));
  const packageGstRate = !gstEnabled ? '0' : validRates && distinct.size === 1 ? [...distinct][0] : '';
  return { packagePrice, packageGstRate, items: items.map(item => ({ ...item, unitPrice: '0', discount: '0', gstRate: '0' })) };
}
