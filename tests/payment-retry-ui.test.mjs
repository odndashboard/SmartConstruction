import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../components/OperationsPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('OperationsPanel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workspace = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'OperationsWorkspace');
const send = workspace.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'send');
const compiled = ts.transpileModule(send.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function transport(responses) {
  const state = { requests: [], uncertain: false, error: '', notice: '', refreshed: 0, retrySuccess: 0, data: null, busy: false };
  const create = new Function('state', 'responses', `
    let uncertain = false;
    const attempt = {current:null}, sending = {current:false}, mounted = {current:true};
    const readController = {current:null}, readSequence = {current:0}, returnFocus = {current:null};
    const PAYMENT_ACCOUNT_HEADERS = {'X-Payment-Accounts':'1'};
    const setLoading = () => {}, setEditor = () => {}, requestAnimationFrame = fn => fn();
    const setBusy = value => state.busy = value;
    const setError = value => state.error = value;
    const setNotice = value => state.notice = value;
    const setUncertain = value => { uncertain = value; state.uncertain = value; };
    const setData = value => state.data = value;
    const setRetrySuccess = update => state.retrySuccess = update(state.retrySuccess);
    const refresh = async () => { state.refreshed++; };
    const fetch = async (url, options) => {
      state.requests.push({url, body:JSON.parse(options.body)});
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return {ok:response.status === 200, status:response.status, json:async()=>response.body};
    };
    ${compiled}
    return {send, retry:()=>send(attempt.current), pending:()=>attempt.current};
  `);
  return { ...create(state, [...responses]), state };
}

const request = {
  action: 'payment_record', requestId: 'same-payment-request', expectedRevision: 7, month: '2026-11',
  payload: {workOrderId:'requested-work-order', paymentDate:'2026-11-27', amount:'123.45', method:'UPI', reference:'Received transfer'},
};

test('an uncertain payment retry confirms the exact original order, amount and request without starting another receipt', async () => {
  const ledger = {revision:8, extension:{customerPayments:[{workOrderId:'requested-work-order', amountPaise:'12345'}]}};
  const client = transport([new Error('connection lost after write'), {status:200, body:{data:ledger, message:'Payment received'}}]);
  assert.equal(await client.send(request), false);
  assert.equal(client.state.uncertain, true);
  assert.equal(client.pending(), request);
  assert.match(client.state.error, /retry the same change/);
  assert.equal(await client.retry(), true);
  assert.deepEqual(client.state.requests.map(item => item.body), [request, request]);
  assert.equal(client.state.data, ledger);
  assert.equal(client.state.retrySuccess, 1);
  assert.equal(client.pending(), null);
  assert.equal(client.state.uncertain, false);
});

test('a conflicting payment refreshes the balances and requires review without automatically resubmitting', async () => {
  const client = transport([{status:409, body:{error:'Changed account balance'}}]);
  assert.equal(await client.send(request), false);
  assert.equal(client.state.refreshed, 1);
  assert.equal(client.state.requests.length, 1);
  assert.equal(client.state.requests[0].body.payload.workOrderId, 'requested-work-order');
  assert.equal(client.state.uncertain, false);
  assert.equal(client.state.busy, false);
  assert.equal(client.pending(), null);
  assert.match(client.state.error, /Review the latest values/);
});
