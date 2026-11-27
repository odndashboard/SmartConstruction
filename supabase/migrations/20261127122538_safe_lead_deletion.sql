-- Delete only a standalone enquiry. Customer anchors, workflow records,
-- immutable history and creation receipts are always retained.
begin;
select 1 from crm.workspace where id=1 for update;

create index audit_events_entity_idx on crm.audit_events((payload->>'entityType'),(payload->>'entityId'));

create function crm.lead_delete_blocked_reason(p_lead crm.leads) returns text
language plpgsql stable set search_path='' as $$
begin
  if p_lead.is_demo then return 'Use Clear examples to remove example leads.'; end if;
  if p_lead.status='WON' then return 'Approved / Won leads cannot be deleted.'; end if;
  if exists(select 1 from crm.followups f where f.lead_id=p_lead.id) then
    return 'This lead has follow-up history and cannot be deleted.';
  end if;
  if exists(select 1 from crm.quotations q where q.lead_id=p_lead.id) then
    return 'This lead has a quotation and cannot be deleted.';
  end if;
  if exists(select 1 from crm.workorders w where w.lead_id=p_lead.id or w.payload#>>'{snapshot,leadId}'=p_lead.id or
    exists(select 1 from crm.quotations q where q.id=w.quote_id and q.lead_id=p_lead.id)) then
    return 'This lead has work-order history and cannot be deleted.';
  end if;
  return null;
end;
$$;

create function crm.dealer_lead_delete_blocked_reason(p_lead crm.leads,p_actor_id uuid) returns text
language plpgsql stable set search_path='' as $$
declare v_reason text;
begin
  if p_lead.dealer_id is distinct from p_actor_id then return 'Only your own new enquiries can be deleted.'; end if;
  v_reason:=crm.lead_delete_blocked_reason(p_lead);
  if v_reason is not null then return v_reason; end if;
  if p_lead.status<>'NEW' or length(btrim(coalesce(p_lead.payload->>'owner','')))>0 then
    return 'This enquiry has progressed or been assigned and cannot be deleted.';
  end if;
  if p_lead.payload->>'updatedAt' is distinct from p_lead.payload->>'createdAt' or
    not exists(select 1 from crm.audit_events a where a.payload->>'entityType'='lead' and a.payload->>'entityId'=p_lead.id
      and a.payload->>'action'='dealer_lead_create' and a.actor_id=p_actor_id) or
    exists(select 1 from crm.audit_events a where a.payload->>'entityType'='lead' and a.payload->>'entityId'=p_lead.id
      and (a.payload->>'action' is distinct from 'dealer_lead_create' or a.actor_id is distinct from p_actor_id)) or
    exists(select 1 from crm.audit_events a where a.payload->>'entityType'='customer' and a.payload->>'entityId'=p_lead.customer_id) then
    return 'This enquiry has already been reviewed or edited. Ask the Admin to review it.';
  end if;
  return null;
end;
$$;
revoke all on function crm.lead_delete_blocked_reason(crm.leads),crm.dealer_lead_delete_blocked_reason(crm.leads,uuid)
  from public,anon,authenticated,service_role;

-- Keep the general deletion guard intact for every other entity/action. The two
-- new actions are reachable only through the narrowly scoped RPCs below.
do $migration$
declare v_target regprocedure:='crm.protect_document()'::regprocedure; v_definition text; v_hash text;
  v_old text:=$old$  if tg_op = 'DELETE' then
    if v_action is distinct from 'clear_demo'$old$;
  v_new text:=$new$  if tg_op = 'DELETE' then
    if tg_table_name='leads' and v_action in ('lead_delete','dealer_lead_delete') and
      not coalesce((old.payload->>'isDemo')::boolean,false) then return old; end if;
    if v_action is distinct from 'clear_demo'$new$;
begin
  select md5(replace(prosrc,chr(13)||chr(10),chr(10))),replace(pg_get_functiondef(v_target),chr(13)||chr(10),chr(10))
    into v_hash,v_definition from pg_proc where oid=v_target;
  if v_hash<>'1cc06e8d0532ee040d77090c267866a0' then
    raise exception using errcode='55000',message='Lead deletion requires the verified document-protection contract.';
  end if;
  v_old:=replace(v_old,chr(13)||chr(10),chr(10)); v_new:=replace(v_new,chr(13)||chr(10),chr(10));
  if position(v_old in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old,''))<>length(v_old) then
    raise exception using errcode='55000',message='Expected deletion guard was not found exactly once.';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$migration$;

create function crm.delete_standalone_lead(p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_lead_id text,p_required_role text)
returns jsonb language plpgsql set search_path='' as $$
declare v_actor crm.members; v_revision bigint; v_receipt crm.mutation_receipts; v_lead crm.leads;
  v_action text; v_hash text; v_reason text; v_previous_action text; v_data jsonb;
begin
  perform crm.require_service();
  select revision into v_revision from crm.workspace where id=1 for update;
  if not found then raise exception using errcode='PT503',message='The CRM database is not initialized.'; end if;
  v_actor:=crm.verified_account(p_actor_id);
  if p_required_role not in ('OWNER','DEALER') or v_actor.role is distinct from p_required_role then
    raise exception using errcode='PT403',message='Your role does not permit deletion from this portal.';
  end if;
  if p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$' or p_lead_id is null or
    length(btrim(p_lead_id)) not between 1 and 120 or p_lead_id<>btrim(p_lead_id) or
    p_expected_revision is null or p_expected_revision not between 0 and 9007199254740991 then
    raise exception using errcode='PT400',message='A valid lead, request ID and workspace revision are required.';
  end if;
  v_action:=case when p_required_role='DEALER' then 'dealer_lead_delete' else 'lead_delete' end;
  v_hash:=encode(sha256(convert_to(jsonb_build_object('leadId',p_lead_id)::text,'UTF8')),'hex');
  select * into v_receipt from crm.mutation_receipts where request_id=p_request_id;
  if found then
    if v_receipt.actor_id<>p_actor_id or v_receipt.action<>v_action or v_receipt.payload_hash<>v_hash then
      raise exception using errcode='PT409',message='This request ID has already been used for another change.';
    end if;
  else
    if p_expected_revision<>v_revision then raise exception using errcode='PT409',message='The workspace changed. Refresh and review the lead before deleting it.'; end if;
    select * into v_lead from crm.leads where id=p_lead_id;
    if not found or (p_required_role='DEALER' and v_lead.dealer_id is distinct from p_actor_id) then
      raise exception using errcode='PT404',message='This lead is no longer available for deletion.';
    end if;
    v_reason:=case when p_required_role='DEALER' then crm.dealer_lead_delete_blocked_reason(v_lead,p_actor_id)
      else crm.lead_delete_blocked_reason(v_lead) end;
    if v_reason is not null then raise exception using errcode='PT409',message=v_reason; end if;
    v_previous_action:=current_setting('crm.action',true);
    perform set_config('crm.action',v_action,true);
    delete from crm.leads where id=p_lead_id;
    perform set_config('crm.action',coalesce(v_previous_action,''),true);
    perform crm.append_audit(v_actor,v_action,'lead',p_lead_id,'Deleted standalone enquiry '||coalesce(v_lead.payload->>'title',''));
    update crm.workspace set revision=revision+1 where id=1 returning revision into v_revision;
    insert into crm.mutation_receipts(request_id,actor_id,action,payload_hash,revision,message)
      values(p_request_id,p_actor_id,v_action,v_hash,v_revision,'Lead deleted.');
  end if;
  -- Never retain or replay a privileged snapshot in a receipt. Read the current
  -- role-scoped view after authorization, including on idempotent retries.
  if p_required_role='DEALER' then v_data:=public.crm_dealer_leads_read(p_actor_id);
  else v_data:=public.crm_workspace_read(p_actor_id,false); end if;
  return jsonb_build_object('data',v_data,'message','Lead deleted.');
end;
$$;
revoke all on function crm.delete_standalone_lead(uuid,bigint,text,text,text) from public,anon,authenticated,service_role;

create function public.crm_lead_delete(p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_lead_id text)
returns jsonb language sql security definer set search_path='' as $$
  select crm.delete_standalone_lead(p_actor_id,p_expected_revision,p_request_id,p_lead_id,'OWNER');
$$;
create function public.crm_dealer_lead_delete(p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_lead_id text)
returns jsonb language sql security definer set search_path='' as $$
  select crm.delete_standalone_lead(p_actor_id,p_expected_revision,p_request_id,p_lead_id,'DEALER');
$$;
revoke all on function public.crm_lead_delete(uuid,bigint,text,text),public.crm_dealer_lead_delete(uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.crm_lead_delete(uuid,bigint,text,text),public.crm_dealer_lead_delete(uuid,bigint,text,text) to service_role;
notify pgrst,'reload schema';
commit;
