-- Explicit material confirmations use the existing stock ledger. Listing work or
-- changing delivery status never consumes inventory or invents completed work.
begin;

do $verify$
declare v_target text; v_expected text; v_hash text;
begin
  -- Both CRM status changes and operations writes take this lock first.
  perform 1 from crm.workspace where id=1 for update;
  for v_target,v_expected in select * from (values
    ('crm.extension_snapshot(crm.members,text,boolean)','8e7746b139c654e778b14a33fc858dd2'),
    ('public.crm_operations_v2_mutate(uuid,bigint,text,text,text,jsonb,text)','9ccc31d0d57915fc8d428fee64d63a6d'),
    ('crm.team_activity_module(text,text)','e25f4c27339aaf16778287be3948f480'),
    ('crm.operations_activity_description(crm.operations_audit)','9f4a4d0e4ca1020f5e13dd6001b21a68')
  ) expected(signature,body_hash)
  loop
    select md5(replace(prosrc,chr(13)||chr(10),chr(10))) into v_hash from pg_proc where oid=v_target::regprocedure;
    if v_hash is distinct from v_expected then raise exception using errcode='55000',message='Job material migration requires the verified operations schema.'; end if;
  end loop;
end;
$verify$;

create table crm.job_material_entries (
  id uuid primary key default gen_random_uuid(),
  work_order_id text not null references crm.workorders(id) on delete restrict,
  category text not null check(category in ('Panels','Inverter','Structure','DC Wire','Ac Wire','Earthing Wire','Earthing ROD','Lighting Arrester','Filing')),
  movement_id uuid unique references crm.stock_movements(id) on delete restrict,
  actor_id uuid not null references crm.members(user_id) on delete restrict,
  actor_name text not null check(length(actor_name) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  check(movement_id is not null or category='Filing')
);
create index job_material_entries_work_idx on crm.job_material_entries(work_order_id,created_at,id);
create index job_material_entries_actor_idx on crm.job_material_entries(actor_id);
create unique index job_filing_once on crm.job_material_entries(work_order_id) where movement_id is null;
alter table crm.job_material_entries enable row level security;
revoke all on crm.job_material_entries from public,anon,authenticated,service_role;
create trigger job_material_entries_immutable before update or delete on crm.job_material_entries
  for each row execute function crm.operations_immutable();

create function crm.job_material_entry_guard() returns trigger language plpgsql set search_path='' as $$
declare v_actor crm.members;
begin
  v_actor:=crm.active_member(new.actor_id);
  if v_actor.role not in ('OWNER','MANAGER','OPERATIONS') or new.actor_name is distinct from v_actor.name then
    raise exception using errcode='PT403',message='Only delivery staff can confirm job materials or filing.';
  end if;
  if not exists(select 1 from crm.workorders where id=new.work_order_id and not is_demo and status='ACTIVE') then
    raise exception using errcode='PT409',message='Job confirmations require a real active work order.';
  end if;
  if new.movement_id is not null and not exists(select 1 from crm.stock_movements
    where id=new.movement_id and type='OUT' and actor_id=new.actor_id) then
    raise exception using errcode='PT400',message='A job material entry must link its actual stock-out movement.';
  end if;
  return new;
end;
$$;
create trigger job_material_entries_guard before insert on crm.job_material_entries
  for each row execute function crm.job_material_entry_guard();

create function crm.job_material_entry_json(p_row crm.job_material_entries) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',p_row.id,'workOrderId',p_row.work_order_id,'category',p_row.category,
    'movementId',p_row.movement_id,'itemId',m.item_id,'siteId',m.site_id,'quantityMilli',m.quantity_milli,
    'returnedMilli',(select coalesce(sum(r.quantity_milli),0)::text from crm.stock_returns r where r.movement_id=p_row.movement_id),
    'actorId',p_row.actor_id,'actorName',p_row.actor_name,'createdAt',p_row.created_at)
  from (select 1) x left join crm.stock_movements m on m.id=p_row.movement_id;
$$;
revoke all on function crm.job_material_entry_guard(),crm.job_material_entry_json(crm.job_material_entries) from public,anon,authenticated,service_role;

-- Routine dashboard reads do not scan lifetime job entries. This dedicated read
-- adds only one work order's indexed history to the usual authorized snapshot.
create function public.crm_job_materials_read(p_actor_id uuid,p_month text,p_work_order_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_data jsonb; v_entries jsonb;
begin
  v_data:=public.crm_operations_v2_read(p_actor_id,p_month);
  if not exists(select 1 from crm.workorders where id=p_work_order_id and not is_demo) then
    raise exception using errcode='PT404',message='Choose a real work order.';
  end if;
  select coalesce(jsonb_agg(crm.job_material_entry_json(j) order by j.created_at,j.id),'[]'::jsonb)
    into v_entries from crm.job_material_entries j where j.work_order_id=p_work_order_id;
  return jsonb_set(v_data,'{extension,jobMaterialEntries}',v_entries,true);
end;
$$;
revoke all on function public.crm_job_materials_read(uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_job_materials_read(uuid,text,text) to service_role;

alter table crm.operations_audit drop constraint operations_audit_entity_type_check;
alter table crm.operations_audit add constraint operations_audit_entity_type_check check(entity_type in (
  'stock_item','stock_movement','attendance','expense','construction_site','site_assignment','shift_rule',
  'stock_transfer','stock_return','material_request','purchase_order','payment_installment','customer_payment','expense_receipt','job_material'));

do $migration$
declare v_target text; v_definition text; v_old text[]; v_new text[]; v_index integer;
begin
  foreach v_target in array array['crm.extension_snapshot(crm.members,text,boolean)',
    'public.crm_operations_v2_mutate(uuid,bigint,text,text,text,jsonb,text)',
    'crm.team_activity_module(text,text)','crm.operations_activity_description(crm.operations_audit)']
  loop
    v_definition:=replace(pg_get_functiondef(v_target::regprocedure),chr(13)||chr(10),chr(10));
    if v_target='crm.extension_snapshot(crm.members,text,boolean)' then
      v_old:=array[$old$v_payments jsonb;$old$,$old$begin
 select coalesce(jsonb_agg(crm.attendance_json(a)$old$,$old$  'sites',(select$old$];
      v_new:=array[$new$v_payments jsonb; v_job_materials jsonb:='[]'::jsonb;$new$,
$new$begin
 if p_full then
  select coalesce(jsonb_agg(crm.job_material_entry_json(j) order by j.created_at,j.id),'[]'::jsonb) into v_job_materials from crm.job_material_entries j;
 end if;
 select coalesce(jsonb_agg(crm.attendance_json(a)$new$,
$new$  'jobMaterialEntries',v_job_materials,
  'sites',(select$new$];
    elsif v_target='crm.team_activity_module(text,text)' then
      v_old:=array[$old$ select case$old$];
      v_new:=array[$new$ select case
  when p_entity_type='job_material' then 'workorders'$new$];
    elsif v_target='crm.operations_activity_description(crm.operations_audit)' then
      v_old:=array[$old$ select case$old$];
      v_new:=array[$new$ select case
  when p_row.action='job_material_issue' then 'Confirmed '||coalesce(p_row.after_data->>'category','material')||' use for '||coalesce(p_row.after_data->>'workOrderNumber','work order')
  when p_row.action='job_filing_complete' then 'Completed Filing for '||coalesce(p_row.after_data->>'workOrderNumber','work order')$new$];
    else
      v_old:=array[
$old$ v_installment crm.payment_installments; v_payment crm.customer_payments;$old$,
$old$ if p_action is null or p_action not in ('site_save'$old$,
$old$ if v_actor.role='VIEWER' then$old$,
$old$ case p_action
 when 'site_save' then$old$,
$old$  perform crm.location_movement(v_actor,v_move.item_id,v_site_id,'ADJUST',v_quantity,v_reason,'','RETURN',v_adjustment_id);$old$,
$old$return jsonb_build_object('data',public.crm_operations_v2_read(p_actor_id,p_month),'message',v_receipt.message);$old$,
$old$return jsonb_build_object('data',public.crm_operations_v2_read(p_actor_id,p_month),'message',v_message);$old$
      ];
      v_new:=array[
$new$ v_installment crm.payment_installments; v_payment crm.customer_payments;
 v_job_work crm.workorders; v_job_entry crm.job_material_entries;$new$,
$new$ if p_action is null or p_action not in ('job_material_issue','job_filing_complete','site_save'$new$,
$new$ if p_action in ('job_material_issue','job_filing_complete') and v_actor.role not in ('OWNER','MANAGER','OPERATIONS') then
  raise exception using errcode='PT403',message='Only Owner, Manager and Operations can confirm job materials or filing.';
 end if;
 if v_actor.role='VIEWER' then$new$,
$new$ case p_action
 when 'job_material_issue','job_filing_complete' then
  if p_action='job_material_issue' then
   perform crm.operations_keys(p_payload,array['workOrderId','category','itemId','siteId','quantity'],array['workOrderId','category','itemId','siteId','quantity']);
  else perform crm.operations_keys(p_payload,array['workOrderId'],array['workOrderId']); end if;
  v_work_order:=crm.operations_text(p_payload,'workOrderId',120,true);
  select * into v_job_work from crm.workorders where id=v_work_order and not is_demo;
  if not found then raise exception using errcode='PT404',message='Choose a real work order.'; end if;
  if v_job_work.status<>'ACTIVE' then raise exception using errcode='PT409',message='Start or resume the work order before confirming job materials or filing.'; end if;
  if p_action='job_material_issue' then
   v_name:=crm.operations_text(p_payload,'category',32,true);
   if v_name not in ('Panels','Inverter','Structure','DC Wire','Ac Wire','Earthing Wire','Earthing ROD','Lighting Arrester','Filing') then
    raise exception using errcode='PT400',message='Choose a valid job category.';
   end if;
   v_item_id:=crm.operations_uuid(p_payload,'itemId'); v_site_id:=crm.operations_uuid(p_payload,'siteId'); v_quantity:=crm.operations_decimal(p_payload,'quantity',3);
   v_reference:=left(v_job_work.number,160)||' / '||v_name;
   v_note:='Confirmed material use for '||v_reference;
   v_move:=crm.location_movement(v_actor,v_item_id,v_site_id,'OUT',v_quantity,v_note,v_reference);
   insert into crm.job_material_entries(work_order_id,category,movement_id,actor_id,actor_name,created_at)
    values(v_work_order,v_name,v_move.id,p_actor_id,v_actor.name,v_now) returning * into v_job_entry;
   v_message:='Job material recorded and deducted from the selected stock location.';
  else
   if exists(select 1 from crm.job_material_entries where work_order_id=v_work_order and movement_id is null) then
    raise exception using errcode='PT409',message='Filing is already completed for this work order.';
   end if;
   insert into crm.job_material_entries(work_order_id,category,actor_id,actor_name,created_at)
    values(v_work_order,'Filing',p_actor_id,v_actor.name,v_now) returning * into v_job_entry;
   v_message:='Filing marked complete.';
  end if;
  v_entity:='job_material'; v_entity_id:=v_job_entry.id;
  v_after:=crm.job_material_entry_json(v_job_entry)||jsonb_build_object('workOrderNumber',v_job_work.number);
 when 'site_save' then$new$,
$new$  perform crm.location_movement(v_actor,v_move.item_id,v_site_id,'ADJUST',v_quantity,v_reason,
   case when exists(select 1 from crm.job_material_entries where movement_id=v_move.id) then left('Return / '||v_move.reference,200) else '' end,
   'RETURN',v_adjustment_id);$new$,
$new$return jsonb_build_object('data',case when p_action in ('job_material_issue','job_filing_complete')
   then public.crm_job_materials_read(p_actor_id,p_month,p_payload->>'workOrderId') else public.crm_operations_v2_read(p_actor_id,p_month) end,'message',v_receipt.message);$new$,
$new$return jsonb_build_object('data',case when p_action in ('job_material_issue','job_filing_complete')
  then public.crm_job_materials_read(p_actor_id,p_month,p_payload->>'workOrderId') else public.crm_operations_v2_read(p_actor_id,p_month) end,'message',v_message);$new$
      ];
    end if;
    for v_index in 1..array_length(v_old,1) loop
      v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10)); v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
      if position(v_old[v_index] in v_definition)=0 or length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
        raise exception using errcode='55000',message='Expected job material guard was not found exactly once.';
      end if;
      v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
    end loop;
    execute v_definition;
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
