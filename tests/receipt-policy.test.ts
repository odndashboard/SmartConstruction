import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectReceipt, receiptFileName, receiptContentDisposition, RECEIPT_MAX_BYTES } from '../lib/receipt-policy.ts';
import { finishReceiptUpload, type ReceiptReservation } from '../lib/receipt-workflow.ts';

const pdf = new TextEncoder().encode('%PDF-1.7\nA test receipt');
test('receipt uploads accept supported signatures and detect original files with a generic MIME', () => {
  assert.equal(inspectReceipt(pdf, 'application/pdf'), 'application/pdf');
  assert.equal(inspectReceipt(pdf, 'application/octet-stream'), 'application/pdf');
  const png = new Uint8Array(30); png.set([137,80,78,71,13,10,26,10]); png.set(new TextEncoder().encode('IHDR'),12);
  assert.equal(inspectReceipt(png, 'image/png'), 'image/png');
  const jpg = new Uint8Array(20); jpg.set([255,216,255]); assert.equal(inspectReceipt(jpg, 'image/jpg'), 'image/jpeg');
  const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFF')); webp.set(new TextEncoder().encode('WEBPVP8 '),8);
  assert.equal(inspectReceipt(webp, 'image/webp'), 'image/webp');
});
test('receipt uploads reject active content, disguised HTML, mismatched MIME and oversized bodies', () => {
  for (const content of ['<svg onload="alert(1)"/>', '<html>not a receipt</html>', 'GIF89a not a supported image']) assert.throws(() => inspectReceipt(new TextEncoder().encode(content), 'image/png'));
  assert.throws(() => inspectReceipt(pdf, 'image/jpeg'));
  assert.throws(() => inspectReceipt(new Uint8Array(), 'application/pdf'));
  assert.throws(() => inspectReceipt(new Uint8Array(RECEIPT_MAX_BYTES + 1), 'application/pdf'));
});
test('receipt filenames and download headers contain no path, control or direction-changing characters', () => {
  const name = receiptFileName('../../bill\r\nX-Evil: 1\u202e.exe', 'application/pdf');
  assert.match(name, /\.pdf$/); assert.doesNotMatch(name, /[\r\n/\\\u202e]/);
  assert.ok(name.length <= 124);
  const header = receiptContentDisposition(receiptFileName('साइट बिल.pdf','application/pdf'), true);
  assert.ok(header.startsWith('attachment;'));
  assert.ok(header.includes("filename*=UTF-8''")); assert.doesNotMatch(header, /[\r\n]/);
});

const reservation: ReceiptReservation = {
  id:'10000000-0000-4000-8000-000000000001', expenseId:'20000000-0000-4000-8000-000000000001',
  fileName:'receipt.pdf',mimeType:'application/pdf',sizeBytes:22,uploadedBy:'30000000-0000-4000-8000-000000000001',createdAt:'2026-11-23T12:00:00Z',
  state:'PENDING',bucket:'crm-expense-receipts',objectPath:'expenses/example/receipt.pdf',sha256:'a'.repeat(64),
};
test('an already completed upload retry returns only safe metadata without storing or completing again', async () => {
  let mutations = 0;
  const result = await finishReceiptUpload({ reserve:async()=>({...reservation,state:'READY'}),upload:async()=>{mutations++;return 'CREATED';},verifyExisting:async()=>false,complete:async()=>{mutations++;return reservation;} });
  assert.equal(mutations,0); assert.equal(result.id,reservation.id);
  assert.equal('objectPath' in result,false); assert.equal('sha256' in result,false); assert.equal('bucket' in result,false);
});
test('duplicate-object retries verify exact original bytes before completing their reservation', async () => {
  const calls:string[]=[];
  await finishReceiptUpload({ reserve:async()=>{calls.push('reserve');return reservation;},upload:async()=>{calls.push('exists');return 'EXISTS';},verifyExisting:async()=>{calls.push('verify');return true;},complete:async()=>{calls.push('complete');return reservation;} });
  assert.deepEqual(calls,['reserve','exists','verify','complete']);
  await assert.rejects(finishReceiptUpload({ reserve:async()=>reservation,upload:async()=>'EXISTS',verifyExisting:async()=>false,complete:async()=>{throw new Error('should not complete');} }), /RECEIPT_OBJECT_MISMATCH/);
});
test('failed authorization/upload/complete is never reported as successful or destructively cleaned up', async () => {
  let uploaded=false, completed=false;
  await assert.rejects(finishReceiptUpload({ reserve:async()=>{throw new Error('forbidden');},upload:async()=>{uploaded=true;return 'CREATED';},verifyExisting:async()=>true,complete:async()=>{completed=true;return reservation;} }),/forbidden/);
  assert.equal(uploaded,false); assert.equal(completed,false);
  await assert.rejects(finishReceiptUpload({ reserve:async()=>reservation,upload:async()=>{throw new Error('storage offline');},verifyExisting:async()=>true,complete:async()=>{completed=true;return reservation;} }),/storage offline/);
  assert.equal(completed,false);
  await assert.rejects(finishReceiptUpload({ reserve:async()=>reservation,upload:async()=>'CREATED',verifyExisting:async()=>true,complete:async()=>{throw new Error('membership changed');} }),/membership changed/);
});
