-- Assigned site alerts are communication records. Neither reporting nor resolving
-- them receives, consumes, reserves, transfers or adjusts stock.
begin;

do $verify$
declare v_target text; v_expected text; v_hash text;
begin
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected in select * from (values
    ('crm.extension_snapshot(crm.members,text,boolean)','9a744f46df42ed9ceaf85c5ec0e7a58a'),
    ('crm.team_activity_module(text,text)','23ec4c62c103f35ad7d596ddada069ae'),
    ('crm.operations_activity_description(crm.operations_audit)','1fb464a62657387e667af3cf8a9898a6')
  ) expected(signature,body_hash) loop
    select md5(replace(prosrc,chr(13)||chr(10),chr(10))) into v_hash from pg_proc where oid=v_target::regprocedure;
    if v_hash is distinct from v_expected then raise exception using errcode='55000',message='Site alerts require the verified job-material schema.'; end if;
  end loop;
end;
$verify$;

create table crm.material_alerts (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references crm.workorders(id) on delete restrict,
  item_id uuid references crm.stock_items(id) on delete restrict,
  item_name text not null check(length(btrim(item_name)) between 1 and 200),
  quantity_milli bigint check(quantity_milli between 1 and 9000000000000),
  unit text not null default '' check(length(unit)<=24),
  note text not null default '' check(length(note)<=2000),
  assignee_id uuid not null references crm.members(user_id) on delete restrict,
  assignee_name text not null check(length(assignee_name) between 1 and 200),
  reported_by uuid not null references crm.members(user_id) on delete restrict,
  reported_by_name text not null check(length(reported_by_name) between 1 and 200),
  status text not null default 'OPEN' check(status in ('OPEN','RESOLVED')),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid references crm.members(user_id) on delete restrict,
  resolved_by_name text check(resolved_by_name is null or length(resolved_by_name) between 1 and 200),
  check(quantity_milli is null or length(btrim(unit))>0),
  check((status='OPEN' and resolved_at is null and resolved_by is null and resolved_by_name is null) or
    (status='RESOLVED' and resolved_at is not null and resolved_at>=created_at and resolved_by is not null and resolved_by_name is not null))
);
create index material_alerts_status_idx on crm.material_alerts(status,created_at desc,id desc);
create index material_alerts_work_idx on crm.material_alerts(work_order_id,status,created_at desc,id desc);
create index material_alerts_item_idx on crm.material_alerts(item_id);
create index material_alerts_assignee_idx on crm.material_alerts(assignee_id);
create index material_alerts_reporter_idx on crm.material_alerts(reported_by);
create index material_alerts_resolver_idx on crm.material_alerts(resolved_by);
alter table crm.material_alerts enable row level security;
revoke all on crm.material_alerts from public,anon,authenticated,service_role;

create function crm.material_alert_member(p_actor_id uuid,p_write boolean default false) returns crm.members
language plpgsql set search_path='' as $$
declare v_member crm.members;
begin
  v_member:=crm.extension_lock(p_actor_id,p_write);
  if v_member.role not in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT') then
    raise exception using errcode='PT403',message='Your account cannot access site alerts.';
  end if;
  return v_member;
end;
$$;

create function crm.material_alert_guard() returns trigger language plpgsql set search_path='' as $$
declare v_member crm.members;
begin
  if tg_op='DELETE' then raise exception using errcode='PT403',message='Site alert history cannot be deleted.'; end if;
  if tg_op='INSERT' then
    v_member:=crm.active_member(new.reported_by);
    if v_member.role not in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT') or new.reported_by_name is distinct from v_member.name then
      raise exception using errcode='PT403',message='Your account cannot report site alerts.';
    end if;
    if new.status<>'OPEN' or not exists(select 1 from crm.workorders where id=new.work_order_id and not is_demo and status='ACTIVE') then
      raise exception using errcode='PT409',message='Report missing stock only for a real active work order.';
    end if;
    if not exists(select 1 from crm.members m join auth.users u on u.id=m.user_id
      where m.user_id=new.assignee_id and m.active and m.name=new.assignee_name and m.role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT')
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())) then
      raise exception using errcode='PT400',message='Choose an active team member to handle this alert.';
    end if;
    if new.item_id is not null and not exists(select 1 from crm.stock_items where id=new.item_id and active and name=new.item_name and unit=new.unit) then
      raise exception using errcode='PT400',message='Choose an active stock item with its actual name and unit.';
    end if;
  else
    if (to_jsonb(new)-array['status','resolved_at','resolved_by','resolved_by_name']) is distinct from
      (to_jsonb(old)-array['status','resolved_at','resolved_by','resolved_by_name']) or old.status<>'OPEN' or new.status<>'RESOLVED' then
      raise exception using errcode='PT403',message='The original alert and its resolution history are immutable.';
    end if;
    v_member:=crm.active_member(new.resolved_by);
    if v_member.role not in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT') or
      (v_member.user_id<>old.assignee_id and v_member.role not in ('OWNER','MANAGER')) or new.resolved_by_name is distinct from v_member.name then
      raise exception using errcode='PT403',message='Only the assigned person, Owner or Manager can resolve this alert.';
    end if;
  end if;
  return new;
end;
$$;
create trigger material_alerts_guard before insert or update or delete on crm.material_alerts for each row execute function crm.material_alert_guard();

create function crm.material_alert_json(p_row crm.material_alerts) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'workOrderId',p_row.work_order_id,'workOrderNumber',w.number,
    'workOrderTitle',w.payload->>'title','siteAddress',w.payload->>'siteAddress','itemId',p_row.item_id,'itemName',p_row.item_name,
    'quantityMilli',p_row.quantity_milli,'unit',p_row.unit,'note',p_row.note,'assigneeId',p_row.assignee_id,'assigneeName',p_row.assignee_name,
    'reportedBy',p_row.reported_by,'reportedByName',p_row.reported_by_name,'status',p_row.status,'createdAt',p_row.created_at,
    'resolvedAt',p_row.resolved_at,'resolvedBy',p_row.resolved_by,'resolvedByName',p_row.resolved_by_name)
  from crm.workorders w where w.id=p_row.work_order_id;
$$;
revoke all on function crm.material_alert_member(uuid,boolean),crm.material_alert_guard(),crm.material_alert_json(crm.material_alerts) from public,anon,authenticated,service_role;

create function public.crm_material_alerts_read(p_actor_id uuid,p_work_order_id text default null,p_status text default 'OPEN',p_page integer default 1,p_search text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_revision bigint; v_rows jsonb; v_total bigint; v_open bigint; v_resolved bigint; v_search text;
begin
  v_actor:=crm.material_alert_member(p_actor_id);
  if p_status is null or p_status not in ('OPEN','RESOLVED','ALL') or p_page is null or p_page not between 1 and 10000 or p_search is null or length(p_search)>200 then
    raise exception using errcode='PT400',message='Choose a valid alert filter, search and page.';
  end if;
  if p_work_order_id is not null and not exists(select 1 from crm.workorders where id=p_work_order_id and not is_demo) then
    raise exception using errcode='PT404',message='Choose a real work order.';
  end if;
  v_search:=lower(btrim(p_search));
  select revision into v_revision from crm.operations_state where id=1;
  with matched as materialized (
    select a.* from crm.material_alerts a join crm.workorders w on w.id=a.work_order_id
    where (p_work_order_id is null or a.work_order_id=p_work_order_id) and
      (v_search='' or strpos(lower(concat_ws(' ',w.number,w.payload->>'title',w.payload->>'siteAddress',a.item_name,a.note,a.assignee_name,a.reported_by_name)),v_search)>0)
  )
  select count(*) filter(where p_status='ALL' or status=p_status),count(*) filter(where status='OPEN'),count(*) filter(where status='RESOLVED'),
    (select coalesce(jsonb_agg(crm.material_alert_json(x) order by x.created_at desc,x.id desc),'[]'::jsonb)
      from (select m.* from matched m where p_status='ALL' or m.status=p_status order by m.created_at desc,m.id desc limit 50 offset (p_page-1)*50) x)
    into v_total,v_open,v_resolved,v_rows from matched;
  return jsonb_build_object('revision',v_revision,'serverTime',clock_timestamp(),'user',jsonb_build_object('userId',v_actor.user_id,'name',v_actor.name,'role',v_actor.role),
    'alerts',v_rows,'total',v_total,'page',p_page,'pageSize',50,'openCount',v_open,'resolvedCount',v_resolved,
    'assignees',(select coalesce(jsonb_agg(jsonb_build_object('userId',m.user_id,'name',m.name,'role',m.role) order by m.name,m.user_id),'[]'::jsonb)
      from crm.members m join auth.users u on u.id=m.user_id where m.active and m.role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT')
      and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now())),
    'stockItems',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'unit',i.unit) order by i.name,i.id),'[]'::jsonb) from crm.stock_items i where i.active),
    'workOrders',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'number',w.number,'title',w.payload->>'title','siteAddress',w.payload->>'siteAddress') order by w.number,w.id),'[]'::jsonb)
      from crm.workorders w where w.status='ACTIVE' and not w.is_demo));
end;
$$;

create function public.crm_material_alerts_mutate(p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_action text,p_payload_hash text,p_payload jsonb,
  p_work_order_id text default null,p_status text default 'OPEN',p_page integer default 1,p_search text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_assignee crm.members; v_receipt crm.operations_receipts; v_alert crm.material_alerts;
  v_work crm.workorders; v_item crm.stock_items; v_revision bigint; v_now timestamptz; v_id uuid; v_assignee_id uuid; v_item_id uuid;
  v_work_id text; v_name text; v_unit text; v_note text; v_quantity bigint; v_before jsonb; v_message text;
begin
  v_actor:=crm.material_alert_member(p_actor_id,true);
  if p_action is null or p_action not in ('material_alert_create','material_alert_resolve') then raise exception using errcode='PT400',message='Unknown site alert action.'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or p_expected_revision is null or p_expected_revision not between 0 and 9007199254740991 or
    p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$' or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$' then
    raise exception using errcode='PT400',message='The alert request is not valid.';
  end if;
  if p_action='material_alert_create' then
    perform crm.operations_keys(p_payload,array['workOrderId','assigneeId','itemId','itemName','quantity','unit','note'],array['workOrderId','assigneeId']);
  else
    perform crm.operations_keys(p_payload,array['id'],array['id']); v_id:=crm.operations_uuid(p_payload,'id');
    select * into v_alert from crm.material_alerts where id=v_id;
    if not found then raise exception using errcode='PT404',message='Site alert not found.'; end if;
    -- Recheck authorization before receipt replay too; old privileges do not persist.
    if v_actor.user_id<>v_alert.assignee_id and v_actor.role not in ('OWNER','MANAGER') then
      raise exception using errcode='PT403',message='Only the assigned person, Owner or Manager can resolve this alert.';
    end if;
  end if;
  select * into v_receipt from crm.operations_receipts where request_id=p_request_id;
  if found then
    if v_receipt.actor_id<>p_actor_id or v_receipt.action<>p_action or v_receipt.payload_hash<>p_payload_hash or v_receipt.payload is distinct from p_payload then
      raise exception using errcode='PT409',message='This request ID belongs to a different action.';
    end if;
    return jsonb_build_object('data',public.crm_material_alerts_read(p_actor_id,p_work_order_id,p_status,p_page,p_search),'message',v_receipt.message);
  end if;
  select revision into v_revision from crm.operations_state where id=1;
  if v_revision<>p_expected_revision then raise exception using errcode='PT409',message='The workspace changed. Refresh and try again.'; end if;
  if v_revision=9007199254740991 then raise exception using errcode='PT409',message='The operations revision limit has been reached.'; end if;
  v_now:=clock_timestamp();
  if p_action='material_alert_create' then
    v_work_id:=crm.operations_text(p_payload,'workOrderId',120,true);
    select * into v_work from crm.workorders where id=v_work_id and not is_demo;
    if not found then raise exception using errcode='PT404',message='Choose a real work order.'; end if;
    if v_work.status<>'ACTIVE' then raise exception using errcode='PT409',message='Report missing stock only for an active work order.'; end if;
    v_assignee_id:=crm.operations_uuid(p_payload,'assigneeId');
    select m.* into v_assignee from crm.members m join auth.users u on u.id=m.user_id where m.user_id=v_assignee_id and m.active
      and m.role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT') and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now());
    if not found then raise exception using errcode='PT400',message='Choose an active team member to handle this alert.'; end if;
    v_item_id:=crm.extension_optional_uuid(p_payload,'itemId'); v_name:=crm.operations_text(p_payload,'itemName',200);
    v_unit:=crm.operations_text(p_payload,'unit',24); v_note:=crm.operations_text(p_payload,'note',2000);
    if v_item_id is not null then
      if v_name<>'' then raise exception using errcode='PT400',message='Choose a catalogue item or enter a missing item name, not both.'; end if;
      select * into v_item from crm.stock_items where id=v_item_id and active;
      if not found then raise exception using errcode='PT400',message='Choose an active stock item or report an uncatalogued item.'; end if;
      if v_unit<>'' and v_unit<>v_item.unit then raise exception using errcode='PT400',message='Use the selected stock item''s unit.'; end if;
      v_name:=v_item.name; v_unit:=v_item.unit;
    elsif v_name='' then raise exception using errcode='PT400',message='Enter the missing item name.'; end if;
    if p_payload?'quantity' and p_payload->'quantity'<>'null'::jsonb then
      v_quantity:=crm.operations_decimal(p_payload,'quantity',3);
      if v_quantity<=0 or v_unit='' then raise exception using errcode='PT400',message='Enter a positive quantity and its unit.'; end if;
    end if;
    insert into crm.material_alerts(work_order_id,item_id,item_name,quantity_milli,unit,note,assignee_id,assignee_name,reported_by,reported_by_name,created_at)
      values(v_work_id,v_item_id,v_name,v_quantity,v_unit,v_note,v_assignee.user_id,v_assignee.name,p_actor_id,v_actor.name,v_now) returning * into v_alert;
    v_message:='Missing stock reported and assigned.';
  else
    if v_alert.status<>'OPEN' then raise exception using errcode='PT409',message='This alert is already resolved.'; end if;
    v_before:=crm.material_alert_json(v_alert);
    update crm.material_alerts set status='RESOLVED',resolved_at=v_now,resolved_by=p_actor_id,resolved_by_name=v_actor.name where id=v_alert.id returning * into v_alert;
    v_message:='Site alert marked resolved.';
  end if;
  perform crm.extension_audit(v_actor,p_action,'material_alert',v_alert.id,v_before,crm.material_alert_json(v_alert));
  update crm.operations_state set revision=revision+1 where id=1 returning revision into v_revision;
  insert into crm.operations_receipts(request_id,actor_id,action,payload_hash,payload,revision,message)
    values(p_request_id,p_actor_id,p_action,p_payload_hash,p_payload,v_revision,v_message);
  return jsonb_build_object('data',public.crm_material_alerts_read(p_actor_id,p_work_order_id,p_status,p_page,p_search),'message',v_message);
end;
$$;
revoke all on function public.crm_material_alerts_read(uuid,text,text,integer,text),
  public.crm_material_alerts_mutate(uuid,bigint,text,text,text,jsonb,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.crm_material_alerts_read(uuid,text,text,integer,text),
  public.crm_material_alerts_mutate(uuid,bigint,text,text,text,jsonb,text,text,integer,text) to service_role;

alter table crm.operations_audit drop constraint operations_audit_entity_type_check;
alter table crm.operations_audit add constraint operations_audit_entity_type_check check(entity_type in (
  'stock_item','stock_movement','attendance','expense','construction_site','site_assignment','shift_rule','stock_transfer','stock_return',
  'material_request','purchase_order','payment_installment','customer_payment','expense_receipt','job_material','material_alert'));

do $migration$
declare v_target text; v_definition text; v_old text[]; v_new text[]; v_index integer;
begin
  foreach v_target in array array['crm.extension_snapshot(crm.members,text,boolean)','crm.team_activity_module(text,text)','crm.operations_activity_description(crm.operations_audit)'] loop
    v_definition:=replace(pg_get_functiondef(v_target::regprocedure),chr(13)||chr(10),chr(10));
    if v_target='crm.extension_snapshot(crm.members,text,boolean)' then
      v_old:=array[$old$v_job_materials jsonb:='[]'::jsonb;$old$,$old$ if p_full then$old$,$old$  'jobMaterialEntries',v_job_materials,$old$];
      v_new:=array[$new$v_job_materials jsonb:='[]'::jsonb; v_material_alerts jsonb:='[]'::jsonb;$new$,
$new$ if p_full and p_member.role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT') then
  select coalesce(jsonb_agg(crm.material_alert_json(a) order by a.created_at,a.id),'[]'::jsonb) into v_material_alerts from crm.material_alerts a;
 end if;
 if p_full then$new$,
$new$  'materialAlerts',v_material_alerts,
  'jobMaterialEntries',v_job_materials,$new$];
    elsif v_target='crm.team_activity_module(text,text)' then
      v_old:=array[$old$ select case$old$]; v_new:=array[$new$ select case
  when p_entity_type='material_alert' then 'workorders'$new$];
    else
      v_old:=array[$old$ select case$old$]; v_new:=array[$new$ select case
  when p_row.action='material_alert_create' then 'Reported missing '||coalesce(p_row.after_data->>'itemName','stock')||' for '||coalesce(p_row.after_data->>'workOrderNumber','work order')||'; assigned to '||coalesce(p_row.after_data->>'assigneeName','team member')
  when p_row.action='material_alert_resolve' then 'Resolved missing-stock alert for '||coalesce(p_row.after_data->>'workOrderNumber','work order')$new$];
    end if;
    for v_index in 1..array_length(v_old,1) loop
      v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10)); v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
      if position(v_old[v_index] in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
        raise exception using errcode='55000',message='Expected site alert export or audit guard was not found exactly once.';
      end if;
      v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
    end loop;
    execute v_definition;
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
