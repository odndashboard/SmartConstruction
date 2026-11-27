-- Dealer access remains a separate, read-only projection. Assignments do not
-- transfer submission ownership or expose customer contacts or commercial data.
begin;

create index leads_assigned_member_idx on crm.leads ((payload->>'owner')) where not is_demo;
create index workorders_assigned_member_idx on crm.workorders ((payload->>'owner')) where not is_demo;

create or replace function public.crm_dealer_leads_read(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m crm.members; submitted jsonb; assigned jsonb; current_revision bigint;
begin
  perform crm.require_service();
  -- Match write lock ordering. Reads wait for an in-flight assignment/role change
  -- and never use the workspace revision as a cache for operations assignments.
  select revision into current_revision from crm.workspace where id=1 for share;
  perform 1 from crm.operations_state where id=1 for share;
  m:=crm.verified_account(p_actor_id);
  if m.role<>'DEALER' then raise exception using errcode='PT403',message='A dealer account is required.'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'title',l.payload->>'title','contact',l.payload->>'contact',
    'phone',l.payload->>'phone','siteAddress',l.payload->>'siteAddress','expectedKw',l.payload->'expectedKw',
    'status',l.status,'createdAt',l.payload->>'createdAt','updatedAt',l.payload->>'updatedAt',
    'canDelete',reason.message is null,'deleteBlockedReason',reason.message)
    order by l.payload->>'createdAt' desc,l.id),'[]'::jsonb) into submitted
  from crm.leads l cross join lateral (select crm.dealer_lead_delete_blocked_reason(l,p_actor_id) as message) reason
  where l.dealer_id=p_actor_id and not l.is_demo;

  with assigned_leads as materialized (
    select l.* from crm.leads l where not l.is_demo and l.payload->>'owner'=p_actor_id::text
  ), assigned_site as materialized (
    select s.* from crm.site_assignments a join crm.construction_sites s on s.id=a.site_id
    where a.user_id=p_actor_id and s.active and s.kind='SITE'
  ), visible_orders as materialized (
    select w.* from crm.workorders w where not w.is_demo and (
      w.payload->>'owner'=p_actor_id::text
      or exists(select 1 from assigned_leads l where l.id=w.lead_id)
      or exists(select 1 from assigned_site s where s.work_order_id=w.id))
  ), projects as (
    select 'workorder:'||w.id as id,coalesce(w.payload->>'title','') as title,
      coalesce(nullif(s.address,''),w.payload->>'siteAddress','') as address,s.name as site_name,s.id as site_id,
      l.id as lead_id,w.id as work_order_id,w.payload->>'number' as work_order_number,
      l.status as lead_status,w.status as work_status,coalesce(w.payload->'expectedKw',l.payload->'expectedKw','null'::jsonb) as expected_kw,
      (select count(*) from jsonb_array_elements(coalesce(w.payload->'milestones','[]'::jsonb)) item where item->>'status'='DONE') as completed,
      jsonb_array_length(coalesce(w.payload->'milestones','[]'::jsonb))::bigint as total,
      to_jsonb(array_remove(array[
        case when exists(select 1 from assigned_leads al where al.id=w.lead_id) then 'LEAD' end,
        case when w.payload->>'owner'=p_actor_id::text then 'WORK_ORDER' end,
        case when s.id is not null then 'SITE' end],null)) as assigned_via
    from visible_orders w
    left join crm.leads l on l.id=w.lead_id and not l.is_demo
    left join assigned_site s on s.work_order_id=w.id
    union all
    select 'lead:'||l.id,coalesce(l.payload->>'title',''),coalesce(l.payload->>'siteAddress',''),null,null,
      l.id,null,null,l.status,null,coalesce(l.payload->'expectedKw','null'::jsonb),0,0,'["LEAD"]'::jsonb
    from assigned_leads l where not exists(select 1 from visible_orders w where w.lead_id=l.id)
    union all
    select 'site:'||s.id,s.name,s.address,s.name,s.id,null,null,null,null,null,'null'::jsonb,0,0,'["SITE"]'::jsonb
    from assigned_site s where s.work_order_id is null
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'siteAddress',p.address,
    'siteName',p.site_name,'siteId',p.site_id,'leadId',p.lead_id,'workOrderId',p.work_order_id,
    'workOrderNumber',p.work_order_number,'leadStatus',p.lead_status,'workOrderStatus',p.work_status,
    'expectedKw',p.expected_kw,'completedMilestones',p.completed,'totalMilestones',p.total,'assignedVia',p.assigned_via)
    order by lower(p.title),p.id),'[]'::jsonb) into assigned from projects p;

  return jsonb_build_object('revision',current_revision,'user',jsonb_build_object('userId',m.user_id,'name',m.name,'role',m.role),
    'leads',submitted,'assignedSites',assigned);
end;
$$;
revoke all on function public.crm_dealer_leads_read(uuid) from public,anon,authenticated;
grant execute on function public.crm_dealer_leads_read(uuid) to service_role;

commit;
