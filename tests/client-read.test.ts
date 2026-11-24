import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson, ReadTimeoutError } from '../lib/client-read.ts';

test('client reads request fresh authenticated JSON and remove their cancellation listener on success', async t => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/operations');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    requestSignal = init?.signal;
    return Response.json({ revision: 7 });
  });
  const result = await readJson<{ revision: number }>('/api/operations', { signal: caller.signal });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { revision: 7 });
  caller.abort();
  assert.equal(requestSignal?.aborted, false, 'completed reads no longer listen to caller cancellation');
});

test('a stalled network read times out and aborts transport without marking the caller cancelled', async t => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal;
    return new Promise(() => undefined);
  });
  await assert.rejects(readJson('/api/team-activity', { signal: caller.signal, timeoutMs: 15 }), ReadTimeoutError);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(caller.signal.aborted, false, 'callers must display timeout errors instead of treating them as navigation cancellation');
});

test('the read deadline includes a JSON body that stalls after response headers arrive', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream(), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
  await assert.rejects(readJson('/api/workspace', { timeoutMs: 15 }), ReadTimeoutError);
});

test('caller cancellation rejects promptly even when transport does not settle its promise', async t => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal;
    return new Promise(() => undefined);
  });
  const pending = readJson('/api/operations', { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(requestSignal?.aborted, true);
});

test('an already cancelled read never starts a network request', async t => {
  const caller = new AbortController(); caller.abort();
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
  await assert.rejects(readJson('/api/workspace', { signal: caller.signal }), error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(fetch.mock.callCount(), 0);
});

test('401 and 403 are exposed immediately even when their bodies never arrive', async t => {
  let nextStatus = 401, cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: nextStatus }));
  for (const status of [401, 403]) {
    nextStatus = status;
    const result = await readJson('/api/team-activity', { timeoutMs: 100 });
    assert.equal(result.response.status, status);
    assert.deepEqual(result.body, {});
  }
  assert.equal(cancelled, 2);
});

test('malformed successful responses fail clearly and retain normal HTTP error bodies', async t => {
  let nextResponse = new Response('not JSON', { status: 200 });
  t.mock.method(globalThis, 'fetch', async () => nextResponse);
  await assert.rejects(readJson('/api/workspace'), SyntaxError);
  nextResponse = Response.json({ error: 'Please try again shortly.' }, { status: 503 });
  const result = await readJson<{ error: string }>('/api/workspace');
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error, 'Please try again shortly.');
});
