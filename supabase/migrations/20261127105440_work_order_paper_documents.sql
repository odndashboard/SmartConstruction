-- Paper documents are a separate follow-up checklist. Missing entries display
-- Pending; no existing work, stock usage or Job Filing completion is rewritten.
begin;

create function crm.valid_paper_documents(p_payload jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare v_key text; v_value jsonb;
begin
  if not (p_payload?'paperDocuments') then return true; end if;
  if jsonb_typeof(p_payload->'paperDocuments') is distinct from 'object' then return false; end if;
  for v_key,v_value in select key,value from jsonb_each(p_payload->'paperDocuments') loop
    if v_key not in ('electricityBill','registrationAllotment','photo','aadhaarCard','panCard','bankPassbook','gmailId') or
      v_value not in ('"PENDING"'::jsonb,'"RECEIVED"'::jsonb) then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function crm.valid_paper_documents(jsonb) from public,anon,authenticated,service_role;

do $migration$
declare v_target text; v_expected text; v_function oid; v_body text; v_definition text; v_old text[]; v_new text[]; v_index integer;
begin
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected in select * from (values
    ('crm.require_action(uuid,text)','374c6fe843a46f3b5246b90d764e5d57'),
    ('public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)','a02bd0f5eed5d612e12eff508af49444'),
    ('crm.protect_document()','9ae08e4c8948aaf037632bfc5ada195c')
  ) expected(signature,body_hash) loop
    v_function:=v_target::regprocedure;
    select replace(prosrc,chr(13)||chr(10),chr(10)) into v_body from pg_proc where oid=v_function;
    if md5(v_body) is distinct from v_expected then raise exception using errcode='55000',message='Paper documents require the verified dealer and work-order schema.'; end if;
    v_definition:=replace(pg_get_functiondef(v_function),chr(13)||chr(10),chr(10));
    if v_target='crm.require_action(uuid,text)' then
      v_old:=array[$old$when p_action in ('workorder_save','milestone_add','milestone_complete')$old$];
      v_new:=array[$new$when p_action in ('workorder_save','workorder_paper_filing','milestone_add','milestone_complete')$new$];
    elsif v_target='public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)' then
      v_old:=array[$old$when p_action in ('quote_convert','workorder_save','milestone_add','milestone_complete')$old$,
$old$  v_allowed := case$old$];
      v_new:=array[$new$when p_action in ('quote_convert','workorder_save','workorder_paper_filing','milestone_add','milestone_complete')$new$,
$new$  -- The app rejects unchanged selections; receipt replay remains idempotent.
  if p_action='workorder_paper_filing' and (
    jsonb_array_length(p_changes->'upserts'->'workorders')<>1 or exists(
      select 1 from jsonb_array_elements(p_changes->'upserts'->'workorders') item
      where not exists(select 1 from crm.workorders w where w.id=item->>'id')
    )
  ) then raise exception using errcode='PT400',message='Update documents for one existing work order at a time.'; end if;
  v_allowed := case$new$];
    else
      v_old:=array[
$old$declare v_old text; v_new text; v_quote jsonb;$old$,
$old$    if tg_op = 'INSERT' then
      if v_action not in ('lead_save'$old$,
$old$      if (new.payload - array['status','owner','startDate','endDate','milestones','updatedAt'])$old$
      ];
      v_new:=array[
$new$declare v_old text; v_new text; v_old_documents jsonb; v_new_documents jsonb; v_document_changes integer; v_quote jsonb;$new$,
$new$    if tg_op = 'INSERT' then
      if not crm.valid_paper_documents(new.payload) then raise exception using errcode='PT400',message='Choose valid document names and Pending or Received statuses.'; end if;
      if new.payload?'paperDocuments' and exists(select 1 from jsonb_each(new.payload->'paperDocuments') d where d.value is distinct from '"PENDING"'::jsonb) then
        raise exception using errcode='PT400',message='New work orders cannot claim documents were already received.';
      end if;
      if v_action not in ('lead_save'$new$,
$new$      if v_action='workorder_paper_filing' then
        if coalesce((old.payload->>'isDemo')::boolean,false) or old.payload->>'status'='CANCELLED' then
          raise exception using errcode='PT400',message='Update documents on a real work order that is not cancelled.';
        end if;
        if (new.payload-array['paperDocuments','updatedAt']) is distinct from (old.payload-array['paperDocuments','updatedAt']) or
          not crm.valid_paper_documents(new.payload) or jsonb_typeof(new.payload->'paperDocuments') is distinct from 'object' then
          raise exception using errcode='PT400',message='A document update cannot change work-order scope, delivery or other records.';
        end if;
        v_old_documents:=coalesce(old.payload->'paperDocuments','{}'::jsonb); v_new_documents:=new.payload->'paperDocuments';
        select count(*) into v_document_changes from (
          select jsonb_object_keys(v_old_documents) as key union select jsonb_object_keys(v_new_documents) as key
        ) keys where coalesce(v_old_documents->keys.key,'"PENDING"'::jsonb) is distinct from v_new_documents->keys.key;
        if v_document_changes<>1 or exists(select 1 from jsonb_object_keys(v_old_documents) as keys(key) where not (v_new_documents?keys.key)) then
          raise exception using errcode='PT400',message='Update one document status while preserving the other documents.';
        end if;
        return new;
      end if;
      if (new.payload - array['status','owner','startDate','endDate','milestones','updatedAt'])$new$
      ];
    end if;
    for v_index in 1..array_length(v_old,1) loop
      v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10)); v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
      if position(v_old[v_index] in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
        raise exception using errcode='55000',message='Expected paper-document guard was not found exactly once.';
      end if;
      v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
    end loop;
    execute v_definition;
  end loop;
end;
$migration$;

alter table crm.workorders add constraint workorders_paper_documents_check check(crm.valid_paper_documents(payload));
notify pgrst, 'reload schema';
commit;
