import { getWorkspace, errorResponse, CRMError } from '../../../lib/server';
import { todayIST } from '../../../lib/finance';
export const dynamic = 'force-dynamic';
function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula execution when customer-controlled text is opened.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function GET(request: Request) {
  try {
    const data = await getWorkspace(true);
    const url = new URL(request.url); const format = url.searchParams.get('format') ?? 'json';
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (format === 'json') {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Disposition'] = `attachment; filename="smart-construction-${todayIST()}.json"`;
      return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), schemaVersion: 1, ...data }, null, 2), { headers });
    }
    if (format !== 'csv') throw new CRMError('Choose JSON or CSV export.');
    const moduleName = url.searchParams.get('module') ?? 'leads';
    const collections: Record<string, { headings: string[]; rows: unknown[][] }> = {
      leads: { headings: ['ID', 'Project', 'Customer ID', 'Contact', 'Phone', 'Email', 'Location', 'Status', 'Value INR', 'Owner user ID', 'Priority', 'Example', 'Created'],
        rows: data.leads.map(r => [r.id, r.title, r.customerId, r.contact, r.phone, r.email, r.location, r.status, (r.value / 100).toFixed(2), r.owner, r.priority, r.isDemo, r.createdAt]) },
      customers: { headings: ['ID', 'Name', 'Contact', 'Phone', 'Email', 'Billing address', 'State', 'GSTIN', 'Example'],
        rows: data.customers.map(r => [r.id, r.name, r.contact, r.phone, r.email, r.address, r.stateCode, r.gstin, r.isDemo]) },
      followups: { headings: ['ID', 'Lead ID', 'Title', 'Due at', 'Channel', 'Owner user ID', 'Status', 'Outcome', 'Example'],
        rows: data.followups.map(r => [r.id, r.leadId, r.title, r.dueAt, r.channel, r.owner, r.status, r.outcome, r.isDemo]) },
      quotations: { headings: ['ID', 'Number', 'Title', 'Status', 'Revision', 'Valid until', 'Place of supply', 'Taxable INR', 'Total INR', 'Tax calculation needs setup', 'Example'],
        rows: data.quotations.map(r => [r.id, r.number, r.title, r.status, r.revision, r.validUntil, r.placeOfSupply, (r.totals.taxable / 100).toFixed(2), (r.totals.total / 100).toFixed(2), r.totals.needsConfig, r.isDemo]) },
      workorders: { headings: ['ID', 'Number', 'Quotation ID', 'Title', 'Customer', 'Status', 'Owner user ID', 'Start date', 'End date', 'Total INR', 'Example'],
        rows: data.workorders.map(r => [r.id, r.number, r.quoteId, r.title, r.customerName, r.status, r.owner, r.startDate, r.endDate, (r.snapshot.totals.total / 100).toFixed(2), r.isDemo]) },
    };
    if (!Object.hasOwn(collections, moduleName)) throw new CRMError('Choose leads, customers, followups, quotations or workorders.');
    const collection = collections[moduleName];
    const contents = [collection.headings, ...collection.rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    headers['Content-Type'] = 'text/csv; charset=utf-8';
    headers['Content-Disposition'] = `attachment; filename="smart-construction-${moduleName}-${todayIST()}.csv"`;
    return new Response('\uFEFF' + contents, { headers });
  } catch (error) { return errorResponse(error); }
}
