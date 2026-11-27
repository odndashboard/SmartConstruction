import assert from 'node:assert/strict';
import { after,afterEach,before,beforeEach,describe,test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { todayIST } from '../lib/finance.ts';
import type { WorkspaceData } from '../lib/types.ts';
import type { OperationsData } from '../lib/operations-types.ts';
import { completeQuoteItems } from './fixtures/quotation-items.ts';

const migration='20261127105440_work_order_paper_documents.sql';
const ids={owner:'72000000-0000-4000-8000-000000000001',manager:'72000000-0000-4000-8000-000000000002',
  operations:'72000000-0000-4000-8000-000000000003',sales:'72000000-0000-4000-8000-000000000004',
  accountant:'72000000-0000-4000-8000-000000000005',dealer:'72000000-0000-4000-8000-000000000006'};
const documents=['electricityBill','registrationAllotment','photo','aadhaarCard','panCard','bankPassbook','gmailId'] as const;
const month=todayIST().slice(0,7); const hash='a'.repeat(64);
let db:PGlite; let orderId:string; let baseline:WorkspaceData; let jobHistory:unknown;
async function query<T>(sql:string,values:unknown[]=[]):Promise<T>{return (await db.query<{result:T}>(sql,values)).rows[0]?.result as T;}
async function read(actor=ids.owner):Promise<WorkspaceData>{return query('select public.crm_workspace_read($1::uuid,true) result',[actor]);}
async function rejects(run:()=>Promise<unknown>,codes:string|string[]){
  await db.exec('savepoint expected_failure');
  try {await assert.rejects(run,(e:unknown)=>{const error=e as {code:string;message:string}; assert.ok((Array.isArray(codes)?codes:[codes]).includes(error.code),`${error.code}: ${error.message}`);return true;});}
  finally{await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure');}
}
function empty(before:WorkspaceData){return {company:before.company,sequences:before.sequences,
  upserts:{customers:[] as unknown[],leads:[] as unknown[],followups:[] as unknown[],quotations:[] as unknown[],workorders:[] as unknown[]},
  deleted:{customers:[],leads:[],followups:[],quotations:[],workorders:[]},members:[],audit:[] as WorkspaceData['activity'],clearDemoAudit:false};}
function plan(before:WorkspaceData,action:string,payload:unknown){
  const after=structuredClone(before); const message=applyAction(after,action,payload); const changes=empty(after);
  for(const key of ['customers','leads','followups','quotations','workorders'] as const){
    const old=new Map(before[key].map(row=>[row.id,JSON.stringify(row)]));changes.upserts[key]=after[key].filter(row=>old.get(row.id)!==JSON.stringify(row));
  }
  const events=new Set(before.activity.map(row=>row.id));changes.audit=after.activity.filter(row=>!events.has(row.id));
  return {actor:before.user.userId,revision:before.revision,requestId:crypto.randomUUID(),action,changes,message};
}
async function commit(r:ReturnType<typeof plan>):Promise<{data:WorkspaceData;message:string}>{
  return query('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',[r.actor,r.revision,r.requestId,r.action,hash,JSON.stringify(r.changes),r.message]);
}
async function act(action:string,payload:unknown,actor=ids.owner){return commit(plan(await read(actor),action,payload));}
async function ops():Promise<OperationsData>{return query('select public.crm_operations_v2_read($1::uuid,$2) result',[ids.owner,month]);}
async function history(){return (await query<OperationsData>('select public.crm_job_materials_read($1::uuid,$2,$3) result',[ids.owner,month,orderId])).extension.jobMaterialEntries;}

describe('paper documents with the final Dealer and alerts schema',{concurrency:false},()=>{
  before(async()=>{
    db=new PGlite();
    await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'$$;
      grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.role() to anon,authenticated,service_role;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
    for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')&&file<migration).sort()) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    for(const [name,id] of Object.entries(ids))await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3)',[id,`${name}@example.invalid`,JSON.stringify({name})]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await query('select public.crm_bootstrap_owner($1::uuid) result',[ids.owner]);
    for(const [name,role] of Object.entries({manager:'MANAGER',operations:'OPERATIONS',sales:'SALES',accountant:'ACCOUNTANT',dealer:'DEALER'}))await query('select public.crm_add_member($1::uuid,$2::uuid,$3,$4,$5) result',[ids.owner,ids[name as keyof typeof ids],name,`${name}@example.invalid`,role]);
    orderId=(await act('lead_save',{title:'Existing completed project',status:'WON'})).data.workorders[0].id;
    await act('workorder_save',{id:orderId,status:'ACTIVE'});
    await query('select public.crm_operations_v2_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',[ids.owner,(await ops()).revision,crypto.randomUUID(),'job_filing_complete',hash,JSON.stringify({workOrderId:orderId}),month]);
    await act('workorder_save',{id:orderId,status:'COMPLETED'});
    baseline=await read();jobHistory=await history();
    await db.exec((await readFile(new URL(`../supabase/migrations/${migration}`,import.meta.url),'utf8')).replace(/\r?\n/g,'\r\n'));
  });
  beforeEach(async()=>{await db.exec('begin');});afterEach(async()=>{await db.exec('rollback');});after(async()=>{await db.close();});

  test('upgrade preserves historical work and Job Filing completion without materializing Pending document defaults',async()=>{
    assert.deepEqual(await read(),baseline);assert.deepEqual(await history(),jobHistory);
    assert.equal((await read()).workorders[0].paperDocuments,undefined);
    assert.equal((await ops()).stockMovements.length,0);
  });

  test('Owner, Manager and Operations change one document at a time on completed work and retry without duplicating history',async()=>{
    const original=(await read()).workorders[0];const inventory=await ops();
    for(const [index,document] of documents.entries()){
      const actor=[ids.owner,ids.manager,ids.operations][index%3];
      const req=plan(await read(actor),'workorder_paper_filing',{id:orderId,document,documentStatus:'RECEIVED'});
      const first=await commit(req);const replay=await commit(req);assert.deepEqual(replay,first);
      assert.equal(first.data.workorders[0].paperDocuments?.[document],'RECEIVED');
    }
    const received=(await read()).workorders[0];
    assert.deepEqual(received.paperDocuments,Object.fromEntries(documents.map(key=>[key,'RECEIVED'])));
    assert.deepEqual(received,{...original,paperDocuments:received.paperDocuments,updatedAt:received.updatedAt});
    await act('workorder_paper_filing',{id:orderId,document:'photo',documentStatus:'PENDING'},ids.operations);
    const pending=(await read()).workorders[0];assert.equal(pending.paperDocuments?.photo,'PENDING');assert.equal(pending.paperDocuments?.aadhaarCard,'RECEIVED');
    assert.deepEqual(await history(),jobHistory);assert.deepEqual((await ops()).stockMovements,inventory.stockMovements);assert.deepEqual((await ops()).stockItems,inventory.stockItems);
  });

  test('paper SQL rejects other roles, revoked roles, bulk changes, unsupported values and unrelated work edits atomically',async()=>{
    const before=await read();const req=plan(before,'workorder_paper_filing',{id:orderId,document:'electricityBill',documentStatus:'RECEIVED'});
    for(const actor of [ids.sales,ids.accountant,ids.dealer])await rejects(()=>commit({...req,actor}),'PT403');
    const original=before.workorders[0];
    for(const paperDocuments of [null,[],{unknown:'RECEIVED'},{photo:'GIVEN'},{photo:'received'},{photo:true},{photo:null},{photo:'PENDING'},{photo:'RECEIVED',gmailId:'RECEIVED'}]){
      const forged=structuredClone(req);forged.changes.upserts.workorders=[{...original,paperDocuments}];await rejects(()=>commit(forged),'PT400');
    }
    for(const extra of [{status:'ACTIVE'},{owner:ids.operations},{title:'Other scope'},{milestones:[{id:'forged',title:'Forged'}]},{paperFiling:'RECEIVED'}]){
      const forged=structuredClone(req);forged.changes.upserts.workorders=[{...original,paperDocuments:{photo:'RECEIVED'},...extra}];await rejects(()=>commit(forged),'PT400');
    }
    const missing=structuredClone(req);missing.changes.upserts.workorders=[];await rejects(()=>commit(missing),'PT400');
    const bulk=structuredClone(req);bulk.changes.upserts.workorders=[...req.changes.upserts.workorders,...req.changes.upserts.workorders];await rejects(()=>commit(bulk),'PT400');
    const unknown=structuredClone(req);unknown.changes.upserts.workorders=[{...original,id:crypto.randomUUID(),paperDocuments:{photo:'RECEIVED'}}];await rejects(()=>commit(unknown),'PT400');
    for(const action of ['workorder_save','milestone_add'])await rejects(()=>commit({...req,action}),'PT400');
    assert.deepEqual(await read(),before);
    await db.query("update crm.members set role='SALES' where user_id=$1",[ids.manager]);await rejects(()=>commit({...req,actor:ids.manager}),'PT403');
    await db.query('update crm.members set active=false where user_id=$1',[ids.operations]);await rejects(()=>commit({...req,actor:ids.operations}),'PT403');
  });

  test('documents preserve other document keys and remain separate from cancellation, quote attachment and stock',async()=>{
    await act('workorder_paper_filing',{id:orderId,document:'photo',documentStatus:'RECEIVED'});
    const before=await read();const removal=empty(before);removal.upserts.workorders=[{...before.workorders[0],paperDocuments:{}}];
    await rejects(()=>commit({actor:ids.owner,revision:before.revision,requestId:crypto.randomUUID(),action:'workorder_paper_filing',changes:removal,message:'Cannot remove history'}),'PT400');
    const lead=before.leads[0];const customer=before.customers[0];
    await act('company_save',{name:'Actual contractor',legalName:'Actual contractor',address:'Supplier address',gstin:'',stateCode:'',phone:'',email:'',website:'',terms:''});
    await act('customer_save',{id:customer.id,name:customer.name,address:'Customer address'});
    const quote=(await act('quote_save',{leadId:lead.id,title:'Actual scope',gstEnabled:false,validUntil:todayIST(new Date(Date.now()+30*86400000)),siteAddress:'Actual site',
      items:completeQuoteItems([{id:'scope',description:'Actual scope',quantity:'1',unit:'job',unitPrice:'100',gstRate:'0'}])})).data.quotations[0];
    await act('quote_issue',{id:quote.id});await act('quote_accept',{id:quote.id,acceptanceNote:'Genuine agreement'});
    const attached=(await read()).workorders[0];assert.equal(attached.status,'COMPLETED');assert.equal(attached.paperDocuments?.photo,'RECEIVED');assert.equal(attached.quoteId,quote.id);
    await act('workorder_paper_filing',{id:orderId,document:'gmailId',documentStatus:'RECEIVED'});
    assert.deepEqual(await history(),jobHistory);assert.equal((await ops()).stockMovements.length,0);
    await act('workorder_save',{id:orderId,status:'ACTIVE'});await act('workorder_save',{id:orderId,status:'CANCELLED'});
    const cancelled=await read();const forged=empty(cancelled);forged.upserts.workorders=[{...cancelled.workorders[0],paperDocuments:{...cancelled.workorders[0].paperDocuments,panCard:'RECEIVED'}}];
    await rejects(()=>commit({actor:ids.owner,revision:cancelled.revision,requestId:crypto.randomUUID(),action:'workorder_paper_filing',changes:forged,message:'Cancelled is read only'}),'PT400');
    await act('load_demo',{});
    const examples=await read();const demo=examples.workorders.find(row=>row.isDemo)!;const demoChanges=empty(examples);
    demoChanges.upserts.workorders=[{...demo,paperDocuments:{photo:'RECEIVED'}}];
    await rejects(()=>commit({actor:ids.owner,revision:examples.revision,requestId:crypto.randomUUID(),action:'workorder_paper_filing',changes:demoChanges,message:'Real work only'}),'PT400');
  });

  test('the actual Dealer migration denies site alerts and paper actions while eligible staff retain alerts',async()=>{
    await rejects(()=>query('select public.crm_material_alerts_read($1::uuid) result',[ids.dealer]),'PT403');
    const directory=await query<{assignees:{userId:string}[]}>('select public.crm_material_alerts_read($1::uuid) result',[ids.sales]);
    assert.ok(directory.assignees.every(row=>row.userId!==ids.dealer));
    await act('workorder_save',{id:orderId,status:'ACTIVE'});
    const revision=(await ops()).revision;const payload=JSON.stringify({workOrderId:orderId,itemName:'Site requirement',assigneeId:ids.operations});
    await rejects(()=>query('select public.crm_material_alerts_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) result',[ids.dealer,revision,crypto.randomUUID(),'material_alert_create',hash,payload]),'PT403');
    const report=await query<{data:{alerts:{assigneeId:string}[]}}>('select public.crm_material_alerts_mutate($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb) result',[ids.sales,revision,crypto.randomUUID(),'material_alert_create',hash,payload]);
    assert.equal(report.data.alerts[0].assigneeId,ids.operations);
  });
});
