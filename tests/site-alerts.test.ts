import assert from 'node:assert/strict';
import test from 'node:test';
import { siteAlertMutationSchema, siteAlertsDataSchema, siteAlertsQuerySchema } from '../lib/site-alerts-validation.ts';
import { canResolveSiteAlert } from '../lib/site-alerts.ts';
import type { SiteAlert, SiteAlertMutation, SiteAlertMember } from '../lib/site-alerts.ts';
import { AlertRequestError, loadAlerts, saveAlert } from '../lib/site-alerts-client.ts';
import { alertData } from './fixtures/site-alerts.ts';

const assigneeId = alertData().user.userId;
const itemId = alertData().stockItems[0].id;
const payload = { workOrderId: 'work-active', assigneeId, itemName: 'Not catalogued cable', quantity: '2.5', unit: 'm' };
const mutation: SiteAlertMutation = { action: 'material_alert_create', payload, expectedRevision: 4, requestId: 'local-alert-request' };

test('alerts accept a catalogue item or named missing item with required active-member identity and optional precise quantity', () => {
  for (const value of [payload, { workOrderId: 'work-active', assigneeId, itemId }, { ...payload, quantity: undefined, unit: undefined }]) {
    assert.ok(siteAlertMutationSchema.safeParse({ ...mutation, payload: value }).success);
  }
  for (const quantity of ['0.001', '9000000000.000']) assert.ok(siteAlertMutationSchema.safeParse({ ...mutation, payload: { ...payload, quantity } }).success);
  for (const quantity of ['0', '-1', '1.0001', '1e3', '9000000000.001', 2.5, true, '']) assert.equal(siteAlertMutationSchema.safeParse({ ...mutation, payload: { ...payload, quantity } }).success, false);
  for (const value of [{ ...payload, itemId }, { ...payload, unit: '' }, { ...payload, assigneeId: '' }, { workOrderId: 'work-active', assigneeId }]) assert.equal(siteAlertMutationSchema.safeParse({ ...mutation, payload: value }).success, false);
});

test('alerts reject authority, status, stock mutations, invalid filters and oversized content', () => {
  for (const extra of [{ reportedBy: assigneeId }, { status: 'RESOLVED' }, { quantityMilli: 2500 }, { stockBalance: 0 }, { resolvedBy: assigneeId }]) {
    assert.equal(siteAlertMutationSchema.safeParse({ ...mutation, payload: { ...payload, ...extra } }).success, false);
  }
  for (const extra of [{ actorId: assigneeId }, { role: 'OWNER' }, { expectedRevision: -1 }, { requestId: '../unsafe' }]) assert.equal(siteAlertMutationSchema.safeParse({ ...mutation, ...extra }).success, false);
  for (const value of [{ ...payload, itemName: 'a'.repeat(201) }, { ...payload, note: 'a'.repeat(2001) }, { ...payload, unit: 'a'.repeat(25) }]) assert.equal(siteAlertMutationSchema.safeParse({ ...mutation, payload: value }).success, false);
  for (const query of [{ page: 0 }, { page: '1e2' }, { page: 10001 }, { search: 'a'.repeat(201) }, { role: 'OWNER' }, { workOrderId: '../job' }]) assert.equal(siteAlertsQuerySchema.safeParse(query).success, false);
  assert.deepEqual(siteAlertsQuerySchema.parse({ search: ' copper ', status: 'ALL', page: '2' }), { search: 'copper', status: 'ALL', page: 2 });
});

test('alert response strips sensitive directory and stock fields and resolution excludes dealers and legacy viewers', () => {
  const source = alertData();
  const data = siteAlertsDataSchema.parse({ ...source, secret: 'hidden', user: { ...source.user, email: 'private@example.invalid' },
    assignees: [{ ...source.user, email: 'private@example.invalid', authMetadata: {} }], stockItems: [{ ...source.stockItems[0], quantityMilli: 123, costPaise: 456 }] });
  assert.deepEqual(data, source);
  const alert = { status: 'OPEN', assigneeId } as SiteAlert;
  assert.ok(canResolveSiteAlert(source.user, alert));
  assert.ok(canResolveSiteAlert({ ...source.user, userId: itemId, role: 'MANAGER' }, alert));
  assert.equal(canResolveSiteAlert({ ...source.user, userId: itemId, role: 'SALES' }, alert), false);
  for (const role of ['DEALER', 'VIEWER']) {
    assert.equal(canResolveSiteAlert({ ...source.user, role } as SiteAlertMember, alert), false);
    assert.equal(siteAlertsDataSchema.safeParse({ ...source, user: { ...source.user, role } }).success, false);
  }
  assert.equal(canResolveSiteAlert(source.user, { ...alert, status: 'RESOLVED' }), false);
});

test('alert reads encode scoped search/page filters and surface access loss', async t => {
  const data = alertData();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/alerts?workOrderId=work-active&status=ALL&page=2&search=copper+%25');
    return Response.json(data);
  });
  assert.deepEqual(await loadAlerts({ workOrderId: 'work-active', status: 'ALL', page: 2, search: ' copper % ' }), data);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }));
  await assert.rejects(loadAlerts(), error => error instanceof AlertRequestError && error.accessRevoked && !error.uncertain);
});

test('lost alert responses are retried only by caller with the exact original request, without fabricated stock changes', async t => {
  const requests: unknown[] = []; let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    requests.push(JSON.parse(String(options?.body))); calls++;
    if (calls === 1) throw new TypeError('Lost response');
    return Response.json({ data: alertData(), message: 'Alert reported.' });
  });
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.uncertain && !error.accessRevoked);
  assert.equal(calls, 1);
  await saveAlert(mutation);
  assert.deepEqual(requests, [mutation, mutation]);
});

test('forbidden resolution and stale revisions retain workspace access while authentication failures revoke it', async t => {
  let next = Response.json({ error: 'Only the assignee can resolve.', accessRevoked: false }, { status: 403 });
  t.mock.method(globalThis, 'fetch', async () => next);
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.status === 403 && !error.accessRevoked && !error.uncertain);
  next = Response.json({ error: 'Records changed.' }, { status: 409 });
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.status === 409 && !error.uncertain);
  next = Response.json({ error: 'Access ended.', accessRevoked: true }, { status: 403 });
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.accessRevoked);
  next = new Response('bad gateway', { status: 502 });
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.uncertain);
  next = Response.json({ message: 'Missing data' });
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.uncertain);
  next = Response.json(null);
  await assert.rejects(saveAlert(mutation), error => error instanceof AlertRequestError && error.uncertain);
});
