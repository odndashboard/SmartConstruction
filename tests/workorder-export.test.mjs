import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { effectiveQuoteStatus } from '../lib/quotation-status.ts';

const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function routeFor(data) {
  const route = {};
  class CRMError extends Error {}
  new Function('exports', 'getWorkspace', 'errorResponse', 'CRMError', 'todayIST', 'getOperationsExport', 'effectiveQuoteStatus', compiled)(
    route, async () => data, error => { throw error; }, CRMError, () => '2026-11-27', async () => ({}), effectiveQuoteStatus,
  );
  return route;
}

test('work-order CSV leaves unapproved amounts blank and preserves accepted totals', async () => {
  const data = { leads: [], customers: [], followups: [], quotations: [], workorders: [
    { id: 'provisional', number: 'WO/1', leadId: 'lead-1', quoteId: null, title: 'Unpriced project', customerName: 'Actual customer', status: 'PLANNED', owner: '', startDate: '', endDate: '', snapshot: null, expectedKw: 10.5, isDemo: false },
    { id: 'approved', number: 'WO/2', quoteId: 'quote', title: 'Approved project', customerName: 'Actual customer', status: 'PLANNED', owner: '', startDate: '', endDate: '', snapshot: { leadId: 'lead-2', totals: { total: 12345 } }, isDemo: false },
  ] };
  const route = routeFor(data);
  const response = await route.GET(new Request('https://crm.example/api/export?format=csv&module=workorders'));
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /"Accepted total INR"/);
  const rows = csv.split('\r\n');
  assert.match(rows[1], /"PLANNED","","","","","false","lead-1","10.5"$/);
  assert.match(rows[2], /"123.45"/);
  assert.doesNotMatch(rows[1], /"0\.00"/);
});

test('quotation CSV uses calendar and manual expiry while JSON preserves stored status history', async () => {
  const quotation = (id, status, validUntil) => ({ id, number: id, title: id, status, validUntil, revision: 1, placeOfSupply: '06', totals: { taxable: 10000, total: 11800, needsConfig: false }, isDemo: false });
  const data = { leads: [], customers: [], followups: [], workorders: [], quotations: [
    quotation('calendar-expired', 'ISSUED', '2026-11-26'),
    quotation('manually-expired', 'EXPIRED', '2026-12-27'),
    quotation('valid-today', 'ISSUED', '2026-11-27'),
    quotation('accepted-old', 'ACCEPTED', '2026-11-26'),
  ] };
  const route = routeFor(data);
  const csvResponse = await route.GET(new Request('https://crm.example/api/export?format=csv&module=quotations'));
  const csv = await csvResponse.text();
  assert.match(csv, /"calendar-expired","calendar-expired","calendar-expired","EXPIRED"/);
  assert.match(csv, /"manually-expired","manually-expired","manually-expired","EXPIRED"/);
  assert.match(csv, /"valid-today","valid-today","valid-today","ISSUED"/);
  assert.match(csv, /"accepted-old","accepted-old","accepted-old","ACCEPTED"/);
  const jsonResponse = await route.GET(new Request('https://crm.example/api/export?format=json'));
  assert.equal((await jsonResponse.json()).quotations[0].status, 'ISSUED');
});
