-- Dealers submit enquiries to the CRM and see only the leads they originated.
begin;
select 1 from crm.workspace where id=1 for update;

-- Verify the installed role contracts before changing their allowed role literal.
do $migration$
declare t regprocedure; expected text; definition text; source_hash text;
begin
  for t,expected in select * from (values
    ('public.crm_add_member(uuid,uuid,text,text,text)'::regprocedure,'9ba6bc95a26236cd168bb83d449fd5b0'),
    ('public.crm_workspace_commit(uuid,bigint,text,text,text,jsonb,text)'::regprocedure,'aeda0932908bf5ddedb12d3187655720')
  ) targets(signature,hash)
  loop
    select md5(replace(prosrc,chr(13)||chr(10),chr(10))),pg_get_functiondef(t) into source_hash,definition from pg_proc where oid=t;
    if source_hash<>expected or position('''VIEWER''' in definition)=0 then
      raise exception using errcode='55000',message='Unexpected CRM team role contract.';
    end if;
    execute replace(definition,'''VIEWER''','''DEALER''');
  end loop;
end;
$migration$;

alter table crm.members drop constraint members_role_check;
update crm.members set role='DEALER' where role='VIEWER';
alter table crm.members add constraint members_role_check check(role in ('OWNER','MANAGER','SALES','OPERATIONS','ACCOUNTANT','DEALER'));

-- Account setup and the two dealer RPCs can verify a member without granting staff access.
create function crm.verified_account(p_actor_id uuid) returns crm.members
language plpgsql set search_path='' as $$
declare m crm.members;
begin
  select member.* into m from crm.members member join auth.users u on u.id=member.user_id
    where member.user_id=p_actor_id and member.active and u.email_confirmed_at is not null
      and not coalesce(u.is_anonymous,false) and (u.banned_until is null or u.banned_until<=now());
  if not found then raise exception using errcode='PT403',message='This account does not have active CRM access. Ask your owner for an invitation.'; end if;
  return m;
end;
$$;
revoke all on function crm.verified_account(uuid) from public,anon,authenticated,service_role;
create or replace function crm.active_member(p_actor_id uuid) returns crm.members
language plpgsql set search_path='' as $$
declare m crm.members;
begin
  m:=crm.verified_account(p_actor_id);
  if m.role='DEALER' then raise exception using errcode='PT403',message='Use the dealer lead portal.'; end if;
  return m;
end;
$$;
create function public.crm_account_member(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform crm.require_service();
  return crm.member_json(crm.verified_account(p_actor_id));
end;
$$;

-- Separate from the mutable staff owner of a lead. Existing CRM upserts update only payload.
alter table crm.leads add column dealer_id uuid references crm.members(user_id) on delete restrict;
create index leads_dealer_idx on crm.leads(dealer_id) where dealer_id is not null;
create function crm.protect_dealer_attribution() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and new.dealer_id is distinct from old.dealer_id then
    raise exception using errcode='PT403',message='The submitting dealer cannot be changed.';
  end if;
  -- Keep the exportable attribution in sync, including staff upserts whose INSERT
  -- branch omits dealer_id and whose UPDATE branch preserves the existing column.
  if new.dealer_id is not null then
    new.payload:=jsonb_set(new.payload,'{dealerId}',to_jsonb(new.dealer_id));
  elsif new.payload ? 'dealerId' then new.payload:=new.payload-'dealerId';
  end if;
  return new;
end;
$$;
create trigger lead_dealer_attribution before insert or update on crm.leads for each row execute function crm.protect_dealer_attribution();
revoke all on function crm.protect_dealer_attribution() from public,anon,authenticated,service_role;

create function public.crm_dealer_leads_read(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m crm.members; submitted jsonb;
begin
  perform crm.require_service();
  m:=crm.verified_account(p_actor_id);
  if m.role<>'DEALER' then raise exception using errcode='PT403',message='A dealer account is required.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'title',l.payload->>'title','contact',l.payload->>'contact',
    'phone',l.payload->>'phone','siteAddress',l.payload->>'siteAddress','expectedKw',l.payload->'expectedKw',
    'status',l.status,'createdAt',l.payload->>'createdAt','updatedAt',l.payload->>'updatedAt')
    order by l.payload->>'createdAt' desc,l.id),'[]'::jsonb) into submitted
  from crm.leads l where l.dealer_id=p_actor_id and not l.is_demo;
  return jsonb_build_object('user',jsonb_build_object('userId',m.user_id,'name',m.name,'role',m.role),'leads',submitted);
end;
$$;

create function public.crm_dealer_lead_create(p_actor_id uuid,p_request_id text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  m crm.members; receipt crm.mutation_receipts; fingerprint text; new_revision bigint;
  lead_id text:=gen_random_uuid()::text; customer_id text:=gen_random_uuid()::text;
  stamp timestamptz:=clock_timestamp(); title text; contact text; phone text; site text; kw jsonb;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for update;
  m:=crm.verified_account(p_actor_id);
  if m.role<>'DEALER' then raise exception using errcode='PT403',message='A dealer account is required.'; end if;
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$' then raise exception using errcode='PT400',message='A valid request ID is required.'; end if;
  perform crm.operations_keys(p_payload,array['title','contact','phone','siteAddress','expectedKw'],array['title']);
  title:=crm.operations_text(p_payload,'title',200,true);
  contact:=crm.operations_text(p_payload,'contact',200);
  phone:=crm.operations_text(p_payload,'phone',40);
  site:=crm.operations_text(p_payload,'siteAddress',2000);
  kw:=p_payload->'expectedKw';
  if kw is not null and kw<>'null'::jsonb then
    if jsonb_typeof(kw)<>'number' then raise exception using errcode='PT400',message='Enter a nonnegative numeric expected kW.'; end if;
    if (kw::text)::numeric not between 0 and 1.7976931348623157e308::numeric then raise exception using errcode='PT400',message='Enter a finite nonnegative expected kW.'; end if;
  end if;
  fingerprint:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
  select * into receipt from crm.mutation_receipts where request_id=p_request_id;
  if found then
    if receipt.actor_id<>p_actor_id or receipt.action<>'dealer_lead_create' or receipt.payload_hash<>fingerprint then
      raise exception using errcode='PT409',message='This request ID has already been used.';
    end if;
    return public.crm_dealer_leads_read(p_actor_id);
  end if;
  insert into crm.customers(id,payload) values(customer_id,jsonb_build_object('id',customer_id,
    'name',coalesce(nullif(contact,''),title),'contact',contact,'phone',phone,'email','','address','','stateCode','','gstin','','isDemo',false,'createdAt',stamp));
  insert into crm.leads(id,payload,dealer_id) values(lead_id,jsonb_build_object('id',lead_id,'customerId',customer_id,
    'title',title,'contact',contact,'phone',phone,'email','','expectedKw',kw,'location','','siteAddress',site,'stateCode','',
    'value',0,'status','NEW','source','Dealer','owner','','priority','Medium','notes','','lostReason','','isDemo',false,
    'createdAt',stamp,'updatedAt',stamp),p_actor_id);
  update crm.workspace set revision=revision+1 where id=1 returning revision into new_revision;
  perform crm.append_audit(m,'dealer_lead_create','lead',lead_id,'Submitted dealer lead '||title);
  insert into crm.mutation_receipts(request_id,actor_id,action,payload_hash,revision,message)
    values(p_request_id,p_actor_id,'dealer_lead_create',fingerprint,new_revision,'Lead submitted.');
  return public.crm_dealer_leads_read(p_actor_id);
end;
$$;
revoke all on function public.crm_account_member(uuid),public.crm_dealer_leads_read(uuid),public.crm_dealer_lead_create(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.crm_account_member(uuid),public.crm_dealer_leads_read(uuid),public.crm_dealer_lead_create(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
