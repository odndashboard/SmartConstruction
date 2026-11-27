-- Require all nine quoted categories on new saves and issue. Existing issued
-- snapshots and legacy drafts remain intact; old revisions may be completed later.
begin;

create function crm.valid_required_quote_items(p_payload jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare
  v_required text[]:=array['Panels','Inverter','Structure','DC Wire','Ac Wire','Earthing Wire','Earthing ROD','Lighting Arrester','Filing'];
  v_categories text[]:='{}'; v_ids text[]:='{}'; v_item jsonb; v_category text;
begin
  if p_payload->'itemSchemaVersion' is distinct from '2'::jsonb or
    jsonb_typeof(p_payload->'items') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_payload->'items') not between 9 and 109 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_item) is distinct from 'object' or
      jsonb_typeof(v_item->'id') is distinct from 'string' or length(btrim(v_item->>'id')) not between 1 and 120 or
      jsonb_typeof(v_item->'description') is distinct from 'string' or length(btrim(v_item->>'description')) not between 1 and 2000 or
      jsonb_typeof(v_item->'unit') is distinct from 'string' or length(btrim(v_item->>'unit')) not between 1 and 24 or
      jsonb_typeof(v_item->'quantity') is distinct from 'string' or length(v_item->>'quantity')>30 or
      (v_item->>'quantity')!~'^[0-9]+(\.[0-9]{1,3})?$' or
      jsonb_typeof(v_item->'unitPrice') is distinct from 'string' or length(v_item->>'unitPrice')>30 or
      (v_item->>'unitPrice')!~'^[0-9]+(\.[0-9]{1,2})?$' then return false; end if;
    if v_item->>'id'=any(v_ids) or (v_item->>'quantity')::numeric<=0 or
      (v_item->>'quantity')::numeric>1000000000 or (v_item->>'unitPrice')::numeric>90000000000 then return false; end if;
    v_ids:=array_append(v_ids,v_item->>'id');
    if v_item ? 'category' then
      v_category:=v_item->>'category';
      if jsonb_typeof(v_item->'category') is distinct from 'string' or
        not (v_category=any(v_required)) or v_category=any(v_categories) then return false; end if;
      v_categories:=array_append(v_categories,v_category);
    end if;
  end loop;
  return v_categories @> v_required;
end;
$$;

-- Comparing input rows lets settings recalculate legacy drafts without changing
-- their original scope, and lets revisions copy rows with fresh per-row IDs.
create function crm.quotation_input_rows(p_items jsonb,p_copy boolean default false) returns jsonb
language sql immutable set search_path='' as $$
  select case when jsonb_typeof(p_items)='array' then (
    select coalesce(jsonb_agg(value - (array['gross','taxable','cgst','sgst','utgst','igst','total'] ||
      case when p_copy then array['id'] else array[]::text[] end) order by ordinal),'[]'::jsonb)
    from jsonb_array_elements(p_items) with ordinality as items(value,ordinal)
  ) else null end;
$$;
revoke all on function crm.valid_required_quote_items(jsonb),crm.quotation_input_rows(jsonb,boolean) from public,anon,authenticated,service_role;

do $migration$
declare v_target text; v_expected text; v_function oid; v_body text; v_definition text; v_old text; v_new text;
begin
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected in select * from (values
    ('crm.protect_document()','9c16c61788cbea2195c4f4a97533653f'),
    ('crm.valid_no_gst_quote(jsonb)','8b6ccd0a2d43c717c09e7569f84ce17d')
  ) expected(signature,body_hash)
  loop
    v_function:=v_target::regprocedure;
    select replace(prosrc,chr(13)||chr(10),chr(10)) into v_body from pg_proc where oid=v_function;
    if md5(v_body) is distinct from v_expected then
      raise exception using errcode='55000',message='Required quote items migration requires the verified payments and optional-GST schema.';
    end if;
    v_definition:=replace(pg_get_functiondef(v_function),chr(13)||chr(10),chr(10));
    if v_target='crm.valid_no_gst_quote(jsonb)' then
      -- Up to 100 existing legacy rows plus the nine mandatory categories.
      v_old:=$old$jsonb_array_length(p_payload->'items')>100$old$;
      v_new:=$new$jsonb_array_length(p_payload->'items')>109$new$;
    else
      v_old:=$old$  if tg_table_name = 'quotations' then
    v_new := new.payload->>'status';$old$;
      v_new:=$new$  if tg_table_name = 'quotations' then
    v_new := new.payload->>'status';
    if v_action='quote_save' then
      if not crm.valid_required_quote_items(new.payload) then
        raise exception using errcode='PT400',message='Complete all nine quotation items with their descriptions, quantities, units and non-negative prices.';
      end if;
    elsif tg_op='INSERT' and not (v_action='load_demo' and coalesce((new.payload->>'isDemo')::boolean,false)) then
      if v_action='quote_revise' then
        select payload into v_quote from crm.quotations where id=new.payload->>'revisionOf';
        if v_quote is null or v_quote->>'status' is distinct from 'SUPERSEDED' or
          v_quote->>'leadId' is distinct from new.payload->>'leadId' or
          v_quote->'isDemo' is distinct from new.payload->'isDemo' or
          (v_quote->>'revision')::integer+1 is distinct from (new.payload->>'revision')::integer or
          crm.quotation_input_rows(new.payload->'items',true) is distinct from crm.quotation_input_rows(v_quote->'items',true) then
          raise exception using errcode='PT400',message='A quotation revision must copy its existing issued scope before editing.';
        end if;
        if (new.payload ? 'itemSchemaVersion' or v_quote ? 'itemSchemaVersion') and
          not crm.valid_required_quote_items(new.payload) then
          raise exception using errcode='PT400',message='A current quotation revision must retain all nine completed items.';
        end if;
      elsif not crm.valid_required_quote_items(new.payload) then
        raise exception using errcode='PT400',message='New quotations require all nine completed items.';
      end if;
    elsif tg_op='UPDATE' and old.payload->>'status'='DRAFT' then
      if v_new='ISSUED' or new.payload ? 'itemSchemaVersion' or old.payload ? 'itemSchemaVersion' then
        if not crm.valid_required_quote_items(new.payload) then
          raise exception using errcode='PT400',message='Complete all nine quotation items before issuing this draft.';
        end if;
      elsif v_action='company_save' then
        if (new.payload-array['items','totals','updatedAt']) is distinct from (old.payload-array['items','totals','updatedAt']) or
          crm.quotation_input_rows(new.payload->'items') is distinct from crm.quotation_input_rows(old.payload->'items') then
          raise exception using errcode='PT400',message='Company settings cannot change a legacy quotation''s scope.';
        end if;
      elsif new.payload is distinct from old.payload then
        raise exception using errcode='PT400',message='Complete all nine quotation items before saving this legacy draft.';
      end if;
    end if;$new$;
    end if;
    v_old:=replace(v_old,chr(13)||chr(10),chr(10)); v_new:=replace(v_new,chr(13)||chr(10),chr(10));
    if position(v_old in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old) then
      raise exception using errcode='55000',message='Expected quotation item guard was not found exactly once.';
    end if;
    execute replace(v_definition,v_old,v_new);
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
