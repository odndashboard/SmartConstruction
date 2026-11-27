-- A Won lead immediately has planned delivery work, even without a quotation.
-- Accepted quotations remain genuine immutable snapshots; unknown prices stay null.
begin;

-- Match the live mutation lock order before taking work-order DDL locks.
do $lock$
begin
  perform 1 from crm.workspace where id=1 for update;
  if (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc where oid='public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure)
      is distinct from '7ec21c9798de80294748ebb34c40da6b' or
     (select md5(replace(prosrc,chr(13)||chr(10),chr(10))) from pg_proc where oid='crm.protect_document()'::regprocedure)
      is distinct from 'c30071363df5e33a81d176ad3d69df45' then
    raise exception using errcode='55000',message='Work-order migration requires the verified manual-Won schema.';
  end if;
end;
$lock$;

-- Keep all existing rows, numbers and foreign keys. Legacy quote snapshots supply
-- their lead link without rewriting historical work-order JSON.
alter table crm.workorders alter column quote_id drop not null;
alter table crm.workorders drop constraint workorders_check;
alter table crm.workorders add constraint workorders_check check (
  jsonb_typeof(payload)='object' and payload->>'id'=id and
  jsonb_typeof(payload->'isDemo')='boolean' and payload ? 'snapshot' and
  jsonb_typeof(payload->'snapshot') in ('object','null') and jsonb_typeof(payload->'milestones')='array'
);
alter table crm.workorders add column lead_id text generated always as
  (coalesce(payload->>'leadId',payload#>>'{snapshot,leadId}')) stored not null references crm.leads(id) on delete restrict;
create index workorders_lead_idx on crm.workorders(lead_id);
create unique index workorders_automatic_lead_unique on crm.workorders(lead_id) where payload->>'automaticForLead'='true';
create unique index workorders_unpriced_lead_unique on crm.workorders(lead_id) where quote_id is null;
alter table crm.workorders add constraint workorders_automatic_flag_check check (
  not (payload ? 'automaticForLead') or jsonb_typeof(payload->'automaticForLead')='boolean'
);
alter table crm.workorders add constraint workorders_expected_kw_check check (
  case when not (payload ? 'expectedKw') or payload->'expectedKw'='null'::jsonb then true
    when jsonb_typeof(payload->'expectedKw')='number' then (payload->>'expectedKw')::numeric between 0 and 1.7976931348623157e308::numeric
    else false end
);

create or replace function crm.protect_document() returns trigger
language plpgsql set search_path = '' as $$
declare v_old text; v_new text; v_quote jsonb; v_lead jsonb; v_customer jsonb; v_lead_id text; v_action text := current_setting('crm.action',true);
begin
  if tg_op = 'DELETE' then
    if v_action is distinct from 'clear_demo' or not coalesce((old.payload->>'isDemo')::boolean,false) then
      raise exception using errcode='PT400',message='Only example records can be deleted through Clear examples.';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.id <> old.id or (new.payload->>'isDemo') is distinct from (old.payload->>'isDemo') or (new.payload->>'createdAt') is distinct from (old.payload->>'createdAt')) then
    raise exception using errcode='PT400',message='Record identity, creation time and example classification cannot be changed.';
  end if;
  if tg_table_name = 'quotations' then
    v_new := new.payload->>'status';
    if tg_op = 'INSERT' then
      if v_new <> 'DRAFT' and not (v_action = 'load_demo' and coalesce((new.payload->>'isDemo')::boolean,false)) then
        raise exception using errcode='PT400',message='New quotations must begin as drafts.';
      end if;
    else
      v_old := old.payload->>'status';
      if (v_old='DRAFT' and v_new='ISSUED' and v_action is distinct from 'quote_issue') or
         (v_old='ISSUED' and v_new='ACCEPTED' and v_action is distinct from 'quote_accept') or
         (v_old='ISSUED' and v_new='DECLINED' and v_action is distinct from 'quote_decline') or
         (v_new='SUPERSEDED' and v_old<>'SUPERSEDED' and v_action is distinct from 'quote_revise') then
        raise exception using errcode='PT403',message='This quotation transition requires its dedicated approval action.';
      end if;
      if v_old <> 'DRAFT' and (new.payload - array['status','acceptedAt','acceptanceNote','updatedAt']) is distinct from (old.payload - array['status','acceptedAt','acceptanceNote','updatedAt']) then
        raise exception using errcode='PT400',message='Issued quotation prices and details are immutable.';
      end if;
      if v_old <> 'DRAFT' and not (v_old = 'ISSUED' and v_new = 'ACCEPTED') and
        (new.payload - array['status','updatedAt']) is distinct from (old.payload - array['status','updatedAt']) then
        raise exception using errcode='PT400',message='Quotation acceptance details are immutable.';
      end if;
      if (v_old = 'DRAFT' and v_new not in ('DRAFT','ISSUED')) or
         (v_old = 'ISSUED' and v_new not in ('ISSUED','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED')) or
         (v_old in ('DECLINED','EXPIRED') and v_new not in (v_old,'SUPERSEDED')) or
         (v_old in ('ACCEPTED','SUPERSEDED') and v_new <> v_old) then
        raise exception using errcode='PT400',message='Invalid quotation status transition.';
      end if;
    end if;
  elsif tg_table_name = 'workorders' then
    v_lead_id := coalesce(new.payload->>'leadId',new.payload#>>'{snapshot,leadId}');
    select payload into v_lead from crm.leads where id=v_lead_id;
    if v_lead is null or new.payload->'isDemo' is distinct from v_lead->'isDemo' then
      raise exception using errcode='PT400',message='Work orders must link their real or example lead consistently.';
    end if;
    if new.payload->>'quoteId' is not null then
      select payload into v_quote from crm.quotations where id=new.payload->>'quoteId';
      if v_quote is null or v_quote->>'status'<>'ACCEPTED' or v_quote->>'leadId' is distinct from v_lead_id or
        new.payload->'snapshot' is distinct from v_quote then
        raise exception using errcode='PT400',message='Work orders must preserve their lead''s accepted quotation snapshot.';
      end if;
    elsif new.payload->'snapshot' is distinct from 'null'::jsonb then
      raise exception using errcode='PT400',message='A work order without an accepted quotation cannot contain a quotation snapshot.';
    end if;
    if tg_op = 'INSERT' then
      if v_action not in ('lead_save','lead_status','quote_accept','quote_convert','lead_won_backfill','quote_accept_backfill','load_demo') or v_action is null then
        raise exception using errcode='PT403',message='Work orders require a Won lead or an accepted quotation conversion.';
      end if;
      if v_action<>'load_demo' and (new.payload->>'status' is distinct from 'PLANNED' or
        coalesce(new.payload->>'startDate','')<>'' or coalesce(new.payload->>'endDate','')<>'' or
        new.payload->'milestones' is distinct from '[]'::jsonb) then
        raise exception using errcode='PT400',message='New work orders must begin as unscheduled planned work.';
      end if;
      if v_action in ('lead_save','lead_status','lead_won_backfill') then
        if v_lead->>'status' is distinct from 'WON' or new.payload->'automaticForLead' is distinct from 'true'::jsonb then
          raise exception using errcode='PT400',message='Automatic work orders require a Won lead.';
        end if;
        if exists(select 1 from crm.workorders where lead_id=v_lead_id) then
          raise exception using errcode='PT409',message='This lead already has a work order. Reuse the existing order.';
        end if;
      elsif v_action in ('quote_accept','quote_accept_backfill') then
        if v_quote is null or v_lead->>'status' is distinct from 'WON' or
          new.payload->'automaticForLead' is distinct from to_jsonb(not exists(select 1 from crm.workorders where lead_id=v_lead_id)) then
          raise exception using errcode='PT400',message='Accepted quotation work must preserve its scope and existing lead work.';
        end if;
      elsif v_action='quote_convert' and (v_quote is null or coalesce((new.payload->>'automaticForLead')::boolean,false)) then
        raise exception using errcode='PT400',message='Explicit conversion requires its own accepted quotation scope.';
      end if;
      if v_quote is null then
        select payload into v_customer from crm.customers where id=v_lead->>'customerId';
        if v_lead->>'status' is distinct from 'WON' or
          new.payload->>'title' is distinct from v_lead->>'title' or
          new.payload->>'customerName' is distinct from v_customer->>'name' or
          new.payload->>'siteAddress' is distinct from coalesce(v_lead->>'siteAddress','') or
          new.payload->>'owner' is distinct from coalesce(v_lead->>'owner','') or
          coalesce(new.payload->'expectedKw','null'::jsonb) is distinct from coalesce(v_lead->'expectedKw','null'::jsonb) then
          raise exception using errcode='PT400',message='Planned work must use the Won lead''s actual details.';
        end if;
      elsif v_action<>'load_demo' and (
        new.payload->>'title' is distinct from v_quote->>'title' or
        new.payload->>'customerName' is distinct from coalesce(v_quote#>>'{customer,name}','') or
        new.payload->>'siteAddress' is distinct from coalesce(v_quote->>'siteAddress','')
      ) then
        raise exception using errcode='PT400',message='Quoted work must preserve the accepted scope details.';
      end if;
    else
      if old.payload->>'quoteId' is null and new.payload->>'quoteId' is not null then
        if v_action not in ('quote_accept','quote_convert','lead_save','lead_status','quote_accept_backfill') or v_action is null or
          (new.payload - array['quoteId','snapshot','title','customerName','siteAddress','updatedAt']) is distinct from
          (old.payload - array['quoteId','snapshot','title','customerName','siteAddress','updatedAt']) or
          new.payload->>'title' is distinct from v_quote->>'title' or
          new.payload->>'customerName' is distinct from coalesce(v_quote#>>'{customer,name}','') or
          new.payload->>'siteAddress' is distinct from coalesce(v_quote->>'siteAddress','') then
          raise exception using errcode='PT400',message='Linking an accepted quotation must preserve the existing work order and delivery progress.';
        end if;
        return new;
      end if;
      if (new.payload - array['status','owner','startDate','endDate','milestones','updatedAt']) is distinct from (old.payload - array['status','owner','startDate','endDate','milestones','updatedAt']) then
        raise exception using errcode='PT400',message='The accepted work-order scope is immutable.';
      end if;
      v_old := old.payload->>'status'; v_new := new.payload->>'status';
      if v_action='workorder_save' and (new.payload->'milestones') is distinct from (old.payload->'milestones') then
        raise exception using errcode='PT400',message='Use milestone actions to change delivery milestones.';
      end if;
      if v_action in ('milestone_add','milestone_complete') and (new.payload - array['milestones','updatedAt']) is distinct from (old.payload - array['milestones','updatedAt']) then
        raise exception using errcode='PT400',message='Milestone actions cannot change other work-order details.';
      end if;
      if (v_old in ('COMPLETED','CANCELLED') and new.payload is distinct from old.payload) or
         (v_old = 'PLANNED' and v_new not in ('PLANNED','ACTIVE','CANCELLED')) or
         (v_old = 'ACTIVE' and v_new not in ('ACTIVE','ON_HOLD','COMPLETED','CANCELLED')) or
         (v_old = 'ON_HOLD' and v_new not in ('ON_HOLD','ACTIVE','CANCELLED')) then
        raise exception using errcode='PT400',message='Invalid work-order status transition.';
      end if;
      if v_new = 'COMPLETED' and exists(select 1 from jsonb_array_elements(new.payload->'milestones') m where m->>'status' <> 'DONE') then
        raise exception using errcode='PT400',message='Complete all milestones before closing the work order.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Private helper, called only while the workspace write lock is held. All normal
-- callers already have current role authorization from crm_workspace_commit.
create function crm.ensure_won_workorder(p_lead_id text,p_actor crm.members,p_action text,p_quote_id text default null,p_now timestamptz default clock_timestamp()) returns void
language plpgsql set search_path='' as $$
declare v_lead jsonb; v_customer jsonb; v_quote jsonb; v_existing crm.workorders; v_record jsonb;
  v_key text; v_year integer; v_count bigint; v_number text; v_id text; v_stamp text:=p_now::text;
  v_event_id text:=gen_random_uuid()::text; v_has_order boolean;
begin
  if p_action not in ('lead_save','lead_status','quote_accept','lead_won_backfill','quote_accept_backfill') or p_action is null or
    (p_action not in ('lead_won_backfill','quote_accept_backfill') and coalesce((p_actor).role,'') not in ('OWNER','MANAGER')) then
    raise exception using errcode='PT403',message='This action cannot complete Won-lead work orders.';
  end if;
  perform 1 from crm.workspace where id=1 for update;
  perform set_config('crm.action',p_action,true);
  select payload into v_lead from crm.leads where id=p_lead_id and status='WON';
  if v_lead is null then raise exception using errcode='PT400',message='Automatic work requires a Won lead.'; end if;
  if p_quote_id is not null then
    select payload into v_quote from crm.quotations where id=p_quote_id and lead_id=p_lead_id and status='ACCEPTED';
    if v_quote is null then raise exception using errcode='PT400',message='Only an accepted quotation for this lead may be linked.'; end if;
  else
    select payload into v_quote from crm.quotations where lead_id=p_lead_id and status='ACCEPTED'
      order by payload->>'acceptedAt',id limit 1;
  end if;
  select exists(select 1 from crm.workorders where lead_id=p_lead_id) into v_has_order;
  select * into v_existing from crm.workorders where lead_id=p_lead_id and
    (p_action not in ('quote_accept','quote_accept_backfill') or quote_id=v_quote->>'id' or quote_id is null)
    order by case when quote_id=v_quote->>'id' then 0 when quote_id is null then 1 else 2 end,payload->>'createdAt',id limit 1;
  if found then
    if v_existing.quote_id is null and v_quote is not null then
      update crm.workorders set payload=payload||jsonb_build_object('quoteId',v_quote->>'id','snapshot',v_quote,
        'title',v_quote->>'title','customerName',coalesce(v_quote#>>'{customer,name}',''),
        'siteAddress',coalesce(v_quote->>'siteAddress',''),'updatedAt',v_stamp) where id=v_existing.id;
    end if;
    return;
  end if;
  select payload into v_customer from crm.customers where id=v_lead->>'customerId';
  v_year:=extract(year from p_now at time zone 'Asia/Kolkata')::integer;
  if extract(month from p_now at time zone 'Asia/Kolkata')<4 then v_year:=v_year-1; end if;
  v_key:='WO/'||v_year::text||'-'||right((v_year+1)::text,2);
  select greatest(coalesce((sequences->>v_key)::bigint,0),coalesce((
    select max(split_part(number,'/',4)::bigint) from crm.workorders
    where number ~ ('^SC/'||v_key||'/[0-9]+$')
  ),0))+1 into v_count from crm.workspace where id=1;
  if v_count>999999999 then raise exception using errcode='PT400',message='Work-order numbering limit reached.'; end if;
  v_number:='SC/'||v_key||'/'||lpad(v_count::text,greatest(6,length(v_count::text)),'0');
  v_id:=gen_random_uuid()::text;
  v_record:=jsonb_build_object('id',v_id,'leadId',p_lead_id,'quoteId',v_quote->>'id','number',v_number,
    'title',coalesce(v_quote->>'title',v_lead->>'title'),
    'customerName',coalesce(v_quote#>>'{customer,name}',v_customer->>'name'),
    'siteAddress',coalesce(v_quote->>'siteAddress',v_lead->>'siteAddress',''),
    'owner',coalesce(v_lead->>'owner',''),'expectedKw',coalesce(v_lead->'expectedKw','null'::jsonb),
    'startDate','','endDate','','status','PLANNED','snapshot',coalesce(v_quote,'null'::jsonb),
    'milestones','[]'::jsonb,'isDemo',v_lead->'isDemo','automaticForLead',not v_has_order,'createdAt',v_stamp,'updatedAt',v_stamp);
  insert into crm.workorders(id,payload) values(v_id,v_record);
  update crm.workspace set sequences=jsonb_set(sequences,array[v_key],to_jsonb(v_count),true) where id=1;
  if p_action in ('lead_won_backfill','quote_accept_backfill') then
    insert into crm.audit_events(id,actor_id,created_at,payload) values(v_event_id,null,p_now,
      jsonb_build_object('id',v_event_id,'actor','System','action','workorder_auto_create','entityType','workorder',
        'entityId',v_id,'description','Created planned work for existing Won lead','createdAt',v_stamp));
  else
    perform crm.append_audit(p_actor,p_action,'workorder',v_id,'Created work order '||v_number||' for Won lead');
  end if;
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
  v_event_id text; v_event jsonb; v_is_demo boolean; v_rows integer; v_new_lead jsonb;
  v_created_orders integer; v_wo_number text; v_lead_id text; v_quote_id text;
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
        not ((p_action='quote_issue' and v_key like 'Q/%') or (p_action in ('lead_save','lead_status','quote_accept','quote_convert') and v_key like 'WO/%')) then
        raise exception using errcode='PT400',message='A document counter can advance only once in its matching action.';
      end if;
      v_counter_changes := v_counter_changes+1;
      if v_key like 'WO/%' then v_wo_number := 'SC/'||v_key||'/'||lpad(v_new_count::text,greatest(6,length(v_new_count::text)),'0'); end if;
    end if;
  end loop;
  if v_counter_changes>1 then raise exception using errcode='PT400',message='Only one document number can be allocated per action.'; end if;
  if jsonb_typeof(p_changes->'upserts'->'workorders') is distinct from 'array' then
    raise exception using errcode='PT400',message='Invalid work order mutation list.';
  end if;
  select count(*) into v_created_orders from jsonb_array_elements(p_changes->'upserts'->'workorders') item
    where not exists(select 1 from crm.workorders w where w.id=item->>'id');
  if p_action<>'load_demo' and (v_created_orders>1 or
    (v_created_orders=1 and (v_wo_number is null or not exists(
      select 1 from jsonb_array_elements(p_changes->'upserts'->'workorders') item
      where item->>'number'=v_wo_number and not exists(select 1 from crm.workorders w where w.id=item->>'id')
    ))) or (v_created_orders=0 and v_wo_number is not null)) then
    raise exception using errcode='PT400',message='A new work order must use exactly one authorized work-order number.';
  end if;
  if jsonb_array_length(p_changes->'members')>0 and p_action not in ('member_role','member_active') then
    raise exception using errcode='PT403',message='This action cannot change team memberships.';
  end if;
  if jsonb_array_length(p_changes->'members')>1 then raise exception using errcode='PT400',message='Change one team member at a time.'; end if;
  v_allowed := case
    when p_action='customer_save' then array['customers']
    when p_action='lead_save' then array['customers','leads','workorders']
    when p_action='lead_status' then array['leads','workorders']
    when p_action in ('followup_save','followup_complete','followup_cancel') then array['followups']
    when p_action in ('quote_save','quote_decline','quote_revise','company_save') then array['quotations']
    when p_action='quote_issue' then array['leads','quotations']
    when p_action='quote_accept' then array['leads','quotations','workorders']
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
      if v_table='workorders' and p_action in ('lead_save','lead_status','quote_accept','quote_convert') then
        if v_actor.role not in ('OWNER','MANAGER') then
          raise exception using errcode='PT403',message='Only Admin and Manager can create or link Won-lead work orders.';
        end if;
        if v_existing is not null and v_item is distinct from v_existing and not (
          v_existing->>'quoteId' is null and v_item->>'quoteId' is not null
        ) then
          raise exception using errcode='PT403',message='Use delivery actions to change existing work-order progress.';
        end if;
        v_lead_id:=coalesce(v_item->>'leadId',v_item#>>'{snapshot,leadId}');
        if p_action in ('lead_save','lead_status') and not exists(
          select 1 from jsonb_array_elements(p_changes->'upserts'->'leads') l where l->>'id'=v_lead_id and l->>'status'='WON'
        ) then
          raise exception using errcode='PT400',message='Automatic work must belong to the Won lead in this action.';
        end if;
        if p_action='quote_accept' and not exists(
          select 1 from jsonb_array_elements(p_changes->'upserts'->'quotations') q
          where q->>'id'=v_item->>'quoteId' and q->>'leadId'=v_lead_id and q->>'status'='ACCEPTED'
        ) then
          raise exception using errcode='PT400',message='Automatic quoted work must belong to the acceptance in this action.';
        end if;
      end if;
      -- Lead entry may create its own internal customer, but cannot edit any
      -- existing customer or smuggle unrelated customer records into the diff.
      if v_table='customers' and p_action='lead_save' then
        if v_existing is not null then
          raise exception using errcode='PT403',message='Lead entry cannot overwrite an existing customer.';
        end if;
        if jsonb_typeof(p_changes->'upserts'->'leads') is distinct from 'array' or
          jsonb_array_length(p_changes->'upserts'->'customers')<>1 or
          jsonb_array_length(p_changes->'upserts'->'leads')<>1 then
          raise exception using errcode='PT400',message='An automatic customer must belong to one new lead.';
        end if;
        v_new_lead := p_changes->'upserts'->'leads'->0;
        if jsonb_typeof(v_new_lead) is distinct from 'object' or
          exists(select 1 from crm.leads where id=v_new_lead->>'id') or
          (v_new_lead->>'customerId') is distinct from v_id or
          (v_item->>'name') is distinct from coalesce(nullif(btrim(v_new_lead->>'contact'),''),btrim(v_new_lead->>'title')) or
          length(btrim(coalesce(v_item->>'name','')))=0 or
          (v_item->>'contact') is distinct from coalesce(v_new_lead->>'contact','') or
          (v_item->>'phone') is distinct from coalesce(v_new_lead->>'phone','') or
          (v_item->>'email') is distinct from coalesce(v_new_lead->>'email','') or
          (v_item->>'stateCode') is distinct from coalesce(v_new_lead->>'stateCode','') or
          (v_item->>'address') is distinct from '' or (v_item->>'gstin') is distinct from '' or
          (v_item->'isDemo') is distinct from 'false'::jsonb or
          (v_new_lead->'isDemo') is distinct from 'false'::jsonb or
          (v_item->>'createdAt') is distinct from (v_new_lead->>'createdAt') then
          raise exception using errcode='PT400',message='The automatic customer must use this new lead''s contact details.';
        end if;
      end if;
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
        if (v_item->>'status')='WON' and coalesce(v_existing->>'status','NEW')<>'WON' and not (
          p_action='quote_accept' or (p_action in ('lead_save','lead_status') and v_actor.role in ('OWNER','MANAGER'))
        ) then
          raise exception using errcode='PT400',message='Only Admin and Manager can mark a lead Won.';
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
        if p_action not in ('customer_save','lead_save','lead_status','followup_save','quote_save','quote_revise','quote_accept','quote_convert','load_demo') then
          raise exception using errcode='PT400',message='This action cannot create a new record.';
        end if;
        execute format('insert into crm.%I(id,payload) values($1,$2)',v_table) using v_id,v_item;
      end if;
    end loop;
  end loop;
  -- Install validated application counters before completing any missing order.
  -- This also supports older application servers during the deployment window.
  update crm.workspace set sequences=p_changes->'sequences' where id=1;
  if p_action in ('lead_save','lead_status','quote_accept') and v_actor.role in ('OWNER','MANAGER') then
    for v_lead_id in
      select item->>'id' from jsonb_array_elements(p_changes->'upserts'->'leads') item where item->>'status'='WON'
      union
      select item->>'leadId' from jsonb_array_elements(p_changes->'upserts'->'quotations') item where p_action='quote_accept' and item->>'status'='ACCEPTED'
    loop
      select item->>'id' into v_quote_id from jsonb_array_elements(p_changes->'upserts'->'quotations') item
        where p_action='quote_accept' and item->>'status'='ACCEPTED' and item->>'leadId'=v_lead_id limit 1;
      perform crm.ensure_won_workorder(v_lead_id,v_actor,p_action,v_quote_id,clock_timestamp());
    end loop;
  end if;
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
  update crm.workspace set revision=revision+1,company=p_changes->'company' where id=1 returning * into v_workspace;
  insert into crm.mutation_receipts(request_id,actor_id,action,payload_hash,revision,message) values(p_request_id,p_actor_id,p_action,p_payload_hash,v_workspace.revision,p_message);
  return jsonb_build_object('data',public.crm_workspace_read(p_actor_id,false),'message',p_message);
end;
$$;

-- The payment ledger must remain usable when a lead has planned work but no
-- agreed quotation amount. Such orders are intentionally absent from accounts;
-- contract_amount still rejects payment/installment writes until agreement.
do $payments$
declare v_definition text; v_old text:='from crm.workorders w where not w.is_demo;';
begin
  if to_regprocedure('crm.extension_snapshot(crm.members,text,boolean)') is not null then
    v_definition:=pg_get_functiondef('crm.extension_snapshot(crm.members,text,boolean)'::regprocedure);
    if position(v_old in v_definition)=0 then raise exception 'Expected payment-account query was not found.'; end if;
    execute replace(v_definition,v_old,'from crm.workorders w where not w.is_demo and w.quote_id is not null;');
  end if;
end;
$payments$;

-- Complete existing real Won leads once. No quotation is created or accepted,
-- and an already-linked work order is never replaced, reset or renumbered.
do $backfill$
declare v_lead_id text; v_quote record; v_before bigint; v_after bigint; v_changed integer:=0; v_event_id text; v_now timestamptz:=clock_timestamp();
begin
  perform 1 from crm.workspace where id=1 for update;
  select count(*) into v_before from crm.workorders;
  -- A historical acceptance is already binding. Reconcile its existing lead;
  -- never create another lead or alter the accepted quotation itself.
  perform set_config('crm.action','quote_accept',true);
  for v_lead_id in select distinct l.id from crm.leads l join crm.quotations q on q.lead_id=l.id
    where q.status='ACCEPTED' and not q.is_demo and l.status<>'WON' order by l.id
  loop
    update crm.leads set payload=payload||jsonb_build_object('status','WON','lostReason','','updatedAt',v_now::text) where id=v_lead_id;
    v_changed:=v_changed+1; v_event_id:=gen_random_uuid()::text;
    insert into crm.audit_events(id,actor_id,created_at,payload) values(v_event_id,null,v_now,
      jsonb_build_object('id',v_event_id,'actor','System','action','lead_status','entityType','lead','entityId',v_lead_id,
        'description','Aligned Won status with existing accepted quotation','createdAt',v_now::text));
  end loop;
  for v_lead_id in select l.id from crm.leads l where l.status='WON' and not l.is_demo
    and not exists(select 1 from crm.workorders w where w.lead_id=l.id) order by l.id
  loop
    perform crm.ensure_won_workorder(v_lead_id,null::crm.members,'lead_won_backfill',null,clock_timestamp());
  end loop;
  for v_quote in select q.id,q.lead_id from crm.quotations q where q.status='ACCEPTED' and not q.is_demo
    and not exists(select 1 from crm.workorders w where w.quote_id=q.id) order by q.payload->>'acceptedAt',q.id
  loop
    perform crm.ensure_won_workorder(v_quote.lead_id,null::crm.members,'quote_accept_backfill',v_quote.id,clock_timestamp());
  end loop;
  select count(*) into v_after from crm.workorders;
  if v_after<>v_before or v_changed>0 then update crm.workspace set revision=revision+1 where id=1; end if;
end;
$backfill$;

revoke all on function crm.ensure_won_workorder(text,crm.members,text,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function crm.protect_document() from public,anon,authenticated,service_role;
revoke all on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
