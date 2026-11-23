import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_PAISE, computeQuote, financialYear, getTaxMode, parseMoney,
  todayIST, validateRegistration,
} from '../lib/finance.ts';
import type { QuoteItemInput } from '../lib/types.ts';

function item(overrides: Partial<QuoteItemInput> = {}): QuoteItemInput {
  return {
    id: 'test-item', description: 'Synthetic civil work', hsnSac: '9954',
    quantity: '2', unit: 'job', unitPrice: '500.00', discount: '100.00',
    gstRate: '18.00', ...overrides,
  };
}

describe('quotation arithmetic in integer paise', () => {
  test('discount precedes tax and intra-state components reconcile', () => {
    const { items, totals } = computeQuote([item()], '06', '06');
    assert.deepEqual(totals, {
      subtotal: 100000, discount: 10000, taxable: 90000,
      cgst: 8100, sgst: 8100, utgst: 0, igst: 0, total: 106200,
      mode: 'CGST_SGST', needsConfig: false,
    });
    assert.equal(items[0].gross, 100000);
    assert.equal(items[0].taxable, 90000);
    assert.equal(items[0].total, 106200);
    for (const key of ['gross', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'total'] as const) {
      assert.ok(Number.isSafeInteger(items[0][key]), `${key} must remain safe integer paise`);
    }
  });

  test('different supplier and project states use only IGST', () => {
    const { totals } = computeQuote([item()], '06', '07');
    assert.equal(totals.mode, 'IGST');
    assert.equal(totals.igst, 16200);
    assert.equal(totals.cgst + totals.sgst + totals.utgst, 0);
    assert.equal(totals.total, 106200);
  });

  test('Chandigarh uses UTGST while Delhi and Puducherry use SGST', () => {
    const { totals } = computeQuote([item()], '04', '04');
    assert.equal(totals.mode, 'CGST_UTGST');
    assert.equal(totals.cgst, 8100);
    assert.equal(totals.utgst, 8100);
    assert.equal(totals.sgst, 0);
    assert.equal(getTaxMode('07', '07'), 'CGST_SGST');
    assert.equal(getTaxMode('34', '34'), 'CGST_SGST');
    assert.equal(getTaxMode('04', '07'), 'IGST');
  });

  test('each tax component rounds half up before document aggregation', () => {
    const halfPaise = item({ quantity: '1', unitPrice: '0.05', discount: '0', gstRate: '20' });
    const { items, totals } = computeQuote([halfPaise, { ...halfPaise, id: 'test-item-2' }], '06', '06');
    assert.equal(items[0].cgst, 1);
    assert.equal(items[0].sgst, 1);
    assert.equal(items[0].total, 7);
    assert.equal(totals.cgst, 2);
    assert.equal(totals.sgst, 2);
    assert.equal(totals.total, 14);
  });

  test('fractional quantity rounds gross line amount to the nearest paise', () => {
    const { items, totals } = computeQuote([
      item({ quantity: '0.125', unitPrice: '0.04', discount: '0', gstRate: '0' }),
    ], '06', '06');
    assert.equal(items[0].gross, 1);
    assert.equal(totals.total, 1);
  });

  test('rates are explicit, including zero; missing rate is never guessed', () => {
    for (const [gstRate, expected] of [['0', 0], ['5', 4500], ['12', 10800]] as const) {
      assert.equal(computeQuote([item({ gstRate })], '06', '07').totals.igst, expected);
    }
    assert.throws(() => computeQuote([item({ gstRate: '' })], '06', '06'));
    const missingRate = item();
    Reflect.deleteProperty(missingRate, 'gstRate');
    assert.throws(() => computeQuote([missingRate], '06', '06'));
  });

  test('full line discount gives zero taxable value and tax', () => {
    const { totals } = computeQuote([item({ discount: '1000' })], '06', '07');
    assert.equal(totals.taxable, 0);
    assert.equal(totals.igst, 0);
    assert.equal(totals.total, 0);
  });

  test('calculation does not mutate caller input or retain submitted computed totals', () => {
    const input = Object.assign(item(), { total: 1, cgst: 1, gross: 1 });
    const before = structuredClone(input);
    const result = computeQuote([input], '06', '06');
    assert.deepEqual(input, before);
    assert.equal(result.items[0].total, 106200);
    assert.equal(result.items[0].cgst, 8100);
    assert.equal(result.items[0].gross, 100000);
  });
});

describe('configuration and financial input boundaries', () => {
  test('incomplete jurisdiction keeps pretax draft values and flags unpriced GST', () => {
    for (const [supplier, project] of [['', '06'], ['06', ''], ['', '']]) {
      const { totals } = computeQuote([item()], supplier, project);
      assert.equal(totals.needsConfig, true);
      assert.equal(totals.mode, 'UNCONFIGURED');
      assert.equal(totals.subtotal, 100000);
      assert.equal(totals.taxable, 90000);
      assert.equal(totals.total, 90000);
      assert.equal(totals.cgst + totals.sgst + totals.utgst + totals.igst, 0);
    }
  });

  test('unknown nonempty states never silently select a tax jurisdiction', () => {
    for (const [supplier, project] of [['99', '06'], ['06', '99'], ['6', '06'], ['', '99']]) {
      assert.throws(() => computeQuote([item()], supplier, project));
    }
  });

  test('empty drafts are valid while more than one hundred work items are rejected', () => {
    const { items, totals } = computeQuote([], '', '');
    assert.equal(items.length, 0);
    assert.equal(totals.total, 0);
    assert.equal(totals.needsConfig, true);
    assert.throws(() => computeQuote(Array.from({ length: 101 }, (_, i) => item({ id: String(i) })), '06', '06'));
  });

  test('negative, zero-quantity, excessive-rate and over-discounted lines are rejected', () => {
    const invalid: Partial<QuoteItemInput>[] = [
      { quantity: '0' }, { quantity: '-1' }, { unitPrice: '-0.01' },
      { discount: '-0.01' }, { discount: '1000.01' }, { gstRate: '-1' }, { gstRate: '100.01' },
    ];
    for (const change of invalid) {
      assert.throws(() => computeQuote([item(change)], '06', '06'), JSON.stringify(change));
    }
  });

  test('precision, exponential notation and nonfinite strings are rejected', () => {
    const invalid: Partial<QuoteItemInput>[] = [
      { quantity: '1.0001' }, { unitPrice: '1.001' }, { discount: '0.001' }, { gstRate: '18.001' },
      { quantity: '1e3' }, { unitPrice: 'NaN' }, { discount: 'Infinity' }, { gstRate: 'NaN' },
    ];
    for (const change of invalid) {
      assert.throws(() => computeQuote([item(change)], '06', '06'), JSON.stringify(change));
    }
  });

  test('runtime nonstring numeric inputs are not accepted as decimal currency', () => {
    for (const field of ['quantity', 'unitPrice', 'discount', 'gstRate'] as const) {
      for (const value of [0, 0.1, Number.NaN, Number.POSITIVE_INFINITY, false]) {
        const input = item({ [field]: value as unknown as string });
        assert.throws(() => computeQuote([input], '06', '06'), `${field} received ${String(value)}`);
      }
    }
  });

  test('money parser returns exact paise and enforces the published maximum', () => {
    assert.equal(parseMoney('0.01'), 1);
    assert.equal(parseMoney('12345.67'), 1234567);
    assert.equal(parseMoney('90000000000.00'), MAX_PAISE);
    for (const value of ['90000000000.01', '-1', '1.001', '1e10', 'NaN', 'Infinity', '']) {
      assert.throws(() => parseMoney(value), value);
    }
  });

  test('per-line, tax-inclusive and aggregate totals cannot overflow the supported limit', () => {
    const exactLimit = item({ quantity: '1', unitPrice: '90000000000.00', discount: '0', gstRate: '0' });
    assert.equal(computeQuote([exactLimit], '06', '06').totals.total, MAX_PAISE);
    assert.throws(() => computeQuote([{ ...exactLimit, quantity: '2' }], '06', '06'));
    assert.throws(() => computeQuote([{ ...exactLimit, gstRate: '18' }], '06', '06'));
    const half = { ...exactLimit, unitPrice: '50000000000.00' };
    assert.throws(() => computeQuote([half, { ...half, id: 'second' }], '06', '06'));
    assert.throws(() => computeQuote([
      item({ quantity: '1000000000.001', unitPrice: '0', discount: '0', gstRate: '0' }),
    ], '06', '06'));
  });
});

describe('registration and India calendar boundaries', () => {
  test('synthetic GSTIN passes only format and matching-state checks', () => {
    // Synthetic fixture; no claim of actual registration or checksum validity.
    assert.doesNotThrow(() => validateRegistration('06ABCDE1234F1Z5', '06', true));
    assert.throws(() => validateRegistration('06ABCDE1234F1Z5', '07', true));
    assert.throws(() => validateRegistration('99ABCDE1234F1Z5', '99', true));
    assert.throws(() => validateRegistration('06abcde1234f1z5', '06', true));
    assert.throws(() => validateRegistration('', '06', true));
    assert.doesNotThrow(() => validateRegistration('', '', false));
  });

  test('financial-year sequence changes on first April', () => {
    assert.equal(financialYear('2026-03-31'), '2025-26');
    assert.equal(financialYear('2026-04-01'), '2026-27');
    assert.equal(financialYear('2027-01-01'), '2026-27');
    assert.equal(financialYear('2028-02-29'), '2027-28');
  });

  test('Date inputs roll over at midnight in India, not midnight UTC', () => {
    const before = new Date('2026-03-31T18:29:59.999Z');
    const after = new Date('2026-03-31T18:30:00.000Z');
    assert.equal(todayIST(before), '2026-03-31');
    assert.equal(todayIST(after), '2026-04-01');
    assert.equal(financialYear(before), '2025-26');
    assert.equal(financialYear(after), '2026-27');
  });

  test('invalid and impossible financial-year dates are rejected', () => {
    for (const value of ['invalid', '2026-2-01', '2026-13-01', '2026-02-29', '2026-02-31', '2026-04-31']) {
      assert.throws(() => financialYear(value), value);
    }
    assert.throws(() => financialYear(new Date('invalid')));
    assert.throws(() => todayIST(new Date('invalid')));
  });
});
