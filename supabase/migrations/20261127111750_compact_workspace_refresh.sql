-- A refresh can omit unchanged CRM collections, but must verify current access
-- and return the current member on every request. Existing full reads stay intact.
begin;

create function public.crm_workspace_refresh(p_actor_id uuid,p_known_revision bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_revision bigint; v_actor crm.members;
begin
  perform crm.require_service();
  -- Core writes lock this same row before changing members or CRM records. Keep
  -- the revision decision and the returned snapshot within that shared lock.
  select revision into v_revision from crm.workspace where id=1 for share;
  if not found then raise exception using errcode='PT503',message='The CRM database is not initialized.'; end if;
  v_actor:=crm.active_member(p_actor_id);
  if p_known_revision is null or p_known_revision<0 then
    raise exception using errcode='PT400',message='A valid workspace revision is required.';
  end if;
  if v_revision=p_known_revision then
    return jsonb_build_object('unchanged',true,'revision',v_revision,'user',crm.member_json(v_actor));
  end if;
  return public.crm_workspace_read(p_actor_id,false);
end;
$$;

revoke all on function public.crm_workspace_refresh(uuid,bigint) from public,anon,authenticated;
grant execute on function public.crm_workspace_refresh(uuid,bigint) to service_role;
notify pgrst,'reload schema';
commit;
