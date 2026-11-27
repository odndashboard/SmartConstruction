-- Contacted / Site visit may change their assignee in the same authorized
-- status transaction. Older clients keep the stored owner without extra input.
begin;
select 1 from crm.workspace where id=1 for update;

do $migration$
declare v_target regprocedure:='public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure;
  v_definition text; v_hash text;
  v_old text:=$old$        if p_action='lead_status' and
          (v_item - array['status','lostReason','updatedAt']) is distinct from
          (v_existing - array['status','lostReason','updatedAt']) then
          raise exception using errcode='PT400',message='A status action cannot change other lead details.';
        end if;$old$;
  v_new text:=$new$        if p_action='lead_status' then
          if (v_item - array['status','lostReason','owner','updatedAt']) is distinct from
            (v_existing - array['status','lostReason','owner','updatedAt']) then
            raise exception using errcode='PT400',message='A status action cannot change other lead details.';
          end if;
          if (v_item->'owner') is distinct from (v_existing->'owner') then
            if v_item->>'status' not in ('CONTACTED','SITE_VISIT') then
              raise exception using errcode='PT400',message='Assign a person here only for Contacted or Site visit.';
            end if;
            if jsonb_typeof(v_item->'owner') is distinct from 'string' or length(v_item->>'owner')>200 or
              v_item->>'owner'<>btrim(v_item->>'owner') then
              raise exception using errcode='PT400',message='Choose a valid assignee or Unassigned.';
            end if;
            if v_item->>'owner'<>'' and not exists(
              select 1 from crm.members m where m.user_id::text=v_item->>'owner' and m.active
            ) then
              raise exception using errcode='PT400',message='Assign this lead to an active team member.';
            end if;
          end if;
        end if;$new$;
begin
  select md5(replace(prosrc,chr(13)||chr(10),chr(10))),replace(pg_get_functiondef(v_target),chr(13)||chr(10),chr(10))
    into v_hash,v_definition from pg_proc where oid=v_target;
  if v_hash<>'fa53b667b413f3ccf9816d2686b36a68' then
    raise exception using errcode='55000',message='Status assignment requires the verified approval-follow-up workspace contract.';
  end if;
  v_old:=replace(v_old,chr(13)||chr(10),chr(10)); v_new:=replace(v_new,chr(13)||chr(10),chr(10));
  if position(v_old in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old) then
    raise exception using errcode='55000',message='Expected status-only guard was not found exactly once.';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$migration$;

notify pgrst,'reload schema';
commit;
