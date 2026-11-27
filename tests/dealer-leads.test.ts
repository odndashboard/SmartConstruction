import assert from 'node:assert/strict';
import test from 'node:test';
import { createDealerLeadSchema, dealerLeadsDataSchema } from '../lib/dealer-leads-validation.ts';
import { createDealerLead, DealerLeadRequestError, loadDealerLeads } from '../lib/dealer-leads-client.ts';
import type { CreateDealerLeadRequest, DealerLeadsData } from '../lib/dealer-leads.ts';

const request: CreateDealerLeadRequest = { requestId: 'dealer-request-1', payload: { title: 'Synthetic rooftop enquiry', expectedKw: 2.5 } };
const data: DealerLeadsData = { revision: 1, assignedSites: [], user: { userId: '10000000-0000-4000-8000-000000000001', name: 'Synthetic Dealer', role: 'DEALER' }, leads: [
  { id: 'lead-own', title: 'Own synthetic enquiry', contact: 'Synthetic Contact', phone: '9000000000', siteAddress: 'Synthetic roof', expectedKw: 2.5, status: 'NEW', createdAt: '2026-11-27T06:00:00Z', updatedAt: '2026-11-27T06:00:00Z', canDelete: true, deleteBlockedReason: null },
] };

test('dealer lead entry accepts only genuine basic fields, optional finite nonnegative numeric kW and a request identity', () => {
  for (const expectedKw of [undefined, null, 0, 0.25, 125.5]) assert.ok(createDealerLeadSchema.safeParse({ ...request, payload: { title: ' Job ', expectedKw } }).success);
  assert.deepEqual(createDealerLeadSchema.parse({ ...request, payload: { title: ' Job ', phone: ' 9000000000 ' } }).payload, { title: 'Job', phone: '9000000000' });
  for (const expectedKw of [-1, NaN, Infinity, '1', '', true, {}, []]) assert.equal(createDealerLeadSchema.safeParse({ ...request, payload: { ...request.payload, expectedKw } }).success, false);
  for (const payload of [{ title: '' }, { title: ' '.repeat(3) }, { title: 'a'.repeat(201) }, { title: 'Job', contact: 'a'.repeat(201) }, { title: 'Job', phone: 'a'.repeat(41) }, { title: 'Job', siteAddress: 'a'.repeat(2001) }]) assert.equal(createDealerLeadSchema.safeParse({ ...request, payload }).success, false);
});

test('dealers cannot inject ownership, customers, historical emails, notes, status, prices or an edit ID', () => {
  for (const extra of [
    { id: 'existing-lead' }, { customerId: 'customer-other' }, { submittedBy: data.user.userId }, { createdBy: data.user.userId },
    { dealerId: data.user.userId }, { owner: data.user.userId }, { email: 'private@example.invalid' }, { notes: 'Sensitive internal notes' },
    { status: 'WON' }, { value: '10000' }, { isDemo: true },
  ]) assert.equal(createDealerLeadSchema.safeParse({ ...request, payload: { ...request.payload, ...extra } }).success, false);
  for (const extra of [{ actorId: data.user.userId }, { action: 'lead_save' }, { role: 'OWNER' }, { expectedRevision: 1 }]) assert.equal(createDealerLeadSchema.safeParse({ ...request, ...extra }).success, false);
});

test('dealer response retains only own-list presentation fields and strips full workspace and customer information', () => {
  const raw = { ...data, quotations: [{ total: 999 }], customers: [{ email: 'private@example.invalid' }],
    user: { ...data.user, email: 'private@example.invalid', active: true }, leads: data.leads.map(lead => ({ ...lead, customerId: 'internal', email: 'private@example.invalid', notes: 'Internal note', owner: 'staff', value: 9999 })) };
  assert.deepEqual(dealerLeadsDataSchema.parse(raw), data);
  for (const role of ['OWNER', 'MANAGER', 'SALES', 'OPERATIONS', 'ACCOUNTANT', 'VIEWER']) assert.equal(dealerLeadsDataSchema.safeParse({ ...data, user: { ...data.user, role } }).success, false);
});

test('dealer transport reads only the scoped endpoint and preserves exact request on an uncertain retry', async t => {
  const posts: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    assert.equal(url, '/api/dealer-leads');
    if (options?.method === 'GET') return Response.json(data);
    posts.push(JSON.parse(String(options?.body)));
    if (posts.length === 1) throw new TypeError('Response lost');
    return Response.json(data);
  });
  assert.deepEqual(await loadDealerLeads(), data);
  await assert.rejects(createDealerLead(request), error => error instanceof DealerLeadRequestError && error.uncertain && !error.accessRevoked);
  assert.equal(posts.length, 1);
  assert.deepEqual(await createDealerLead(request), data);
  assert.deepEqual(posts, [request, request]);
});

test('assigned project projection strips contact, commercial and delete fields and validates actual progress', () => {
  const project = { id: 'workorder:work-1', title: 'Assigned project', siteAddress: 'Site', siteName: null, siteId: null,
    leadId: 'lead-other', workOrderId: 'work-1', workOrderNumber: 'SC/WO/2026/0001', leadStatus: 'WON' as const,
    workOrderStatus: 'ACTIVE' as const, expectedKw: 7.5, completedMilestones: 1, totalMilestones: 2, assignedVia: ['SITE'] };
  const parsed = dealerLeadsDataSchema.parse({ ...data, assignedSites: [{ ...project, contact: 'private', phone: 'private',
    snapshot: { total: 10000 }, customerName: 'private', canDelete: true, members: [{ name: 'private' }] }] });
  assert.deepEqual(parsed.assignedSites, [project]);
  for (const invalid of [{ completedMilestones: 3 }, { totalMilestones: -1 }, { workOrderStatus: 'ISSUED' },
    { assignedVia: [] }, { assignedVia: ['OWNER'] }, { expectedKw: -1 }, { siteId: 'not-a-uuid' }]) {
    assert.equal(dealerLeadsDataSchema.safeParse({ ...data, assignedSites: [{ ...project, ...invalid }] }).success, false);
  }
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) {
    assert.equal(dealerLeadsDataSchema.safeParse({ ...data, revision }).success, false);
  }
});

test('dealer validation failures remain editable; access faults clear private state and server uncertainty keeps retry identity', async t => {
  let response = Response.json({ error: 'Enter a project title.' }, { status: 400 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(createDealerLead(request), error => error instanceof DealerLeadRequestError && !error.uncertain && !error.accessRevoked);
  for (const status of [401, 403]) {
    response = new Response(null, { status });
    await assert.rejects(loadDealerLeads(), error => error instanceof DealerLeadRequestError && error.accessRevoked);
  }
  response = new Response('gateway error', { status: 502 });
  await assert.rejects(createDealerLead(request), error => error instanceof DealerLeadRequestError && error.uncertain);
  response = Response.json({ user: data.user });
  await assert.rejects(createDealerLead(request), error => error instanceof DealerLeadRequestError && error.uncertain);
  response = Response.json(null);
  await assert.rejects(createDealerLead(request), error => error instanceof DealerLeadRequestError && error.uncertain);
});
