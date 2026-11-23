-- Smart construction: private, single-company PostgreSQL backend.
-- Apply with the Supabase SQL editor or migration CLI as the database owner.
-- Browser publishable/anon keys and authenticated JWTs cannot read CRM tables
-- or call these RPCs. Only the Next.js server's service-role client may do so.
begin;
create schema if not exists crm;
revoke all on schema crm from public, anon, authenticated, service_role;

create table crm.workspace (
  id smallint primary key check (id = 1),
  revision bigint not null default 0 check (revision between 0 and 9007199254740991),
  company jsonb not null check (jsonb_typeof(company) = 'object' and company->>'currency' = 'INR' and company->>'timeZone' = 'Asia/Kolkata'),
  sequences jsonb not null default '{}'::jsonb check (jsonb_typeof(sequences) = 'object')
);
insert into crm.workspace (id, company) values (1, '{"name":"smart construction","legalName":"","address":"","gstin":"","stateCode":"","phone":"","email":"","website":"","currency":"INR","timeZone":"Asia/Kolkata","terms":"Scope and payment milestones are subject to written agreement. Any additional work requires approval."}'::jsonb);
create table crm.members (
  user_id uuid primary key references auth.users(id) on delete restrict,
  name text not null check (length(name) between 1 and 200),
  email text not null check (length(email) between 3 and 254),
  role text not null check (role in ('OWNER','MANAGER','SALES','OPERATIONS','VIEWER')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index members_email_unique on crm.members (lower(email));
create table crm.customers (
  id text primary key check (length(id) between 1 and 120),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id and jsonb_typeof(payload->'isDemo') = 'boolean'),
  is_demo boolean generated always as ((payload->>'isDemo')::boolean) stored not null
);
create table crm.leads (
  id text primary key check (length(id) between 1 and 120),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id and jsonb_typeof(payload->'isDemo') = 'boolean'),
  customer_id text generated always as (payload->>'customerId') stored not null references crm.customers(id) on delete restrict,
  status text generated always as (payload->>'status') stored not null check (status in ('NEW','CONTACTED','SITE_VISIT','QUOTED','NEGOTIATION','WON','LOST')),
  is_demo boolean generated always as ((payload->>'isDemo')::boolean) stored not null
);
create index leads_customer_idx on crm.leads(customer_id);
create index leads_status_idx on crm.leads(status);
create table crm.followups (
  id text primary key check (length(id) between 1 and 120),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id and jsonb_typeof(payload->'isDemo') = 'boolean'),
  lead_id text generated always as (payload->>'leadId') stored not null references crm.leads(id) on delete restrict,
  status text generated always as (payload->>'status') stored not null check (status in ('OPEN','DONE','CANCELLED')),
  due_at text generated always as (payload->>'dueAt') stored not null,
  is_demo boolean generated always as ((payload->>'isDemo')::boolean) stored not null
);
create index followups_due_idx on crm.followups(status,due_at);
create index followups_lead_idx on crm.followups(lead_id);
create table crm.quotations (
  id text primary key check (length(id) between 1 and 120),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id and jsonb_typeof(payload->'isDemo') = 'boolean' and jsonb_typeof(payload->'items') = 'array' and jsonb_typeof(payload->'totals') = 'object'),
  lead_id text generated always as (payload->>'leadId') stored not null references crm.leads(id) on delete restrict,
  number text generated always as (payload->>'number') stored unique,
  revision_of text generated always as (payload->>'revisionOf') stored unique references crm.quotations(id) on delete restrict,
  revision integer generated always as ((payload->>'revision')::integer) stored not null check (revision >= 1),
  status text generated always as (payload->>'status') stored not null check (status in ('DRAFT','ISSUED','ACCEPTED','DECLINED','EXPIRED','SUPERSEDED')),
  is_demo boolean generated always as ((payload->>'isDemo')::boolean) stored not null,
  check (status = 'DRAFT' or (number is not null and payload->>'issuedAt' is not null)),
  check (status <> 'ACCEPTED' or (payload->>'acceptedAt' is not null and length(btrim(payload->>'acceptanceNote')) > 0))
);
create index quotations_lead_idx on crm.quotations(lead_id);
create table crm.workorders (
  id text primary key check (length(id) between 1 and 120),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id and jsonb_typeof(payload->'isDemo') = 'boolean' and jsonb_typeof(payload->'snapshot') = 'object' and jsonb_typeof(payload->'milestones') = 'array'),
  quote_id text generated always as (payload->>'quoteId') stored not null unique references crm.quotations(id) on delete restrict,
  number text generated always as (payload->>'number') stored not null unique,
  status text generated always as (payload->>'status') stored not null check (status in ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  is_demo boolean generated always as ((payload->>'isDemo')::boolean) stored not null,
  check (coalesce(payload->>'startDate','') = '' or coalesce(payload->>'endDate','') = '' or payload->>'endDate' >= payload->>'startDate')
);
create index workorders_status_idx on crm.workorders(status);
create table crm.audit_events (
  id text primary key,
  actor_id uuid references crm.members(user_id) on delete restrict,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and payload->>'id' = id)
);
create index audit_events_created_idx on crm.audit_events(created_at desc,id);
create table crm.mutation_receipts (
  request_id text primary key check (length(request_id) between 8 and 120),
  actor_id uuid not null references crm.members(user_id) on delete restrict,
  action text not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  revision bigint not null,
  message text not null,
  created_at timestamptz not null default now()
);

-- RLS is defense in depth; no policies or direct application-role grants exist.
alter table crm.workspace enable row level security;
alter table crm.members enable row level security;
alter table crm.customers enable row level security;
alter table crm.leads enable row level security;
alter table crm.followups enable row level security;
alter table crm.quotations enable row level security;
alter table crm.workorders enable row level security;
alter table crm.audit_events enable row level security;
alter table crm.mutation_receipts enable row level security;
revoke all on all tables in schema crm from public, anon, authenticated, service_role;

create function crm.require_service() returns void
language plpgsql set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = 'PT403', message = 'This operation requires the trusted server.';
  end if;
end;
$$;
create function crm.active_member(p_actor_id uuid) returns crm.members
language plpgsql set search_path = '' as $$
declare v_member crm.members;
begin
  select m.* into v_member from crm.members m join auth.users u on u.id = m.user_id
  where m.user_id = p_actor_id and m.active and u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false)
    and (u.banned_until is null or u.banned_until <= now());
  if not found then raise exception using errcode = 'PT403', message = 'This account does not have active CRM access. Ask your owner for an invitation.'; end if;
  return v_member;
end;
$$;
create function crm.require_action(p_actor_id uuid,p_action text) returns crm.members
language plpgsql set search_path = '' as $$
declare v_member crm.members; v_allowed text[];
begin
  v_member := crm.active_member(p_actor_id);
  v_allowed := case
    when p_action in ('customer_save','lead_save','lead_status','quote_save','quote_revise') then array['OWNER','MANAGER','SALES']
    when p_action in ('followup_save','followup_complete','followup_cancel') then array['OWNER','MANAGER','SALES','OPERATIONS']
    when p_action in ('quote_issue','quote_accept','quote_decline','quote_convert') then array['OWNER','MANAGER']
    when p_action in ('workorder_save','milestone_add','milestone_complete') then array['OWNER','MANAGER','OPERATIONS']
    when p_action in ('company_save','member_role','member_active','load_demo','clear_demo','member_invite','member_access_link') then array['OWNER']
    else null end;
  if v_allowed is null then raise exception using errcode='PT400',message='Unknown workspace action.'; end if;
  if not (v_member.role = any(v_allowed)) then raise exception using errcode='PT403',message='Your role does not permit this action.'; end if;
  return v_member;
end;
$$;
create function crm.member_json(p_member crm.members) returns jsonb
language sql immutable set search_path = '' as $$
select jsonb_build_object('userId',(p_member).user_id,'name',(p_member).name,'email',(p_member).email,'role',(p_member).role,'active',(p_member).active);
$$;
create function crm.append_audit(p_actor crm.members,p_action text,p_entity_type text,p_entity_id text,p_description text) returns void
language plpgsql set search_path = '' as $$
declare v_id text := gen_random_uuid()::text; v_created timestamptz := clock_timestamp();
begin
  insert into crm.audit_events(id,actor_id,created_at,payload) values(v_id,p_actor.user_id,v_created,
    jsonb_build_object('id',v_id,'actor',p_actor.name,'action',p_action,'entityType',p_entity_type,'entityId',p_entity_id,'description',p_description,'createdAt',v_created));
end;
$$;

create function crm.protect_document() returns trigger
language plpgsql set search_path = '' as $$
declare v_old text; v_new text; v_quote jsonb; v_action text := current_setting('crm.action',true);
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
    if tg_op = 'INSERT' then
      if v_action not in ('quote_convert','load_demo') or v_action is null then
        raise exception using errcode='PT403',message='Work orders can only be created from accepted quotations.';
      end if;
      select payload into v_quote from crm.quotations where id = new.payload->>'quoteId';
      if v_quote is null or v_quote->>'status' <> 'ACCEPTED' or new.payload->'snapshot' is distinct from v_quote then
        raise exception using errcode='PT400',message='Work orders must preserve an accepted quotation snapshot.';
      end if;
    else
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
create trigger customers_guard before update or delete on crm.customers for each row execute function crm.protect_document();
create trigger leads_guard before update or delete on crm.leads for each row execute function crm.protect_document();
create trigger followups_guard before update or delete on crm.followups for each row execute function crm.protect_document();
create trigger quotations_guard before insert or update or delete on crm.quotations for each row execute function crm.protect_document();
create trigger workorders_guard before insert or update or delete on crm.workorders for each row execute function crm.protect_document();
create function crm.protect_audit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.is_demo and current_setting('crm.action',true) = 'clear_demo' then return old; end if;
  raise exception using errcode='PT400',message='Audit history is append-only.';
end;
$$;
create trigger audit_guard before update or delete on crm.audit_events for each row execute function crm.protect_audit();

create function public.crm_workspace_read(p_actor_id uuid,p_full_audit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_workspace crm.workspace; v_actor crm.members; v_activity jsonb;
begin
  perform crm.require_service();
  select * into v_workspace from crm.workspace where id=1 for share;
  if not found then raise exception using errcode='PT503',message='The CRM database is not initialized.'; end if;
  v_actor := crm.active_member(p_actor_id);
  if p_full_audit then
    select coalesce(jsonb_agg(payload order by created_at desc,id),'[]'::jsonb) into v_activity from crm.audit_events;
  else
    select coalesce(jsonb_agg(payload order by created_at desc,id),'[]'::jsonb) into v_activity from (select payload,created_at,id from crm.audit_events order by created_at desc,id limit 250) a;
  end if;
  return jsonb_build_object(
    'revision',v_workspace.revision,'company',v_workspace.company,'sequences',v_workspace.sequences,
    'user',crm.member_json(v_actor),
    'members',(select coalesce(jsonb_agg(crm.member_json(m) order by m.name,m.user_id),'[]'::jsonb) from crm.members m),
    'customers',(select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) from crm.customers),
    'leads',(select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) from crm.leads),
    'followups',(select coalesce(jsonb_agg(payload order by due_at,id),'[]'::jsonb) from crm.followups),
    'quotations',(select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) from crm.quotations),
    'workorders',(select coalesce(jsonb_agg(payload order by payload->>'createdAt' desc,id),'[]'::jsonb) from crm.workorders),
    'activity',v_activity
  );
end;
$$;
create function public.crm_mutation_prepare(p_actor_id uuid,p_request_id text,p_action text,p_payload_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_data jsonb; v_receipt crm.mutation_receipts;
begin
  perform crm.require_service();
  v_data := public.crm_workspace_read(p_actor_id,false);
  perform crm.require_action(p_actor_id,p_action);
  select * into v_receipt from crm.mutation_receipts where request_id=p_request_id;
  if found and (v_receipt.actor_id <> p_actor_id or v_receipt.action <> p_action or v_receipt.payload_hash <> p_payload_hash) then
    raise exception using errcode='PT409',message='This request ID was already used for a different change.';
  end if;
  return jsonb_build_object('data',v_data,'receiptMessage',v_receipt.message);
end;
$$;

-- Explicit, operator-only initialization. A public visitor cannot invoke it.
-- An invited owner may be designated before confirmation; normal data access
-- remains blocked until that owner's email is confirmed by Supabase Auth.
create function public.crm_bootstrap_status() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform crm.require_service();
  return exists(select 1 from crm.members);
end;
$$;
create function public.crm_bootstrap_owner(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user auth.users; v_member crm.members;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for update;
  if exists(select 1 from crm.members) then raise exception using errcode='PT409',message='Owner initialization has already been completed.'; end if;
  if exists(select 1 from crm.customers) or exists(select 1 from crm.leads) or exists(select 1 from crm.quotations) or exists(select 1 from crm.workorders) then
    raise exception using errcode='PT409',message='Owner initialization requires an empty workspace.';
  end if;
  select * into v_user from auth.users where id=p_user_id;
  if not found or coalesce(btrim(v_user.email),'') = '' or (v_user.banned_until is not null and v_user.banned_until > now()) then
    raise exception using errcode='PT400',message='Choose the explicitly designated Auth user with a valid email.';
  end if;
  insert into crm.members(user_id,name,email,role,active) values(p_user_id,left(coalesce(nullif(v_user.raw_user_meta_data->>'name',''),nullif(v_user.raw_user_meta_data->>'full_name',''),v_user.email),200),v_user.email,'OWNER',true) returning * into v_member;
  update crm.workspace set revision=revision+1 where id=1;
  perform crm.append_audit(v_member,'member.owner_initialized','member',p_user_id::text,'Operator initialized the designated workspace owner');
  return crm.member_json(v_member);
end;
$$;
create function public.crm_add_member(p_actor_id uuid,p_user_id uuid,p_name text,p_email text,p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor crm.members; v_user auth.users; v_existing crm.members;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for update;
  v_actor := crm.require_action(p_actor_id,'member_invite');
  if p_role not in ('OWNER','MANAGER','SALES','OPERATIONS','VIEWER') or p_role is null or length(btrim(p_name)) not between 1 and 200 then
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
create function public.crm_authorize_member_link(p_actor_id uuid,p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor crm.members; v_target crm.members;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for update;
  v_actor := crm.require_action(p_actor_id,'member_access_link');
  select * into v_target from crm.members where user_id=p_user_id and active;
  if not found then raise exception using errcode='PT404',message='Choose an active employee.'; end if;
  if exists(select 1 from auth.users where id=p_user_id and banned_until>now()) then raise exception using errcode='PT403',message='This authentication account is disabled.'; end if;
  update crm.workspace set revision=revision+1 where id=1;
  perform crm.append_audit(v_actor,'member.access_link_requested','member',p_user_id::text,'Owner requested a new sign-in setup or recovery link');
  return jsonb_build_object('userId',v_target.user_id,'name',v_target.name,'email',v_target.email);
end;
$$;

create function public.crm_workspace_commit(
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
    if jsonb_typeof(v_item->'active') is distinct from 'boolean' or v_new_role not in ('OWNER','MANAGER','SALES','OPERATIONS','VIEWER') or v_new_role is null then
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

-- Explicit grants are required: PostgreSQL otherwise grants EXECUTE to PUBLIC.
revoke all on all functions in schema crm from public, anon, authenticated, service_role;
revoke all on function public.crm_workspace_read(uuid,boolean) from public,anon,authenticated;
revoke all on function public.crm_mutation_prepare(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.crm_bootstrap_status() from public,anon,authenticated;
revoke all on function public.crm_bootstrap_owner(uuid) from public,anon,authenticated;
revoke all on function public.crm_add_member(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.crm_authorize_member_link(uuid,uuid) from public,anon,authenticated;
grant execute on function public.crm_workspace_read(uuid,boolean) to service_role;
grant execute on function public.crm_mutation_prepare(uuid,text,text,text) to service_role;
grant execute on function public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text) to service_role;
grant execute on function public.crm_bootstrap_status() to service_role;
grant execute on function public.crm_bootstrap_owner(uuid) to service_role;
grant execute on function public.crm_add_member(uuid,uuid,text,text,text) to service_role;
grant execute on function public.crm_authorize_member_link(uuid,uuid) to service_role;
comment on function public.crm_bootstrap_owner(uuid) is 'Operator-only one-time designation of the intended Supabase Auth owner. Never expose through a web route.';
notify pgrst, 'reload schema';
commit;
