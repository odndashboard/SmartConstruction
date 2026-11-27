-- A package has one real price and zero-priced scope rows. Historical itemized
-- quotations stay intact; no synthetic line, backfill or invoice is created.
begin;
select 1 from crm.workspace where id=1 for update;

create function crm.valid_package_quote(p_payload jsonb,p_supplier_state text) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  v_states text[]:=array['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','26','27','29','30','31','32','33','34','35','36','37','38'];
  v_item jsonb; v_key text; v_price numeric; v_rate numeric; v_place text; v_mode text; v_gst boolean;
  v_cgst numeric:=0; v_sgst numeric:=0; v_utgst numeric:=0; v_igst numeric:=0; v_total numeric;
begin
  if jsonb_typeof(p_payload->'packagePrice') is distinct from 'string' or
    jsonb_typeof(p_payload->'packageGstRate') is distinct from 'string' or
    length(p_payload->>'packagePrice')>30 or (p_payload->>'packagePrice')!~'^[0-9]+(\.[0-9]{1,2})?$' or
    length(p_payload->>'packageGstRate')>30 or (p_payload->>'packageGstRate')!~'^[0-9]+(\.[0-9]{1,2})?$' then return false; end if;
  if p_payload?'gstEnabled' and jsonb_typeof(p_payload->'gstEnabled') is distinct from 'boolean' then return false; end if;
  v_gst:=coalesce((p_payload->>'gstEnabled')::boolean,true);
  v_price:=(p_payload->>'packagePrice')::numeric*100; v_rate:=(p_payload->>'packageGstRate')::numeric*100;
  if v_price>9000000000000 or v_rate>10000 or (not v_gst and v_rate<>0) then return false; end if;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items')>109 or
    jsonb_typeof(p_payload->'totals') is distinct from 'object' then return false; end if;
  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_item) is distinct from 'object' or jsonb_typeof(v_item->'quantity') is distinct from 'string' or
      length(v_item->>'quantity')>30 or (v_item->>'quantity')!~'^[0-9]+(\.[0-9]{1,3})?$' then return false; end if;
    if (v_item->>'quantity')::numeric<=0 or (v_item->>'quantity')::numeric>1000000000 then return false; end if;
    foreach v_key in array array['unitPrice','discount','gstRate'] loop
      if jsonb_typeof(v_item->v_key) is distinct from 'string' or length(v_item->>v_key)>30 or
        (v_item->>v_key)!~'^[0-9]+(\.[0-9]{1,2})?$' then return false; end if;
      if (v_item->>v_key)::numeric<>0 then return false; end if;
    end loop;
    if not v_item @> jsonb_build_object('gross',0,'taxable',0,'cgst',0,'sgst',0,'utgst',0,'igst',0,'total',0) then return false; end if;
    if v_item?'warranty' and (jsonb_typeof(v_item->'warranty') is distinct from 'string' or length(v_item->>'warranty')>200) then return false; end if;
  end loop;
  p_supplier_state:=coalesce(p_supplier_state,''); v_place:=coalesce(p_payload->>'placeOfSupply','');
  if (p_supplier_state<>'' and not p_supplier_state=any(v_states)) or (v_place<>'' and not v_place=any(v_states)) then return false; end if;
  v_mode:=case when not v_gst then 'NO_GST' when p_supplier_state='' or v_place='' then 'UNCONFIGURED'
    when p_supplier_state<>v_place then 'IGST' when p_supplier_state=any(array['04','26','31','35','38']) then 'CGST_UTGST' else 'CGST_SGST' end;
  if v_mode in ('CGST_SGST','CGST_UTGST') then
    v_cgst:=floor((v_price*v_rate+10000)/20000);
    if v_mode='CGST_SGST' then v_sgst:=v_cgst; else v_utgst:=v_cgst; end if;
  elsif v_mode='IGST' then v_igst:=floor((v_price*v_rate+5000)/10000); end if;
  v_total:=v_price+v_cgst+v_sgst+v_utgst+v_igst;
  if v_total>9000000000000 then return false; end if;
  return p_payload->'totals' @> jsonb_build_object('subtotal',v_price,'discount',0,'taxable',v_price,
    'cgst',v_cgst,'sgst',v_sgst,'utgst',v_utgst,'igst',v_igst,'total',v_total,'mode',v_mode,'needsConfig',v_mode='UNCONFIGURED');
end;
$$;
revoke all on function crm.valid_package_quote(jsonb,text) from public,anon,authenticated,service_role;

-- The settings action recalculates drafts before saving workspace.company.
-- Carry its already-authorized target company only within this transaction.
do $migration$
declare v_target regprocedure; v_expected text; v_definition text; v_hash text; v_old text; v_new text;
begin
  for v_target,v_expected in select * from (values
    ('public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure,'3dd6c7d659f3b92619dea482ebf252e8'),
    ('crm.valid_no_gst_quote(jsonb)'::regprocedure,'fa5fe7a64a3a640fa83cc8f8de44b372')
  ) expected(signature,hash) loop
    select md5(replace(prosrc,chr(13)||chr(10),chr(10))),replace(pg_get_functiondef(v_target),chr(13)||chr(10),chr(10))
      into v_hash,v_definition from pg_proc where oid=v_target;
    if v_hash<>v_expected then raise exception using errcode='55000',message='Package pricing requires the verified status-assignment and no-GST contracts.'; end if;
    if v_target='crm.valid_no_gst_quote(jsonb)'::regprocedure then
      v_old:=$old$begin
  if p_payload ? 'gstEnabled'$old$;
      v_new:=$new$begin
  if p_payload?'packagePrice' and p_payload->'gstEnabled'='false'::jsonb then
    return crm.valid_package_quote(p_payload,'');
  end if;
  if p_payload ? 'gstEnabled'$new$;
    else
      v_old:=$old$  perform set_config('crm.action',p_action,true);$old$;
      v_new:=$new$  perform set_config('crm.action',p_action,true);
  perform set_config('crm.quotation_company',case when p_action='company_save' then (p_changes->'company')::text else '' end,true);$new$;
    end if;
    v_old:=replace(v_old,chr(13)||chr(10),chr(10)); v_new:=replace(v_new,chr(13)||chr(10),chr(10));
    if position(v_old in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old) then
      raise exception using errcode='55000',message='Expected package-pricing integration point was not found exactly once.';
    end if;
    execute replace(v_definition,v_old,v_new);
  end loop;
end;
$migration$;

create function crm.protect_package_quote() returns trigger
language plpgsql set search_path='' as $$
declare v_action text:=current_setting('crm.action',true); v_item jsonb; v_source jsonb; v_company jsonb;
  v_supplier_state text; v_context text; v_old_package boolean:=false; v_new_package boolean;
begin
  v_new_package:=new.payload?'packagePrice';
  if tg_op='UPDATE' then
    v_old_package:=old.payload?'packagePrice';
    if v_old_package and not v_new_package then raise exception using errcode='PT400',message='A saved package quotation cannot lose its package price.'; end if;
    if v_action='quote_save' and old.payload->>'status'='DRAFT' and exists(
      select 1 from jsonb_array_elements(old.payload->'items') prior where prior?'warranty'
        and exists(select 1 from jsonb_array_elements(new.payload->'items') item where item->>'id'=prior->>'id' and not (item?'warranty'))
    ) then
      -- Older clients omit warranty; a deliberate blank still clears it.
      select coalesce(jsonb_agg(case when not (item.value?'warranty') and prior.value?'warranty'
        then item.value||jsonb_build_object('warranty',prior.value->'warranty') else item.value end order by item.ordinal),'[]'::jsonb)
        into v_item from jsonb_array_elements(new.payload->'items') with ordinality item(value,ordinal)
        left join lateral (select value from jsonb_array_elements(old.payload->'items') where value->>'id'=item.value->>'id' limit 1) prior on true;
      new.payload:=jsonb_set(new.payload,'{items}',v_item);
    end if;
    if (v_old_package or v_new_package or exists(select 1 from jsonb_array_elements(old.payload->'items') item where item?'warranty')) and v_action in ('quote_issue','company_save') then
      if (new.payload->'packagePrice') is distinct from (old.payload->'packagePrice') or
        (new.payload->'packageGstRate') is distinct from (old.payload->'packageGstRate') or
        coalesce(new.payload->'gstEnabled','true'::jsonb) is distinct from coalesce(old.payload->'gstEnabled','true'::jsonb) or
        crm.quotation_input_rows(new.payload->'items') is distinct from crm.quotation_input_rows(old.payload->'items') then
        raise exception using errcode='PT400',message='Issue and settings changes must preserve package pricing, scope and warranties.';
      end if;
    end if;
  elsif v_action='quote_revise' then
    select payload into v_source from crm.quotations where id=new.payload->>'revisionOf';
    if (new.payload->'packagePrice') is distinct from (v_source->'packagePrice') or
      (new.payload->'packageGstRate') is distinct from (v_source->'packageGstRate') then
      raise exception using errcode='PT400',message='A revision must copy its original package pricing before draft edits.';
    end if;
  end if;
  if not v_new_package and new.payload?'packageGstRate' then raise exception using errcode='PT400',message='A package GST rate requires its package price.'; end if;
  for v_item in select value from jsonb_array_elements(new.payload->'items') loop
    if v_item?'warranty' and (jsonb_typeof(v_item->'warranty') is distinct from 'string' or length(v_item->>'warranty')>200) then
      raise exception using errcode='PT400',message='Enter warranty as text up to 200 characters.';
    end if;
  end loop;
  if not v_new_package then return new; end if;
  select company into v_company from crm.workspace where id=1;
  if v_action='company_save' then
    v_context:=nullif(current_setting('crm.quotation_company',true),'');
    if v_context is not null then v_company:=v_context::jsonb; end if;
  end if;
  if new.payload->>'status'='DRAFT' then v_supplier_state:=v_company->>'stateCode';
  else v_supplier_state:=new.payload#>>'{supplier,stateCode}'; end if;
  if v_action='quote_issue' and (new.payload#>>'{supplier,stateCode}') is distinct from (v_company->>'stateCode') then
    raise exception using errcode='PT400',message='Issue package pricing with the current supplier registration state.';
  end if;
  if not crm.valid_package_quote(new.payload,v_supplier_state) or
    (new.payload->>'status'<>'DRAFT' and new.payload#>>'{totals,mode}'='UNCONFIGURED') then
    raise exception using errcode='PT400',message='Package price, GST and zero-priced work items must match the calculated quotation total.';
  end if;
  return new;
end;
$$;
create trigger quotations_package_guard before insert or update on crm.quotations for each row execute function crm.protect_package_quote();
revoke all on function crm.protect_package_quote() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
