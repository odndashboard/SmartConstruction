-- Permit Admin and Manager to mark a lead Won directly through the lead actions.
-- This changes one guard only; historical rows and document snapshots are untouched.
begin;

do $migration$
declare
  v_function oid := 'public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure;
  v_body text;
  v_definition text;
  v_old text := $old$        if (v_item->>'status')='WON' and coalesce(v_existing->>'status','NEW')<>'WON' and p_action<>'quote_accept' then
          raise exception using errcode='PT400',message='Won status is recorded by accepting a quotation.';
        end if;$old$;
  v_new text := $new$        if (v_item->>'status')='WON' and coalesce(v_existing->>'status','NEW')<>'WON' and not (
          p_action='quote_accept' or (p_action in ('lead_save','lead_status') and v_actor.role in ('OWNER','MANAGER'))
        ) then
          raise exception using errcode='PT400',message='Only Admin and Manager can mark a lead Won.';
        end if;$new$;
begin
  select replace(prosrc,E'\r\n',E'\n') into v_body from pg_proc where oid=v_function;
  -- Exact predecessor: 20261127062903_lead_expected_kw.sql. Refuse unexpected
  -- function drift instead of replacing or weakening other live authorization.
  if md5(v_body) is distinct from 'b111f2c55ac530651533d8795e95411e' then
    raise exception using errcode='55000',message='Lead status migration requires the verified expected-kW commit function.';
  end if;
  v_old := replace(v_old,E'\r\n',E'\n');
  v_new := replace(v_new,E'\r\n',E'\n');
  v_definition := replace(pg_get_functiondef(v_function),E'\r\n',E'\n');
  if position(v_old in v_definition)=0 or
    length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old) then
    raise exception using errcode='55000',message='Expected lead Won guard was not found exactly once.';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$migration$;

-- CREATE OR REPLACE retains the existing service-role-only EXECUTE grants.
notify pgrst, 'reload schema';
commit;
