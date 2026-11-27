-- Allow genuine advances before price approval, explicit no-GST quotations and
-- a status-only reopening of completed work. Existing records are not rewritten.
begin;

do $migration$
declare
  v_target text; v_expected_hash text; v_function oid; v_definition text; v_body text;
  v_old text[]; v_new text[]; v_index integer;
begin
  -- Preserve the normal workspace -> operations lock order during rollout.
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected_hash in select * from (values
    ('crm.protect_document()','0e908bf9677e9ea17b9633684892757d'),
    ('crm.contract_amount(text,boolean)','2199b041f61a3bffeddd3ec39b07ebd6'),
    ('crm.payment_account_json(crm.workorders,date)','bfc1f91ffdc464bb00952b92f3b64e0b'),
    ('crm.extension_snapshot(crm.members,text,boolean)','f270c3902ef92ae959bcd5269168cddf'),
    ('public.crm_operations_v2_mutate(uuid,bigint,text,text,text,jsonb,text)','f87f269915fb47f198e728d1bd3c4222')
  ) expected(signature,body_hash)
  loop
    v_function:=to_regprocedure(v_target);
    -- The core-only schema is also supported by the existing migration tests.
    if v_function is null and v_target<>'crm.protect_document()' then continue; end if;
    select replace(prosrc,chr(13)||chr(10),chr(10)) into v_body from pg_proc where oid=v_function;
    if md5(v_body) is distinct from v_expected_hash then
      raise exception using errcode='55000',message='Payments and work status migration requires the verified quotation-status schema.';
    end if;
    v_definition:=replace(pg_get_functiondef(v_function),chr(13)||chr(10),chr(10));
    if v_target='crm.protect_document()' then
      v_old:=array[$old$      if (v_old in ('COMPLETED','CANCELLED') and new.payload is distinct from old.payload) or$old$];
      v_new:=array[$new$      if v_old='COMPLETED' and v_new='ACTIVE' then
        if v_action is distinct from 'workorder_save' or
          (new.payload - array['status','updatedAt']) is distinct from (old.payload - array['status','updatedAt']) then
          raise exception using errcode='PT400',message='Reopening completed work can change only its status.';
        end if;
        return new;
      end if;
      if (v_old in ('COMPLETED','CANCELLED') and new.payload is distinct from old.payload) or$new$];
    elsif v_target='crm.contract_amount(text,boolean)' then
      v_old:=array[$old$ v_text:=v.payload#>>'{snapshot,totals,total}';$old$];
      v_new:=array[$new$ -- An unpriced Won order can receive advances, but has no agreed balance.
 if v.quote_id is null and v.payload->'snapshot'='null'::jsonb and
   exists(select 1 from crm.leads l where l.id=v.lead_id and l.status='WON' and not l.is_demo) then
   return null;
 end if;
 v_text:=v.payload#>>'{snapshot,totals,total}';$new$];
    elsif v_target='crm.payment_account_json(crm.workorders,date)' then
      v_old:=array[$old$'outstandingPaise',(v_contract-v_received)::text,$old$];
      v_new:=array[$new$'outstandingPaise',case when v_contract is null then null else greatest(0,v_contract-v_received)::text end,
  'overpaidPaise',case when v_contract is null then '0' else greatest(0,v_received-v_contract)::text end,$new$];
    elsif v_target='crm.extension_snapshot(crm.members,text,boolean)' then
      v_old:=array[$old$from crm.workorders w where not w.is_demo and w.quote_id is not null;$old$];
      v_new:=array[$new$from crm.workorders w where not w.is_demo;$new$];
    else
      v_old:=array[
$old$  v_amount:=crm.operations_decimal(p_payload,'amount',2); v_name:=crm.operations_text(p_payload,'title',200,true);$old$,
$old$  if crm.payment_net(v_work_order)+v_amount>v_contract then$old$
      ];
      v_new:=array[
$new$  if v_contract is null then raise exception using errcode='PT409',message='Accept a quotation before scheduling payment installments. Advances can be recorded now.'; end if;
  v_amount:=crm.operations_decimal(p_payload,'amount',2); v_name:=crm.operations_text(p_payload,'title',200,true);$new$,
$new$  if v_contract is not null and crm.payment_net(v_work_order)+v_amount>v_contract then$new$
      ];
    end if;
    for v_index in 1..array_length(v_old,1) loop
      v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10));
      v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
      if position(v_old[v_index] in v_definition)=0 or
        length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
        raise exception using errcode='55000',message='Expected payments or work status guard was not found exactly once.';
      end if;
      v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
    end loop;
    execute v_definition;
  end loop;
end;
$migration$;

-- Legacy absent gstEnabled means the original GST calculation. New explicit
-- no-GST documents must carry an honest, arithmetically consistent zero-tax price.
create function crm.valid_no_gst_quote(p_payload jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  v_item jsonb; v_key text; v_quantity numeric; v_price numeric; v_discount numeric;
  v_gross numeric; v_taxable numeric; v_subtotal numeric:=0; v_discounts numeric:=0; v_total numeric:=0;
begin
  if p_payload ? 'gstEnabled' and jsonb_typeof(p_payload->'gstEnabled') is distinct from 'boolean' then return false; end if;
  if p_payload->'gstEnabled' is distinct from 'false'::jsonb then
    return coalesce(p_payload#>>'{totals,mode}','')<>'NO_GST';
  end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_typeof(p_payload->'totals') is distinct from 'object' then return false; end if;
  if jsonb_array_length(p_payload->'items')>100 or
    p_payload#>>'{totals,mode}' is distinct from 'NO_GST' or
    p_payload#>'{totals,needsConfig}' is distinct from 'false'::jsonb then return false; end if;
  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
    foreach v_key in array array['quantity','unitPrice','discount','gstRate'] loop
      if jsonb_typeof(v_item->v_key) is distinct from 'string' then return false; end if;
    end loop;
    if length(v_item->>'quantity')>30 or (v_item->>'quantity')!~'^[0-9]+(\.[0-9]{1,3})?$' or
      length(v_item->>'unitPrice')>30 or (v_item->>'unitPrice')!~'^[0-9]+(\.[0-9]{1,2})?$' or
      length(v_item->>'discount')>30 or (v_item->>'discount')!~'^([0-9]+(\.[0-9]{1,2})?)?$' or
      length(v_item->>'gstRate')>30 or (v_item->>'gstRate')!~'^[0-9]+(\.[0-9]{1,2})?$' then return false; end if;
    v_quantity:=(v_item->>'quantity')::numeric; v_price:=(v_item->>'unitPrice')::numeric*100;
    v_discount:=coalesce(nullif(v_item->>'discount',''),'0')::numeric*100;
    if v_quantity<=0 or v_quantity>1000000000 or v_price>9000000000000 or (v_item->>'gstRate')::numeric<>0 then return false; end if;
    v_gross:=floor(v_quantity*v_price+0.5); v_taxable:=v_gross-v_discount;
    if v_gross>9000000000000 or v_taxable<0 then return false; end if;
    if not v_item @> jsonb_build_object('gross',v_gross,'taxable',v_taxable,'cgst',0,'sgst',0,'utgst',0,'igst',0,'total',v_taxable) then return false; end if;
    v_subtotal:=v_subtotal+v_gross; v_discounts:=v_discounts+v_discount; v_total:=v_total+v_taxable;
  end loop;
  if v_subtotal>9000000000000 or v_total>9000000000000 then return false; end if;
  return (p_payload->'totals') @> jsonb_build_object('subtotal',v_subtotal,'discount',v_discounts,'taxable',v_total,
    'cgst',0,'sgst',0,'utgst',0,'igst',0,'total',v_total);
end;
$$;
revoke all on function crm.valid_no_gst_quote(jsonb) from public,anon,authenticated,service_role;
alter table crm.quotations add constraint quotations_gst_mode_check check (crm.valid_no_gst_quote(payload));

-- CREATE OR REPLACE retains the existing service-only RPC and private grants.
notify pgrst, 'reload schema';
commit;
