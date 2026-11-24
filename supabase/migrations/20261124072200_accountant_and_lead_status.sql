-- Add the Accountant employee role without expanding Admin-only data access.
-- Customer records stay intact; removing their standalone screen is a UI change.
-- Only Admin (OWNER) and Manager may change lead status.
begin;

alter table crm.members drop constraint members_role_check;
alter table crm.members add constraint members_role_check
  check (role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT','VIEWER'));

create or replace function crm.require_action(p_actor_id uuid,p_action text) returns crm.members
language plpgsql set search_path = '' as $$
declare v_member crm.members; v_allowed text[];
begin
  v_member := crm.active_member(p_actor_id);
  v_allowed := case
    when p_action in ('customer_save','lead_save','quote_save','quote_revise') then array['OWNER','MANAGER','SALES']
    when p_action in ('followup_save','followup_complete','followup_cancel') then array['OWNER','MANAGER','SALES','OPERATIONS']
    when p_action in ('lead_status','quote_issue','quote_accept','quote_decline','quote_convert') then array['OWNER','MANAGER']
    when p_action in ('workorder_save','milestone_add','milestone_complete') then array['OWNER','MANAGER','OPERATIONS']
    when p_action in ('company_save','member_role','member_active','load_demo','clear_demo','member_invite','member_access_link') then array['OWNER']
    else null end;
  if v_allowed is null then raise exception using errcode='PT400',message='Unknown workspace action.'; end if;
  if not (v_member.role = any(v_allowed)) then raise exception using errcode='PT403',message='Your role does not permit this action.'; end if;
  return v_member;
end;
$$;

create or replace function public.crm_add_member(p_actor_id uuid,p_user_id uuid,p_name text,p_email text,p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor crm.members; v_user auth.users; v_existing crm.members;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for update;
  v_actor := crm.require_action(p_actor_id,'member_invite');
  if p_role not in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT','VIEWER') or p_role is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception using errcode='PT400',message='Choose a valid employee name and CRM role.';
  end if;
  select * into v_user from auth.users where id=p_user_id;
  if not found or coalesce(v_user.email,'')='' or lower(v_user.email) is distinct from lower(btrim(p_email)) or (v_user.banned_until is not null and v_user.banned_until>now()) then
    raise exception using errcode='PT400',message='The invited Auth user must match this employee email.';
  end if;
  select * into v_existing from crm.members where user_id=p_user_id;
  if found then
    if lower(v_existing.email) <> lower(v_user.email) then raise exception using errcode='PT409',message='This membership has a different email address.'; end if;
    return public.crm_workspace_read(p_actor_id,false);
  end if;
  if exists(select 1 from crm.members where lower(email)=lower(v_user.email)) then
    raise exception using errcode='PT409',message='This email already has a CRM membership.';
  end if;
  insert into crm.members(user_id,name,email,role,active) values(p_user_id,btrim(p_name),v_user.email,p_role,true);
  update crm.workspace set revision=revision+1 where id=1;
  perform crm.append_audit(v_actor,'member.invited','member',p_user_id::text,'Added employee '||btrim(p_name)||' as '||lower(p_role));
  return public.crm_workspace_read(p_actor_id,false);
end;
$$;

create or replace function public.crm_workspace_commit(
  p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_action text,
  p_payload_hash text,p_changes jsonb,p_message text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_workspace crm.workspace; v_actor crm.members; v_receipt crm.mutation_receipts;
  v_table text; v_allowed text[]; v_item jsonb; v_id text; v_existing jsonb;
  v_target crm.members; v_new_role text; v_new_active boolean;
  v_key text; v_value jsonb; v_old_count bigint; v_new_count bigint; v_counter_changes integer := 0;
  v_event_id text; v_event jsonb; v_is_demo boolean; v_rows integer;
begin
  perform crm.require_service();
  select * into v_workspace from crm.workspace where id=1 for update;
  if not found then raise exception using errcode='PT503',message='The CRM database is not initialized.'; end if;
  -- A membership change takes the same workspace lock, so this is the current role.
  v_actor := crm.require_action(p_actor_id,p_action);
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode='PT400',message='A valid request ID and payload hash are required.';
  end if;
  select * into v_receipt from crm.mutation_receipts where request_id=p_request_id;
  if found then
    if v_receipt.actor_id <> p_actor_id or v_receipt.action <> p_action or v_receipt.payload_hash <> p_payload_hash then
      raise exception using errcode='PT409',message='This request ID was already used for a different change.';
    end if;
    return jsonb_build_object('data',public.crm_workspace_read(p_actor_id,false),'message',v_receipt.message);
  end if;
  if p_expected_revision is distinct from v_workspace.revision then
    raise exception using errcode='PT409',message='The workspace changed on another device. Refresh and try again.';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or octet_length(p_changes::text)>8000000
    or not (p_changes ?& array['company','sequences','upserts','deleted','members','audit','clearDemoAudit']) then
    raise exception using errcode='PT400',message='Invalid server mutation envelope.';
  end if;
  if jsonb_typeof(p_changes->'company') is distinct from 'object' or jsonb_typeof(p_changes->'sequences') is distinct from 'object'
    or jsonb_typeof(p_changes->'upserts') is distinct from 'object' or jsonb_typeof(p_changes->'deleted') is distinct from 'object'
    or jsonb_typeof(p_changes->'members') is distinct from 'array' or jsonb_typeof(p_changes->'audit') is distinct from 'array'
    or jsonb_typeof(p_changes->'clearDemoAudit') is distinct from 'boolean' or p_message is null or length(p_message)>2000 then
    raise exception using errcode='PT400',message='Invalid server mutation envelope.';
  end if;
  if (p_changes->'company') is distinct from v_workspace.company and p_action <> 'company_save' then
    raise exception using errcode='PT403',message='This action cannot change company settings.';
  end if;
  if (p_changes->'company'->>'currency') is distinct from 'INR' or (p_changes->'company'->>'timeZone') is distinct from 'Asia/Kolkata' then
    raise exception using errcode='PT400',message='Currency and timezone are fixed for this workspace.';
  end if;
  -- Counters cannot be erased, decreased or advanced by unrelated actions.
  for v_key,v_value in select key,value from jsonb_each(v_workspace.sequences) loop
    if not ((p_changes->'sequences') ? v_key) then raise exception using errcode='PT400',message='Document counters cannot be removed.'; end if;
  end loop;
  for v_key,v_value in select key,value from jsonb_each(p_changes->'sequences') loop
    if v_key !~ '^(Q|WO)/[0-9]{4}-[0-9]{2}$' or jsonb_typeof(v_value) <> 'number' or v_value::text !~ '^[0-9]+$' then
      raise exception using errcode='PT400',message='Invalid document counter.';
    end if;
    v_new_count := (v_value::text)::bigint;
    v_old_count := coalesce((v_workspace.sequences->>v_key)::bigint,0);
    if v_new_count <> v_old_count then
      if v_new_count <> v_old_count+1 or v_new_count>999999999 or
        not ((p_action='quote_issue' and v_key like 'Q/%') or (p_action='quote_convert' and v_key like 'WO/%')) then
        raise exception using errcode='PT400',message='A document counter can advance only once in its matching action.';
      end if;
      v_counter_changes := v_counter_changes+1;
    end if;
  end loop;
  if v_counter_changes>1 then raise exception using errcode='PT400',message='Only one document number can be allocated per action.'; end if;
  if jsonb_array_length(p_changes->'members')>0 and p_action not in ('member_role','member_active') then
    raise exception using errcode='PT403',message='This action cannot change team memberships.';
  end if;
  if jsonb_array_length(p_changes->'members')>1 then raise exception using errcode='PT400',message='Change one team member at a time.'; end if;
  v_allowed := case
    when p_action='customer_save' then array['customers']
    when p_action in ('lead_save','lead_status') then array['leads']
    when p_action in ('followup_save','followup_complete','followup_cancel') then array['followups']
    when p_action in ('quote_save','quote_decline','quote_revise','company_save') then array['quotations']
    when p_action in ('quote_issue','quote_accept') then array['leads','quotations']
    when p_action in ('quote_convert','workorder_save','milestone_add','milestone_complete') then array['workorders']
    when p_action='load_demo' then array['customers','leads','followups','quotations','workorders']
    else array[]::text[] end;
  perform set_config('crm.action',p_action,true);
  -- These are server-generated row diffs, not a browser-provided workspace.
  -- Every identifier is bound or comes from the fixed table list below.
  foreach v_table in array array['customers','leads','followups','quotations','workorders'] loop
    if jsonb_typeof(p_changes->'upserts'->v_table) is distinct from 'array' or jsonb_typeof(p_changes->'deleted'->v_table) is distinct from 'array' then
      raise exception using errcode='PT400',message='Invalid entity mutation list.';
    end if;
    if jsonb_array_length(p_changes->'upserts'->v_table)>0 and not (v_table=any(v_allowed)) then
      raise exception using errcode='PT403',message='This action cannot change that record type.';
    end if;
    for v_item in select value from jsonb_array_elements(p_changes->'upserts'->v_table)
      order by case when v_table='quotations' then coalesce((value->>'revision')::integer,1) else 1 end,value->>'id'
    loop
      v_id := v_item->>'id';
      if jsonb_typeof(v_item) <> 'object' or v_id is null or length(v_id) not between 1 and 120 then
        raise exception using errcode='PT400',message='Invalid record identity.';
      end if;
      if p_action='load_demo' and (not coalesce((v_item->>'isDemo')::boolean,false) or v_id not like 'demo\_%' escape '\') then
        raise exception using errcode='PT400',message='Example loading can only create labelled example records.';
      end if;
      execute format('select payload from crm.%I where id=$1',v_table) into v_existing using v_id;
      -- Recheck the stored lead against the current locked member, even if
      -- a stale or malformed server supplies a forged lead_save row diff.
      if v_table='leads' and p_action<>'load_demo' then
        if v_actor.role not in ('OWNER','MANAGER') and (
          (v_item->>'status') is distinct from coalesce(v_existing->>'status','NEW') or
          coalesce(v_item->>'lostReason','') is distinct from coalesce(v_existing->>'lostReason','')
        ) then
          raise exception using errcode='PT403',message='Only Admin and Manager can change lead status.';
        end if;
        if p_action='lead_status' and
          (v_item - array['status','lostReason','updatedAt']) is distinct from
          (v_existing - array['status','lostReason','updatedAt']) then
          raise exception using errcode='PT400',message='A status action cannot change other lead details.';
        end if;
        if (v_item->>'status')='WON' and coalesce(v_existing->>'status','NEW')<>'WON' and p_action<>'quote_accept' then
          raise exception using errcode='PT400',message='Won status is recorded by accepting a quotation.';
        end if;
        if (v_existing->>'status')='WON' and (v_item->>'status') is distinct from 'WON' then
          raise exception using errcode='PT400',message='A won lead cannot be reopened through a status change.';
        end if;
        if (v_existing->>'status')='LOST' and (v_item->>'status') not in ('NEW','LOST') then
          raise exception using errcode='PT400',message='Reopen a lost lead as New enquiry first.';
        end if;
        if (v_item->>'status')='LOST' and length(btrim(coalesce(v_item->>'lostReason','')))=0 then
          raise exception using errcode='PT400',message='Record a reason before marking this lead lost.';
        end if;
      end if;
      if v_existing is not null then
        if p_action='load_demo' then raise exception using errcode='PT409',message='An example record already exists.'; end if;
        execute format('update crm.%I set payload=$2 where id=$1',v_table) using v_id,v_item;
      else
        if p_action not in ('customer_save','lead_save','followup_save','quote_save','quote_revise','quote_convert','load_demo') then
          raise exception using errcode='PT400',message='This action cannot create a new record.';
        end if;
        execute format('insert into crm.%I(id,payload) values($1,$2)',v_table) using v_id,v_item;
      end if;
    end loop;
  end loop;
  -- Delete only explicitly labelled examples, in child-first order.
  foreach v_table in array array['workorders','quotations','followups','leads','customers'] loop
    if jsonb_array_length(p_changes->'deleted'->v_table)>0 and p_action <> 'clear_demo' then
      raise exception using errcode='PT403',message='Only Clear examples can delete records.';
    end if;
    if v_table='quotations' then
      for v_id in select q.id from crm.quotations q join jsonb_array_elements_text(p_changes->'deleted'->'quotations') d(id) on d.id=q.id order by q.revision desc,q.id loop
        delete from crm.quotations where id=v_id and is_demo;
        get diagnostics v_rows=row_count;
        if v_rows<>1 then raise exception using errcode='PT400',message='Real records cannot be deleted.'; end if;
      end loop;
    else
      for v_id in select value from jsonb_array_elements_text(p_changes->'deleted'->v_table) loop
        execute format('delete from crm.%I where id=$1 and is_demo',v_table) using v_id;
        get diagnostics v_rows=row_count;
        if v_rows<>1 then raise exception using errcode='PT400',message='Real or missing records cannot be deleted.'; end if;
      end loop;
    end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_changes->'members') loop
    select * into v_target from crm.members where user_id=(v_item->>'userId')::uuid for update;
    if not found then raise exception using errcode='PT404',message='Team member not found.'; end if;
    v_new_role := v_item->>'role';
    if jsonb_typeof(v_item->'active') is distinct from 'boolean' or v_new_role not in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT','VIEWER') or v_new_role is null then
      raise exception using errcode='PT400',message='Invalid membership change.';
    end if;
    v_new_active := (v_item->>'active')::boolean;
    if p_action='member_role' and (not v_target.active or v_new_active<>v_target.active) then
      raise exception using errcode='PT400',message='Role changes require an active employee and cannot change activation.';
    end if;
    if p_action='member_active' and v_new_role<>v_target.role then raise exception using errcode='PT400',message='Activation cannot change a role.'; end if;
    if v_target.user_id=p_actor_id and (not v_new_active or v_new_role<>'OWNER') then
      raise exception using errcode='PT400',message='You cannot disable yourself or remove your own owner role.';
    end if;
    if v_target.active and v_target.role='OWNER' and (not v_new_active or v_new_role<>'OWNER') and
      not exists(select 1 from crm.members where active and role='OWNER' and user_id<>v_target.user_id) then
      raise exception using errcode='PT400',message='The workspace must retain an active owner.';
    end if;
    update crm.members set role=v_new_role,active=v_new_active where user_id=v_target.user_id;
  end loop;
  if (p_changes->>'clearDemoAudit')::boolean then
    if p_action<>'clear_demo' then raise exception using errcode='PT403',message='This action cannot clear example history.'; end if;
    delete from crm.audit_events where is_demo;
  end if;
  for v_event in select value from jsonb_array_elements(p_changes->'audit') loop
    v_event_id := v_event->>'id';
    if v_event_id is null or length(v_event_id)>120 then raise exception using errcode='PT400',message='Invalid audit event.'; end if;
    v_is_demo := v_event_id like 'demo\_%' escape '\';
    if v_is_demo and p_action<>'load_demo' then raise exception using errcode='PT400',message='Example audit events require example loading.'; end if;
    if not v_is_demo then
      if (v_event->>'action') is distinct from p_action then raise exception using errcode='PT400',message='Audit action does not match this change.'; end if;
      v_event := jsonb_set(v_event,'{actor}',to_jsonb(v_actor.name));
    end if;
    insert into crm.audit_events(id,actor_id,is_demo,created_at,payload) values(v_event_id,case when v_is_demo then null else p_actor_id end,v_is_demo,(v_event->>'createdAt')::timestamptz,v_event);
  end loop;
  update crm.workspace set revision=revision+1,company=p_changes->'company',sequences=p_changes->'sequences' where id=1 returning * into v_workspace;
  insert into crm.mutation_receipts(request_id,actor_id,action,payload_hash,revision,message) values(p_request_id,p_actor_id,p_action,p_payload_hash,v_workspace.revision,p_message);
  return jsonb_build_object('data',public.crm_workspace_read(p_actor_id,false),'message',p_message);
end;
$$;

-- CREATE OR REPLACE retains existing ACLs; restate the trusted-server boundary.
revoke all on function crm.require_action(uuid,text) from public,anon,authenticated,service_role;
revoke all on function public.crm_add_member(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.crm_add_member(uuid,uuid,text,text,text) to service_role;
grant execute on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;

