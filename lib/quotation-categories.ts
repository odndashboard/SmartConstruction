import type { QuoteItemInput } from './types';

export const REQUIRED_QUOTE_CATEGORIES = [
  'Panels', 'Inverter', 'Structure', 'DC Wire', 'Ac Wire', 'Earthing Wire',
  'Earthing ROD', 'Lighting Arrester', 'Filing',
] as const;
export type QuoteItemCategory = typeof REQUIRED_QUOTE_CATEGORIES[number];
// An existing quotation may already contain 100 lines. Keep every original
// line when its draft is completed with the nine required categories.
export const MAX_QUOTE_ITEMS = 109;
export const QUOTE_ITEM_SCHEMA_VERSION = 2;

export function getMissingQuoteCategories(items: readonly Pick<QuoteItemInput, 'category'>[]): QuoteItemCategory[] {
  const included = new Set(items.map(item => item.category));
  return REQUIRED_QUOTE_CATEGORIES.filter(category => !included.has(category));
}

export function validateRequiredQuoteItems(items: readonly QuoteItemInput[]): void {
  const included = new Set<QuoteItemCategory>();
  for (const item of items) {
    if (item.category === undefined) continue;
    if (!(REQUIRED_QUOTE_CATEGORIES as readonly string[]).includes(item.category)) throw new Error('Choose a valid quotation work-item category.');
    if (included.has(item.category)) throw new Error(`${item.category} must appear exactly once in the quotation.`);
    included.add(item.category);
    if (!item.description?.trim() || !item.unit?.trim() || !item.quantity?.trim() || !item.unitPrice?.trim()) {
      throw new Error(`Complete the description, quantity, unit and price for ${item.category}. Enter 0 explicitly for a no-charge item.`);
    }
  }
  const missing = getMissingQuoteCategories(items);
  if (missing.length) throw new Error(`Complete all nine required work items before saving or issuing: ${missing.join(', ')}. Reopen the quotation editor to add the missing rows.`);
}
