import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationsMutationSchema } from '../lib/operations-validation.ts';
import { receiptIdentitySchema } from '../lib/operations-extensions-validation.ts';

const a='10000000-0000-4000-8000-000000000001', b='20000000-0000-4000-8000-000000000002';
const envelope={expectedRevision:1,requestId:'request-0001',month:'2026-11'};
function parse(action:string,payload:unknown,extra:Record<string,unknown>={}) { return operationsMutationSchema.safeParse({...envelope,action,payload,...extra}); }
const cases:Record<string,Record<string,unknown>>={
  site_save:{name:'Sector 14',workOrderId:'work-123'},site_active:{id:a,active:true},site_assign:{userId:a,siteId:b},
  shift_rule_save:{configured:true,startLocal:'09:00',endLocal:'18:00',breakMinutes:60,graceMinutes:10},attendance_overtime_approve:{id:a,minutes:30,reason:'Approved extra work'},
  stock_location_move:{itemId:a,siteId:b,type:'IN',quantity:'1.250'},stock_transfer:{itemId:a,fromSiteId:a,toSiteId:b,quantity:'1'},stock_return:{movementId:a,quantity:'0.500',reason:'Unused bags'},
  material_request_create:{siteId:a,itemId:b,quantity:'10'},material_request_cancel:{id:a,reason:'No longer required'},material_request_review:{id:a,status:'APPROVED'},material_request_fulfill:{id:a,fromSiteId:b,quantity:'5'},
  purchase_order_create:{supplier:'Cement supplier',siteId:a,lines:[{itemId:b,quantity:'20'}]},purchase_order_receive:{id:a,lines:[{lineId:b,quantity:'5'}]},purchase_order_cancel:{id:a,reason:'Cancel unreceived balance'},
  payment_installment_add:{workOrderId:'work-123',title:'Advance',dueDate:'2026-11-23',amount:'15000.50'},payment_installment_cancel:{id:a,reason:'Revised payment plan'},
  payment_record:{workOrderId:'work-123',paymentDate:'2026-11-23',amount:'5000.25',method:'UPI'},payment_void:{id:a,reason:'Entered twice'},
};
test('all extension actions validate their documented payloads and normalize optional text',()=>{
  for(const [action,payload] of Object.entries(cases)){ const result=parse(action,payload);assert.ok(result.success,`${action}: ${JSON.stringify(result.error)}`); }
  assert.ok(parse('site_assign',{userId:a,siteId:null}).success);
  assert.ok(parse('shift_rule_save',{configured:false}).success);
});
test('extension requests reject caller role, actor, permission, calculated totals and unknown fields',()=>{
  for(const [action,payload] of Object.entries(cases)){
    assert.equal(parse(action,{...payload,actorId:a}).success,false,action);
    assert.equal(parse(action,payload,{role:'OWNER'}).success,false,action);
    assert.equal(parse(action,{...payload,approved:true}).success,false,action);
  }
  assert.equal(parse('payment_record',{...cases.payment_record,receivedPaise:1}).success,false);
});
test('shift windows, overnight flags, unpaid breaks and grace minutes have explicit boundaries',()=>{
  assert.ok(parse('shift_rule_save',{configured:true,startLocal:'22:00',endLocal:'06:00',overnight:true,breakMinutes:30}).success);
  for(const payload of [
    {configured:true}, {configured:true,startLocal:'09:00',endLocal:'08:00'},
    {configured:true,startLocal:'09:00',endLocal:'18:00',overnight:true},
    {configured:true,startLocal:'24:00',endLocal:'18:00'},
    {configured:true,startLocal:'09:00',endLocal:'18:00',breakMinutes:540},
    {configured:true,startLocal:'09:00',endLocal:'18:00',graceMinutes:121},
    {configured:true,startLocal:'09:00',endLocal:'18:00',breakMinutes:1.5},
  ])assert.equal(parse('shift_rule_save',payload).success,false,JSON.stringify(payload));
});
test('stock transfers/returns require positive exact quantities and a genuine destination',()=>{
  assert.equal(parse('stock_transfer',{...cases.stock_transfer,toSiteId:a}).success,false);
  for(const quantity of ['0','-1','1.0001','1e3',1,'9000000000.001']){
    assert.equal(parse('stock_return',{...cases.stock_return,quantity}).success,false,String(quantity));
    assert.equal(parse('stock_transfer',{...cases.stock_transfer,quantity}).success,false,String(quantity));
  }
  assert.ok(parse('stock_location_move',{...cases.stock_location_move,type:'ADJUST',quantity:'0',note:'Counted empty'}).success);
  assert.equal(parse('stock_location_move',{...cases.stock_location_move,type:'ADJUST',quantity:'0'}).success,false);
});
test('purchase orders and receipts reject duplicate lines and invalid quantities',()=>{
  assert.equal(parse('purchase_order_create',{...cases.purchase_order_create,lines:[{itemId:a,quantity:'1'},{itemId:a,quantity:'2'}]}).success,false);
  assert.equal(parse('purchase_order_receive',{...cases.purchase_order_receive,lines:[{lineId:a,quantity:'1'},{lineId:a,quantity:'2'}]}).success,false);
  assert.equal(parse('purchase_order_receive',{id:a,lines:[]}).success,false);
  assert.equal(parse('purchase_order_create',{...cases.purchase_order_create,lines:[{itemId:a,quantity:'0'}]}).success,false);
});
test('payments use decimal INR, real dates, controlled methods and reasons for irreversible-record reversals',()=>{
  for(const amount of ['0','-1','1.001','1e3','1,000',12,'90000000000.01'])assert.equal(parse('payment_record',{...cases.payment_record,amount}).success,false,String(amount));
  assert.equal(parse('payment_record',{...cases.payment_record,paymentDate:'2026-02-30'}).success,false);
  assert.equal(parse('payment_record',{...cases.payment_record,method:'CRYPTO'}).success,false);
  assert.equal(parse('payment_void',{id:a,reason:''}).success,false);
  assert.equal(parse('payment_installment_cancel',{id:a,reason:'  '}).success,false);
});
test('receipt identities cannot supply an object path, bucket, owner or unbounded request ID',()=>{
  assert.ok(receiptIdentitySchema.safeParse({expenseId:a,requestId:'upload-request-1'}).success);
  for(const fields of [{objectPath:'another/receipt.pdf'},{bucket:'public'},{userId:b},{requestId:'../upload'},{expenseId:'not-a-uuid'}])assert.equal(receiptIdentitySchema.safeParse({expenseId:a,requestId:'upload-request-1',...fields}).success,false);
});
