import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../app/api/export/route.ts', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

test('work-order CSV leaves unapproved amounts blank and preserves accepted totals', async () => {
  const data = { leads: [], customers: [], followups: [], quotations: [], workorders: [
    { id: 'provisional', number: 'WO/1', leadId: 'lead-1', quoteId: null, title: 'Unpriced project', customerName: 'Actual customer', status: 'PLANNED', owner: '', startDate: '', endDate: '', snapshot: null, expectedKw: 10.5, isDemo: false },
    { id: 'approved', number: 'WO/2', quoteId: 'quote', title: 'Approved project', customerName: 'Actual customer', status: 'PLANNED', owner: '', startDate: '', endDate: '', snapshot: { leadId: 'lead-2', totals: { total: 12345 } }, isDemo: false },
  ] };
  const route = {};
  class CRMError extends Error {}
  new Function('exports', 'getWorkspace', 'errorResponse', 'CRMError', 'todayIST', 'getOperationsExport', compiled)(
    route, async () => data, error => { throw error; }, CRMError, () => '2026-11-27', async () => { throw new Error('Unexpected operations export'); },
  );
  const response = await route.GET(new Request('https://crm.example/api/export?format=csv&module=workorders'));
  assert.equal(response.status, 200);
  const csv = await response.text();
  assert.match(csv, /"Accepted total INR"/);
  const rows = csv.split('\r\n');
  assert.match(rows[1], /"PLANNED","","","","","false","lead-1","10.5"$/);
  assert.match(rows[2], /"123.45"/);
  assert.doesNotMatch(rows[1], /"0\.00"/);
});
