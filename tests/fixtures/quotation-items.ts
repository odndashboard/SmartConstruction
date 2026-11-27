import { REQUIRED_QUOTE_CATEGORIES } from '../../lib/quotation-categories.ts';
import type { QuoteItemInput } from '../../lib/types.ts';

type FixtureItem = Pick<QuoteItemInput, 'id' | 'description' | 'quantity' | 'unit' | 'unitPrice'> & Partial<QuoteItemInput>;

/** Synthetic fixture completion only. Production never infers a category or
 * invents quantities, descriptions or prices for historical quotation lines. */
export function completeQuoteItems(items: QuoteItemInput[]): QuoteItemInput[];
export function completeQuoteItems(items: FixtureItem[]): FixtureItem[];
export function completeQuoteItems(items: FixtureItem[]): FixtureItem[] {
  const rows = items.map(item => ({ ...item }));
  const available = REQUIRED_QUOTE_CATEGORIES.filter(category => !rows.some(item => item.category === category));
  for (const row of rows) if (row.category === undefined && available.length) row.category = available.shift()!;
  const ids = new Set(rows.map(item => item.id));
  for (const category of available) {
    let suffix = rows.length + 1;
    while (ids.has(`fixture-required-${suffix}`)) suffix++;
    const id = `fixture-required-${suffix}`;
    ids.add(id);
    rows.push({ id, category, description: `Synthetic ${category} scope`, quantity: '1', unit: 'job', unitPrice: '0', hsnSac: '', discount: '0', gstRate: '0' });
  }
  return rows;
}
