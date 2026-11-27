import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { applyAction } from '../lib/server-actions.ts';
import { computeQuote, todayIST } from '../lib/finance.ts';
import type { WorkspaceData, Quotation, QuoteItemInput } from '../lib/types.ts';
import { completeQuoteItems } from './fixtures/quotation-items.ts';

const owner='71000000-0000-4000-8000-000000000001';
const now=new Date(); const stamp=now.toISOString();
const future=todayIST(new Date(now.getTime()+86400000*30));
const predecessors=['202611230001_crm.sql','20261124072200_accountant_and_lead_status.sql','20261127062903_lead_expected_kw.sql',
  '20261127065452_manual_lead_won.sql','20261127072310_won_lead_workorders.sql','20261127082025_quotation_approval_status.sql',
  '20261127101206_payments_optional_gst_reopen_work.sql'];

test('required-item upgrade preserves true legacy quotes, supports safe revisions and 100 original lines plus nine required rows',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,
        raw_user_meta_data jsonb not null default '{}',is_anonymous boolean not null default false);
      create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role'; $$;
      grant usage on schema auth to anon,authenticated,service_role; grant execute on function auth.role() to anon,authenticated,service_role;`);
    for(const file of predecessors) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`,import.meta.url),'utf8'));
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',[owner,'upgrade@example.invalid',stamp]);
    await db.exec(`select set_config('request.jwt.claims','{"role":"service_role"}',false)`);
    await db.query('select public.crm_bootstrap_owner($1::uuid)',[owner]);
    async function read(){return (await db.query<{data:WorkspaceData}>('select public.crm_workspace_read($1::uuid,true) data',[owner])).rows[0].data;}
    async function act(action:string,payload:unknown){
      const before=await read(); const after=structuredClone(before); const message=applyAction(after,action,payload,now);
      const upserts:Record<string,unknown[]>={}; const deleted:Record<string,string[]>={};
      for(const key of ['customers','leads','followups','quotations','workorders'] as const){
        const old=new Map(before[key].map(row=>[row.id,JSON.stringify(row)]));
        upserts[key]=after[key].filter(row=>old.get(row.id)!==JSON.stringify(row)); deleted[key]=[];
      }
      const oldEvents=new Set(before.activity.map(row=>row.id));
      const changes={company:after.company,sequences:after.sequences,upserts,deleted,members:[],audit:after.activity.filter(row=>!oldEvents.has(row.id)),clearDemoAudit:false};
      return (await db.query<{result:{data:WorkspaceData}}>('select public.crm_workspace_commit($1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7) result',
        [owner,before.revision,crypto.randomUUID(),action,'a'.repeat(64),JSON.stringify(changes),message])).rows[0].result.data;
    }
    await act('company_save',{name:'Legacy contractor',legalName:'Actual legacy contractor',address:'Supplier address',gstin:'06ABCDE1234F1Z5',stateCode:'06',phone:'',email:'',website:'',terms:'Original terms'});
    const data=await act('lead_save',{title:'Existing solar project',stateCode:'06',siteAddress:'Existing site'});
    const lead=data.leads[0]; const customer=data.customers[0];
    await act('customer_save',{id:customer.id,name:customer.name,address:'Historical billing address',stateCode:'06'});
    const baseline=await read();
    const input:QuoteItemInput={id:'legacy-line',description:'Original scope',hsnSac:'9954',quantity:'2',unit:'job',unitPrice:'500',discount:'100',gstRate:'18'};
    async function seed(id:string,issued:boolean,inputs:QuoteItemInput[]=[input],gstEnabled?:boolean){
      const amounts=computeQuote(inputs,'06','06',gstEnabled!==false);
      const draft:Quotation={id,leadId:lead.id,number:null,title:id,validUntil:future,placeOfSupply:'06',siteAddress:'Existing site',terms:'Preserve signed terms',...amounts,
        ...(gstEnabled===undefined?{}:{gstEnabled}),status:'DRAFT',revision:1,acceptanceNote:'',isDemo:false,createdAt:stamp,updatedAt:stamp};
      await db.query("select set_config('crm.action','quote_save',false)");
      await db.query('insert into crm.quotations(id,payload) values($1,$2::jsonb)',[id,JSON.stringify(draft)]);
      if(!issued)return draft;
      const quote:Quotation={...draft,status:'ISSUED',number:`LEGACY/${id}`,issuedAt:stamp,supplier:baseline.company,customer:baseline.customers[0]};
      await db.query("select set_config('crm.action','quote_issue',false)");
      await db.query('update crm.quotations set payload=$2::jsonb where id=$1',[id,JSON.stringify(quote)]);
      return quote;
    }
    const legacyDraft=await seed('legacy-draft',false);
    const legacyIssued=await seed('legacy-issued',true);
    const legacyRevisionSource=await seed('legacy-revision-source',true);
    const hundred=Array.from({length:100},(_,index)=>({...input,id:`old-${index}`,unitPrice:index?'0':'100',discount:'0',gstRate:'0'}));
    const legacyLarge=await seed('legacy-large',false,hundred,false);
    const before=await read();
    await db.exec(await readFile(new URL('../supabase/migrations/20261127102202_required_quotation_items.sql',import.meta.url),'utf8'));
    assert.deepEqual(await read(),before,'Upgrade must not rewrite any business row, counter, role or audit');

    const companyInput:Record<string,unknown>={...baseline.company}; delete companyInput.currency; delete companyInput.timeZone;
    await act('company_save',companyInput);
    const repriced=(await read()).quotations.find(row=>row.id===legacyDraft.id)!;
    assert.deepEqual(repriced.items,legacyDraft.items); assert.equal(repriced.itemSchemaVersion,undefined);
    async function rejectIssue(quote:Quotation){
      await db.exec('begin');
      try {
        await db.query("select set_config('crm.action','quote_issue',true)");
        await assert.rejects(()=>db.query('update crm.quotations set payload=$2::jsonb where id=$1',
          [quote.id,JSON.stringify({...quote,status:'ISSUED',number:`FORGED/${quote.id}`,issuedAt:stamp})]),(error:unknown)=>(error as {code:string}).code==='PT400');
      } finally {await db.exec('rollback');}
    }
    await rejectIssue(repriced);
    const accepted=await act('quote_accept',{id:legacyIssued.id,acceptanceNote:'Existing customer approval'});
    const acceptedQuote=accepted.quotations.find(row=>row.id===legacyIssued.id)!;
    assert.deepEqual(acceptedQuote.items,legacyIssued.items); assert.equal(acceptedQuote.totals.total,legacyIssued.totals.total);
    assert.deepEqual(accepted.workorders.find(row=>row.quoteId===legacyIssued.id)!.snapshot,acceptedQuote);
    const revisedData=await act('quote_revise',{id:legacyRevisionSource.id});
    const revised=revisedData.quotations.find(row=>row.revisionOf===legacyRevisionSource.id)!;
    assert.equal(revised.itemSchemaVersion,undefined); assert.equal(revised.items.length,1);
    assert.equal(revised.items[0].discount,'100'); assert.equal(revised.items[0].hsnSac,'9954');
    await rejectIssue(revised);
    const completed=await act('quote_save',{id:revised.id,leadId:lead.id,title:revised.title,validUntil:future,placeOfSupply:'06',siteAddress:'Existing site',terms:revised.terms,
      items:completeQuoteItems(revised.items.map(({id,description,hsnSac,quantity,unit,unitPrice,discount,gstRate})=>({id,description,hsnSac,quantity,unit,unitPrice,discount,gstRate})))});
    assert.equal(completed.quotations.find(row=>row.id===revised.id)!.totals.total,revised.totals.total);
    await act('quote_issue',{id:revised.id});
    const expanded=await act('quote_save',{id:legacyLarge.id,leadId:lead.id,title:legacyLarge.title,validUntil:future,placeOfSupply:'06',siteAddress:'Existing site',gstEnabled:false,
      items:[...hundred,...completeQuoteItems([])]});
    const large=expanded.quotations.find(row=>row.id===legacyLarge.id)!;
    assert.equal(large.items.length,109); assert.equal(large.totals.total,legacyLarge.totals.total);
    assert.deepEqual(large.items.slice(0,100),legacyLarge.items);
    await act('quote_issue',{id:large.id});
  } finally {await db.close();}
});
