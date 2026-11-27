-- Approval reminders are completed inside the authoritative workspace commit.
-- Existing Won leads and existing reminder contents are not backfilled or edited.
begin;
select 1 from crm.workspace where id=1 for update;

alter table crm.quotations add constraint quotations_followup_target_key unique(id,lead_id,is_demo);
alter table crm.followups
  add column quote_id text generated always as (payload->>'quoteId') stored,
  add column approval_origin text check(approval_origin in ('WON','QUOTATION')),
  add constraint followups_quote_id_check check (
    not (payload?'quoteId') or payload->'quoteId'='null'::jsonb or
    (jsonb_typeof(payload->'quoteId')='string' and length(payload->>'quoteId') between 1 and 120)
  ),
  add constraint followups_quote_target_fk foreign key(quote_id,lead_id,is_demo)
    references crm.quotations(id,lead_id,is_demo) on delete restrict;
create index followups_quote_idx on crm.followups(quote_id) where quote_id is not null;

-- Older application servers know neither quoteId nor its edit control. Omission
-- preserves a genuine stored link; only an explicit null unlinks it.
create function crm.preserve_followup_quote() returns trigger
language plpgsql set search_path='' as $$
begin
  if not (new.payload?'quoteId') and old.payload?'quoteId' then
    new.payload:=jsonb_set(new.payload,'{quoteId}',old.payload->'quoteId');
  end if;
  if (new.payload->'quoteId') is distinct from (old.payload->'quoteId') and
    coalesce(current_setting('crm.action',true),'')<>'followup_save' and not coalesce((
      current_setting('crm.action',true)='quote_accept' and old.approval_origin='WON' and
      old.quote_id is null and old.status='OPEN' and
      (new.payload-array['quoteId','updatedAt'])=(old.payload-array['quoteId','updatedAt']) and
      exists(select 1 from crm.quotations q where q.id=new.payload->>'quoteId' and
        q.lead_id=old.lead_id and q.is_demo=old.is_demo and q.status='ACCEPTED')
    ),false) then
    raise exception using errcode='PT403',message='Use follow-up editing to change its quotation link.';
  end if;
  return new;
end;
$$;
create trigger followups_quote_preservation before update on crm.followups
  for each row execute function crm.preserve_followup_quote();
revoke all on function crm.preserve_followup_quote() from public,anon,authenticated,service_role;

create function crm.ensure_approval_followup(p_lead_id text,p_actor crm.members,p_action text,p_quote_id text,p_now timestamptz)
returns text language plpgsql set search_path='' as $$
declare v_lead crm.leads; v_id text; v_owner text;
begin
  -- Caller owns the workspace row lock and has checked the current approver.
  if p_actor.role not in ('OWNER','MANAGER') or p_action not in ('lead_save','lead_status','quote_accept') then
    raise exception using errcode='PT403',message='Only Admin and Manager can create approval follow-ups.';
  end if;
  select * into v_lead from crm.leads where id=p_lead_id;
  if not found or v_lead.status<>'WON' then raise exception using errcode='PT400',message='An approved lead is required.'; end if;
  if v_lead.is_demo then return null; end if;
  if p_quote_id is not null and not exists(select 1 from crm.quotations q
    where q.id=p_quote_id and q.lead_id=p_lead_id and q.status='ACCEPTED' and not q.is_demo) then
    raise exception using errcode='PT400',message='Use the actual accepted quotation for this approved lead.';
  end if;
  -- Manual approval may reuse any open reminder. Quotation acceptance needs an
  -- exact link; an ordinary call or another scope's reminder must stay intact.
  select f.id into v_id from crm.followups f where f.lead_id=p_lead_id and f.status='OPEN' and not f.is_demo
    and (p_quote_id is null or f.quote_id=p_quote_id)
    order by case when f.quote_id=p_quote_id then 0 else 1 end,f.payload->>'createdAt',f.id limit 1;
  if found then return v_id; end if;
  if p_quote_id is not null then
    select f.id into v_id from crm.followups f where f.lead_id=p_lead_id and f.status='OPEN' and not f.is_demo
      and f.quote_id is null and f.approval_origin='WON' order by f.payload->>'createdAt',f.id limit 1;
    if found then
      update crm.followups set payload=payload||jsonb_build_object('quoteId',p_quote_id,'updatedAt',p_now) where id=v_id;
      perform crm.append_audit(p_actor,p_action,'followup',v_id,'Linked accepted quotation to approval follow-up');
      return v_id;
    end if;
  end if;
  select m.user_id::text into v_owner from crm.members m
    where m.user_id::text=v_lead.payload->>'owner' and m.active and m.role<>'DEALER';
  v_owner:=coalesce(v_owner,p_actor.user_id::text);
  v_id:=gen_random_uuid()::text;
  insert into crm.followups(id,approval_origin,payload) values(v_id,case when p_quote_id is null then 'WON' else 'QUOTATION' end,jsonb_build_object(
    'id',v_id,'leadId',p_lead_id,'quoteId',p_quote_id,'title','Follow up approved lead',
    'dueAt',p_now+interval '24 hours','channel','Other','owner',v_owner,'notes','','status','OPEN','outcome','',
    'isDemo',false,'createdAt',p_now,'updatedAt',p_now));
  perform crm.append_audit(p_actor,p_action,'followup',v_id,'Created follow-up for approved lead');
  return v_id;
end;
$$;
revoke all on function crm.ensure_approval_followup(text,crm.members,text,text,timestamptz) from public,anon,authenticated,service_role;

do $migration$
declare v_target regprocedure:='public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure;
  v_definition text; v_hash text; v_old text[]; v_new text[]; v_index integer;
begin
  select md5(replace(prosrc,chr(13)||chr(10),chr(10))),replace(pg_get_functiondef(v_target),chr(13)||chr(10),chr(10))
    into v_hash,v_definition from pg_proc where oid=v_target;
  if v_hash<>'96c286a365e270be1ed775b065a44d7e' then
    raise exception using errcode='55000',message='Approval follow-ups require the verified paper-document workspace contract.';
  end if;
  v_old:=array[
$old$  v_created_orders integer; v_wo_number text; v_lead_id text; v_quote_id text;$old$,
$old$      if v_existing is not null then
        if p_action='load_demo' then$old$,
$old$      perform crm.ensure_won_workorder(v_lead_id,v_actor,p_action,v_quote_id,clock_timestamp());$old$,
$old$  -- Delete only explicitly labelled examples, in child-first order.$old$,
$old$foreach v_table in array array['workorders','quotations','followups','leads','customers'] loop$old$
  ];
  v_new:=array[
$new$  v_created_orders integer; v_wo_number text; v_lead_id text; v_quote_id text;
  v_new_won_leads text[]:=array[]::text[]; v_new_accepted_quotes text[]:=array[]::text[];$new$,
$new$      if v_table='leads' and p_action in ('lead_save','lead_status','quote_accept') and
        v_item->>'status'='WON' and coalesce(v_existing->>'status','NEW')<>'WON' then
        v_new_won_leads:=array_append(v_new_won_leads,v_id);
      end if;
      if v_table='quotations' and p_action='quote_accept' and
        v_item->>'status'='ACCEPTED' and v_existing->>'status'='ISSUED' then
        v_new_accepted_quotes:=array_append(v_new_accepted_quotes,v_id);
      end if;
      if v_existing is not null then
        if p_action='load_demo' then$new$,
$new$      perform crm.ensure_won_workorder(v_lead_id,v_actor,p_action,v_quote_id,clock_timestamp());
      -- Resaving a Won lead must not recreate a completed reminder.
      if p_action in ('lead_save','lead_status') and v_lead_id=any(v_new_won_leads) then
        perform crm.ensure_approval_followup(v_lead_id,v_actor,p_action,null,clock_timestamp());
      end if;$new$,
$new$  -- Only actual new acceptances produce quotation handoffs. Replaying an
  -- unchanged Accepted document through a fresh request must not recreate tasks.
  foreach v_quote_id in array v_new_accepted_quotes loop
    select lead_id into v_lead_id from crm.quotations where id=v_quote_id;
    perform crm.ensure_approval_followup(v_lead_id,v_actor,p_action,v_quote_id,clock_timestamp());
  end loop;
  -- Delete only explicitly labelled examples, in child-first order.$new$,
$new$foreach v_table in array array['workorders','followups','quotations','leads','customers'] loop$new$
  ];
  for v_index in 1..array_length(v_old,1) loop
    v_old[v_index]:=replace(v_old[v_index],chr(13)||chr(10),chr(10));
    v_new[v_index]:=replace(v_new[v_index],chr(13)||chr(10),chr(10));
    if position(v_old[v_index] in v_definition)=0 or
      length(v_definition)-length(replace(v_definition,v_old[v_index],''))<>length(v_old[v_index]) then
      raise exception using errcode='55000',message='Expected approval follow-up integration point was not found exactly once.';
    end if;
    v_definition:=replace(v_definition,v_old[v_index],v_new[v_index]);
  end loop;
  execute v_definition;
end;
$migration$;

notify pgrst,'reload schema';
commit;
