-- Owner/Manager quotation status controls. Preserve all rows and document data.
-- ISSUED is the existing stored status shown as Awaiting approval in the app.
begin;

do $migration$
declare
  v_target text; v_expected_hash text; v_function oid; v_definition text; v_body text;
  v_old text[]; v_new text[]; v_index integer;
begin
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected_hash in select * from (values
    ('crm.require_action(uuid,text)','dc4a49356f90ef5e4c6d1e6ee858a270'),
    ('public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)','22a402575163a71ac2904991a5835bcf'),
    ('crm.protect_document()','e901d335a23575c2ffa37451c28aaf39')
  ) expected(signature,body_hash)
  loop
    v_function:=v_target::regprocedure;
    select replace(prosrc,chr(13)||chr(10),chr(10)) into v_body from pg_proc where oid=v_function;
    if md5(v_body) is distinct from v_expected_hash then
      raise exception using errcode='55000',message='Quotation status migration requires the verified automatic-work-order schema.';
    end if;
    v_definition:=replace(pg_get_functiondef(v_function),chr(13)||chr(10),chr(10));
    if v_target='crm.require_action(uuid,text)' then
      v_old:=array[$old$when p_action in ('lead_status','quote_issue','quote_accept','quote_decline','quote_convert')$old$];
      v_new:=array[$new$when p_action in ('lead_status','quote_issue','quote_accept','quote_decline','quote_expire','quote_reopen','quote_convert')$new$];
    elsif v_target='public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)' then
      v_old:=array[
$old$when p_action in ('quote_save','quote_decline','quote_revise','company_save') then array['quotations']$old$,
$old$  v_allowed := case$old$
      ];
      v_new:=array[
$new$when p_action in ('quote_save','quote_decline','quote_expire','quote_reopen','quote_revise','company_save') then array['quotations']$new$,
$new$  if p_action in ('quote_expire','quote_reopen') then
    if jsonb_typeof(p_changes->'upserts'->'quotations') is distinct from 'array' or
      jsonb_array_length(p_changes->'upserts'->'quotations')<>1 then
      raise exception using errcode='PT400',message='Change the status of one existing quotation at a time.';
    end if;
    if not exists(select 1 from crm.quotations where id=p_changes->'upserts'->'quotations'->0->>'id') then
      raise exception using errcode='PT404',message='Quotation not found.';
    end if;
  end if;
  v_allowed := case$new$
      ];
    else
      v_old:=array[
$old$      v_old := old.payload->>'status';
      if (v_old='DRAFT'$old$,
$old$         (v_old='ISSUED' and v_new='DECLINED' and v_action is distinct from 'quote_decline') or$old$,
$old$         (v_old in ('DECLINED','EXPIRED') and v_new not in (v_old,'SUPERSEDED')) or$old$
      ];
      v_new:=array[
$new$      v_old := old.payload->>'status';
      -- These controls can change only the quotation status and update time.
      if v_action='quote_expire' and (v_old<>'ISSUED' or v_new<>'EXPIRED') then
        raise exception using errcode='PT400',message='Only a quotation awaiting approval can be marked expired.';
      end if;
      if v_action='quote_reopen' and (v_old<>'EXPIRED' or v_new<>'ISSUED') then
        raise exception using errcode='PT400',message='Only an expired quotation can return to awaiting approval.';
      end if;
      if v_action in ('quote_expire','quote_reopen') and
        (new.payload - array['status','updatedAt']) is distinct from (old.payload - array['status','updatedAt']) then
        raise exception using errcode='PT400',message='A quotation status change cannot alter its issued scope or acceptance details.';
      end if;
      -- Use the database's current India date, never a supplied acceptance time.
      if v_old='ISSUED' and v_new='ACCEPTED' and
        coalesce((old.payload->>'validUntil')::date < (clock_timestamp() at time zone 'Asia/Kolkata')::date,true) then
        raise exception using errcode='PT400',message='The quotation has expired. Create and issue a revision.';
      end if;
      if v_old='EXPIRED' and v_new='ISSUED' and
        coalesce((old.payload->>'validUntil')::date < (clock_timestamp() at time zone 'Asia/Kolkata')::date,true) then
        raise exception using errcode='PT400',message='The original validity date has passed. Create and issue a revision.';
      end if;
      if v_old='DRAFT' and v_new='ISSUED' and
        coalesce((new.payload->>'validUntil')::date < (clock_timestamp() at time zone 'Asia/Kolkata')::date,true) then
        raise exception using errcode='PT400',message='The quotation validity date has passed. Update the draft before issue.';
      end if;
      if (v_old='DRAFT'$new$,
$new$         (v_old='ISSUED' and v_new='DECLINED' and v_action is distinct from 'quote_decline') or
         (v_old='ISSUED' and v_new='EXPIRED' and v_action is distinct from 'quote_expire') or
         (v_old='EXPIRED' and v_new='ISSUED' and v_action is distinct from 'quote_reopen') or$new$,
$new$         (v_old='DECLINED' and v_new not in ('DECLINED','SUPERSEDED')) or
         (v_old='EXPIRED' and v_new not in ('EXPIRED','ISSUED','SUPERSEDED')) or$new$
      ];
    end if;
    for v_index in 1..array_length(v_old,1) loop
      v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10));
      v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
      if position(v_old[v_index] in v_definition)=0 or
        length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
        raise exception using errcode='55000',message='Expected quotation status guard was not found exactly once.';
      end if;
      v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
    end loop;
    execute v_definition;
  end loop;
end;
$migration$;

-- CREATE OR REPLACE preserves the existing private helper and service-only RPC grants.
notify pgrst, 'reload schema';
commit;
