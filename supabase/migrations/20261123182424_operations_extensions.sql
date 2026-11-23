-- Assigned sites, attendance rules, stock logistics, customer payment tracking
-- and private expense evidence. All application access remains through RPCs.
begin;

create table crm.construction_sites (
  id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 200),
  address text not null default '' check(length(address)<=2000), work_order_id text references crm.workorders(id) on delete restrict,
  kind text not null default 'SITE' check(kind in ('STORE','SITE')), active boolean not null default true,
  system boolean not null default false, created_at timestamptz not null default clock_timestamp(),
  check(not system or (kind='STORE' and active))
);
create unique index construction_sites_main_store on crm.construction_sites(system) where system;
insert into crm.construction_sites(name,kind,system) values('Main store','STORE',true);
create table crm.site_assignments (
  user_id uuid primary key references crm.members(user_id) on delete restrict,
  site_id uuid not null references crm.construction_sites(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);
create index site_assignments_site_idx on crm.site_assignments(site_id);
create table crm.shift_rule (
  id smallint primary key check(id=1), audit_id uuid not null default gen_random_uuid(), configured boolean not null default false,
  start_local time, end_local time, overnight boolean not null default false,
  break_minutes integer not null default 0 check(break_minutes between 0 and 1439),
  grace_minutes integer not null default 0 check(grace_minutes between 0 and 120),
  version bigint not null default 0 check(version between 0 and 9007199254740991),
  check(not configured or (start_local is not null and end_local is not null))
);
insert into crm.shift_rule(id) values(1);
create table crm.site_stock_balances (
  item_id uuid not null references crm.stock_items(id) on delete restrict,
  site_id uuid not null references crm.construction_sites(id) on delete restrict,
  quantity_milli bigint not null default 0 check(quantity_milli between 0 and 9000000000000),
  primary key(item_id,site_id)
);
create index site_stock_balances_site_idx on crm.site_stock_balances(site_id,item_id);
-- An initial location allocation is not an external receipt or consumption.
insert into crm.site_stock_balances(item_id,site_id,quantity_milli)
  select i.id,s.id,i.quantity_milli from crm.stock_items i cross join crm.construction_sites s where s.system;
alter table crm.stock_movements add column site_id uuid references crm.construction_sites(id) on delete restrict;
alter table crm.stock_movements add column kind text check(kind is null or kind='RETURN');
alter table crm.stock_movements drop constraint stock_movements_check;
alter table crm.stock_movements add constraint stock_movements_semantics check(
  (type='IN' and quantity_milli>0 and delta_milli=quantity_milli and kind is null)
  or (type='OUT' and quantity_milli>0 and delta_milli=-quantity_milli and kind is null)
  or (type='ADJUST' and length(btrim(note))>0));

create table crm.material_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references crm.members(user_id) on delete restrict,
  site_id uuid not null references crm.construction_sites(id) on delete restrict,
  item_id uuid not null references crm.stock_items(id) on delete restrict,
  quantity_milli bigint not null check(quantity_milli between 1 and 9000000000000),
  fulfilled_milli bigint not null default 0 check(fulfilled_milli>=0),
  status text not null default 'SUBMITTED' check(status in ('SUBMITTED','APPROVED','REJECTED','FULFILLED','CANCELLED')),
  needed_on date, note text not null default '' check(length(note)<=2000), review_note text not null default '' check(length(review_note)<=2000),
  reviewed_by uuid references crm.members(user_id) on delete restrict, reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
  check(fulfilled_milli<=quantity_milli), check(status<>'FULFILLED' or fulfilled_milli=quantity_milli)
);
create index material_requests_user_idx on crm.material_requests(user_id,created_at desc,id);
create index material_requests_site_idx on crm.material_requests(site_id,status);
create table crm.stock_transfers (
  id uuid primary key default gen_random_uuid(), item_id uuid not null references crm.stock_items(id) on delete restrict,
  from_site_id uuid not null references crm.construction_sites(id) on delete restrict,
  to_site_id uuid not null references crm.construction_sites(id) on delete restrict,
  quantity_milli bigint not null check(quantity_milli between 1 and 9000000000000),
  note text not null default '' check(length(note)<=2000), reference text not null default '' check(length(reference)<=200),
  request_id uuid references crm.material_requests(id) on delete restrict,
  actor_id uuid not null references crm.members(user_id) on delete restrict, actor_name text not null,
  created_at timestamptz not null default clock_timestamp(), check(from_site_id<>to_site_id)
);
create index stock_transfers_created_idx on crm.stock_transfers(created_at desc,id);
create table crm.stock_returns (
  id uuid primary key default gen_random_uuid(), movement_id uuid not null references crm.stock_movements(id) on delete restrict,
  adjustment_id uuid not null unique references crm.stock_movements(id) on delete restrict deferrable initially deferred,
  item_id uuid not null references crm.stock_items(id) on delete restrict,
  site_id uuid not null references crm.construction_sites(id) on delete restrict,
  quantity_milli bigint not null check(quantity_milli between 1 and 9000000000000), reason text not null check(length(btrim(reason)) between 1 and 2000),
  actor_id uuid not null references crm.members(user_id) on delete restrict, actor_name text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index stock_returns_movement_idx on crm.stock_returns(movement_id);
create index stock_returns_item_idx on crm.stock_returns(item_id);
create index stock_returns_created_idx on crm.stock_returns(created_at desc,id);
create table crm.purchase_orders (
  id uuid primary key default gen_random_uuid(), number text not null unique,
  supplier text not null check(length(btrim(supplier)) between 1 and 200), site_id uuid not null references crm.construction_sites(id) on delete restrict,
  expected_on date, reference text not null default '' check(length(reference)<=200), notes text not null default '' check(length(notes)<=2000),
  status text not null default 'OPEN' check(status in ('OPEN','PART_RECEIVED','RECEIVED','CANCELLED')),
  cancel_reason text not null default '' check(length(cancel_reason)<=2000),
  created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create index purchase_orders_site_idx on crm.purchase_orders(site_id,status);
create table crm.purchase_order_lines (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references crm.purchase_orders(id) on delete restrict,
  item_id uuid not null references crm.stock_items(id) on delete restrict,
  quantity_milli bigint not null check(quantity_milli between 1 and 9000000000000),
  received_milli bigint not null default 0 check(received_milli>=0),
  unique(order_id,item_id), check(received_milli<=quantity_milli)
);
create table crm.payment_installments (
  id uuid primary key default gen_random_uuid(), work_order_id text not null references crm.workorders(id) on delete restrict,
  title text not null check(length(btrim(title)) between 1 and 200), due_date date not null,
  amount_paise bigint not null check(amount_paise between 1 and 9000000000000),
  cancelled_at timestamptz, cancel_reason text not null default '' check(length(cancel_reason)<=2000),
  created_at timestamptz not null default clock_timestamp()
);
create index payment_installments_order_idx on crm.payment_installments(work_order_id,due_date,created_at,id);
create table crm.customer_payments (
  id uuid primary key default gen_random_uuid(), work_order_id text not null references crm.workorders(id) on delete restrict,
  payment_date date not null, amount_paise bigint not null check(amount_paise between 1 and 9000000000000),
  method text not null check(method in ('CASH','BANK','UPI','CHEQUE','OTHER')),
  reference text not null default '' check(length(reference)<=200), notes text not null default '' check(length(notes)<=2000),
  actor_id uuid not null references crm.members(user_id) on delete restrict, created_at timestamptz not null default clock_timestamp()
);
create index customer_payments_order_idx on crm.customer_payments(work_order_id,payment_date,id);
create table crm.customer_payment_voids (
  payment_id uuid primary key references crm.customer_payments(id) on delete restrict,
  reason text not null check(length(btrim(reason)) between 1 and 2000),
  actor_id uuid not null references crm.members(user_id) on delete restrict, created_at timestamptz not null default clock_timestamp()
);
create table crm.expense_receipts (
  id uuid primary key default gen_random_uuid(), expense_id uuid not null references crm.expenses(id) on delete restrict,
  request_id text not null unique check(request_id ~ '^[A-Za-z0-9_-]{8,120}$'),
  file_name text not null check(length(file_name) between 1 and 200),
  mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes bigint not null check(size_bytes between 1 and 3145728), sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  object_path text not null unique, uploaded_by uuid not null references crm.members(user_id) on delete restrict,
  state text not null default 'PENDING' check(state in ('PENDING','READY','REMOVED')),
  created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
  completed_at timestamptz, removed_at timestamptz
);
create index expense_receipts_expense_idx on crm.expense_receipts(expense_id,state,expires_at);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('crm-expense-receipts','crm-expense-receipts',false,3145728,array['image/jpeg','image/png','image/webp','application/pdf'])
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

alter table crm.attendance add column site_id uuid references crm.construction_sites(id) on delete restrict;
alter table crm.attendance add column shift_snapshot jsonb not null default '{"configured":false,"startLocal":null,"endLocal":null,"overnight":false,"breakMinutes":0,"graceMinutes":0,"version":0}'::jsonb;
alter table crm.attendance add column approved_overtime_minutes bigint not null default 0 check(approved_overtime_minutes>=0);
alter table crm.attendance add column overtime_reason text not null default '' check(length(overtime_reason)<=2000);
alter table crm.attendance add column overtime_reviewed_by uuid references crm.members(user_id) on delete restrict;
alter table crm.attendance add column overtime_reviewed_at timestamptz;
alter table crm.operations_audit drop constraint operations_audit_entity_type_check;
alter table crm.operations_audit add constraint operations_audit_entity_type_check check(entity_type in (
  'stock_item','stock_movement','attendance','expense','construction_site','site_assignment','shift_rule',
  'stock_transfer','stock_return','material_request','purchase_order','payment_installment','customer_payment','expense_receipt'));

do $$ declare v_table text; begin
  foreach v_table in array array['construction_sites','site_assignments','shift_rule','site_stock_balances','material_requests','stock_transfers','stock_returns','purchase_orders','purchase_order_lines','payment_installments','customer_payments','customer_payment_voids','expense_receipts'] loop
    execute format('alter table crm.%I enable row level security',v_table);
    execute format('revoke all on crm.%I from public,anon,authenticated,service_role',v_table);
  end loop;
end $$;
create trigger stock_transfers_immutable before update or delete on crm.stock_transfers for each row execute function crm.operations_immutable();
create trigger stock_returns_immutable before update or delete on crm.stock_returns for each row execute function crm.operations_immutable();
create trigger customer_payments_immutable before update or delete on crm.customer_payments for each row execute function crm.operations_immutable();
create trigger customer_payment_voids_immutable before update or delete on crm.customer_payment_voids for each row execute function crm.operations_immutable();

create function crm.extension_lock(p_actor_id uuid,p_write boolean default false) returns crm.members
language plpgsql set search_path='' as $$
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id=1 for share;
  if not found then raise exception using errcode='PT503',message='The workspace is not initialized.'; end if;
  if p_write then perform 1 from crm.operations_state where id=1 for update;
  else perform 1 from crm.operations_state where id=1 for share; end if;
  if not found then raise exception using errcode='PT503',message='Operations are not initialized.'; end if;
  return crm.active_member(p_actor_id);
end;
$$;

-- Receipt metadata is committed separately from object upload. Reservations
-- bind content identity, quota and ownership; only READY metadata is listed.
create function public.crm_expense_receipt_reserve(p_actor_id uuid,p_expense_id uuid,p_request_id text,p_file_name text,p_mime_type text,p_size_bytes bigint,p_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_expense crm.expenses; v_receipt crm.expense_receipts; v_id uuid; v_extension text; v_count bigint;
begin
 v_actor:=crm.extension_lock(p_actor_id,true);
 if v_actor.role='VIEWER' then raise exception using errcode='PT403',message='Your account has read-only access.'; end if;
 select * into v_expense from crm.expenses where id=p_expense_id and user_id=p_actor_id;
 if not found then raise exception using errcode='PT404',message='Your expense was not found.'; end if;
 if p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$' or p_file_name is null or length(btrim(p_file_name)) not between 1 and 200
  or p_file_name ~ '[[:cntrl:]/\\]' or p_mime_type is null or p_mime_type not in ('image/jpeg','image/png','image/webp','application/pdf')
  or p_size_bytes is null or p_size_bytes not between 1 and 3145728 or p_sha256 is null or p_sha256!~'^[a-f0-9]{64}$' then
  raise exception using errcode='PT400',message='Choose a JPG, PNG, WebP or PDF file up to 3 MiB with a valid file name.';
 end if;
 select * into v_receipt from crm.expense_receipts where request_id=p_request_id;
 if found then
  if v_receipt.uploaded_by<>p_actor_id or v_receipt.expense_id<>p_expense_id or v_receipt.file_name<>p_file_name or v_receipt.mime_type<>p_mime_type
   or v_receipt.size_bytes<>p_size_bytes or v_receipt.sha256<>p_sha256 then raise exception using errcode='PT409',message='This upload request belongs to different file content.'; end if;
  if v_receipt.state='REMOVED' or (v_receipt.state='PENDING' and v_receipt.expires_at<=clock_timestamp()) then raise exception using errcode='PT409',message='This upload reservation expired or was removed. Start a new upload.'; end if;
  if v_receipt.state='PENDING' and v_expense.status not in ('SUBMITTED','REJECTED') then raise exception using errcode='PT409',message='Receipts can be added only to your submitted or rejected expenses.'; end if;
 else
  if v_expense.status not in ('SUBMITTED','REJECTED') then raise exception using errcode='PT409',message='Receipts can be added only to your submitted or rejected expenses.'; end if;
  select count(*) into v_count from crm.expense_receipts where expense_id=p_expense_id and (state='READY' or (state='PENDING' and expires_at>clock_timestamp()));
  if v_count>=5 then raise exception using errcode='PT409',message='An expense can have at most five receipt files.'; end if;
  v_id:=gen_random_uuid(); v_extension:=case p_mime_type when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else 'pdf' end;
  insert into crm.expense_receipts(id,expense_id,request_id,file_name,mime_type,size_bytes,sha256,object_path,uploaded_by,expires_at)
   values(v_id,p_expense_id,p_request_id,p_file_name,p_mime_type,p_size_bytes,p_sha256,'expenses/'||p_expense_id::text||'/'||v_id::text||'.'||v_extension,p_actor_id,clock_timestamp()+interval '20 minutes') returning * into v_receipt;
 end if;
 return crm.receipt_json(v_receipt)||jsonb_build_object('state',v_receipt.state,'bucket','crm-expense-receipts','objectPath',v_receipt.object_path,'sha256',v_receipt.sha256);
end;
$$;

create function public.crm_expense_receipt_complete(p_actor_id uuid,p_receipt_id uuid,p_mime_type text,p_size_bytes bigint,p_sha256 text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_expense crm.expenses; v_receipt crm.expense_receipts;
begin
 v_actor:=crm.extension_lock(p_actor_id,true);
 if v_actor.role='VIEWER' then raise exception using errcode='PT403',message='Your account has read-only access.'; end if;
 select r.* into v_receipt from crm.expense_receipts r join crm.expenses e on e.id=r.expense_id
  where r.id=p_receipt_id and r.uploaded_by=p_actor_id and e.user_id=p_actor_id;
 if not found then raise exception using errcode='PT404',message='Your receipt was not found.'; end if;
 if v_receipt.mime_type is distinct from p_mime_type or v_receipt.size_bytes is distinct from p_size_bytes or v_receipt.sha256 is distinct from p_sha256 then raise exception using errcode='PT409',message='The uploaded file does not match its reservation.'; end if;
 if v_receipt.state='READY' then return crm.receipt_json(v_receipt); end if;
 if v_receipt.state<>'PENDING' or v_receipt.expires_at<=clock_timestamp() then raise exception using errcode='PT409',message='This upload reservation expired or was removed.'; end if;
 select * into v_expense from crm.expenses where id=v_receipt.expense_id;
 if v_expense.status not in ('SUBMITTED','REJECTED') then raise exception using errcode='PT409',message='The expense was reviewed before upload completed. Its evidence cannot be changed.'; end if;
 update crm.expense_receipts set state='READY',completed_at=clock_timestamp() where id=p_receipt_id returning * into v_receipt;
 perform crm.extension_audit(v_actor,'expense_receipt_add','expense_receipt',v_receipt.id,null,crm.receipt_json(v_receipt));
 update crm.operations_state set revision=revision+1 where id=1;
 return crm.receipt_json(v_receipt);
end;
$$;

create function public.crm_expense_receipt_access(p_actor_id uuid,p_receipt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_receipt crm.expense_receipts;
begin
 v_actor:=crm.extension_lock(p_actor_id);
 select r.* into v_receipt from crm.expense_receipts r join crm.expenses e on e.id=r.expense_id
  where r.id=p_receipt_id and r.state='READY' and (v_actor.role='OWNER' or e.user_id=p_actor_id);
 if not found then raise exception using errcode='PT404',message='Receipt not found.'; end if;
 return crm.receipt_json(v_receipt)||jsonb_build_object('bucket','crm-expense-receipts','objectPath',v_receipt.object_path,'sha256',v_receipt.sha256);
end;
$$;

create function public.crm_expense_receipt_remove(p_actor_id uuid,p_receipt_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_actor crm.members; v_receipt crm.expense_receipts; v_status text; v_before jsonb;
begin
 v_actor:=crm.extension_lock(p_actor_id,true);
 if v_actor.role='VIEWER' then raise exception using errcode='PT403',message='Your account has read-only access.'; end if;
 select r.* into v_receipt from crm.expense_receipts r join crm.expenses e on e.id=r.expense_id
  where r.id=p_receipt_id and r.uploaded_by=p_actor_id and e.user_id=p_actor_id;
 if not found then raise exception using errcode='PT404',message='Your receipt was not found.'; end if;
 if v_receipt.state<>'REMOVED' then
  select status into v_status from crm.expenses where id=v_receipt.expense_id;
  if v_receipt.state='READY' and v_status not in ('SUBMITTED','REJECTED') then raise exception using errcode='PT409',message='Evidence for an approved, paid or withdrawn expense cannot be removed.'; end if;
  v_before:=crm.receipt_json(v_receipt);
  update crm.expense_receipts set state='REMOVED',removed_at=clock_timestamp() where id=p_receipt_id returning * into v_receipt;
  perform crm.extension_audit(v_actor,'expense_receipt_remove','expense_receipt',v_receipt.id,v_before,crm.receipt_json(v_receipt),'Receipt removed by its submitter');
  update crm.operations_state set revision=revision+1 where id=1;
 end if;
 return jsonb_build_object('bucket','crm-expense-receipts','objectPath',v_receipt.object_path);
end;
$$;
create function crm.main_store_id() returns uuid language sql stable set search_path='' as $$ select id from crm.construction_sites where system; $$;
create function crm.shift_rule_json() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('configured',configured,'startLocal',to_char(start_local,'HH24:MI'),'endLocal',to_char(end_local,'HH24:MI'),
  'overnight',overnight,'breakMinutes',break_minutes,'graceMinutes',grace_minutes,'version',version) from crm.shift_rule where id=1;
$$;
create function crm.extension_audit(p_actor crm.members,p_action text,p_type text,p_id uuid,p_before jsonb,p_after jsonb,p_reason text default '') returns void
language sql set search_path='' as $$
 insert into crm.operations_audit(actor_id,actor_name,action,entity_type,entity_id,before_data,after_data,reason)
 values(p_actor.user_id,p_actor.name,p_action,p_type,p_id,p_before,p_after,p_reason);
$$;
create function crm.extension_optional_date(p_payload jsonb,p_key text) returns date language plpgsql set search_path='' as $$
begin
 if not(p_payload?p_key) or p_payload->p_key='null'::jsonb then return null; end if;
 return crm.operations_date(crm.operations_text(p_payload,p_key,10,true));
end;
$$;
create function crm.extension_optional_uuid(p_payload jsonb,p_key text) returns uuid language plpgsql set search_path='' as $$
begin
 if not(p_payload?p_key) or p_payload->p_key='null'::jsonb then return null; end if;
 return crm.operations_uuid(p_payload,p_key);
end;
$$;
create function crm.extension_integer(p_payload jsonb,p_key text,p_max bigint) returns bigint language plpgsql set search_path='' as $$
declare v numeric;
begin
 if jsonb_typeof(p_payload->p_key) is distinct from 'number' then raise exception using errcode='PT400',message=p_key||' must be a whole number.'; end if;
 v:=(p_payload->>p_key)::numeric;
 if v<0 or v>p_max or v<>trunc(v) then raise exception using errcode='PT400',message=p_key||' is outside the supported range.'; end if;
 return v::bigint;
end;
$$;
create function crm.extension_site(p_id uuid,p_construction boolean default false) returns crm.construction_sites language plpgsql set search_path='' as $$
declare v crm.construction_sites;
begin
 select * into v from crm.construction_sites where id=p_id and active and (not p_construction or kind='SITE');
 if not found then raise exception using errcode='PT400',message='Choose an active construction site or stock location.'; end if;
 return v;
end;
$$;
create function crm.stock_location_mirror() returns trigger language plpgsql set search_path='' as $$
declare v_quantity bigint;
begin
 new.site_id:=coalesce(new.site_id,crm.main_store_id());
 perform crm.extension_site(new.site_id);
 insert into crm.site_stock_balances(item_id,site_id) values(new.item_id,new.site_id) on conflict do nothing;
 select quantity_milli into v_quantity from crm.site_stock_balances where item_id=new.item_id and site_id=new.site_id for update;
 if v_quantity+new.delta_milli<0 then raise exception using errcode='PT409',message='There is not enough stock at this location.'; end if;
 if v_quantity+new.delta_milli>9000000000000 then raise exception using errcode='PT400',message='The location stock limit would be exceeded.'; end if;
 update crm.site_stock_balances set quantity_milli=v_quantity+new.delta_milli where item_id=new.item_id and site_id=new.site_id;
 return new;
end;
$$;
create trigger stock_location_mirror before insert on crm.stock_movements for each row execute function crm.stock_location_mirror();
create function crm.stock_location_initial() returns trigger language plpgsql set search_path='' as $$
begin
 insert into crm.site_stock_balances(item_id,site_id) values(new.id,crm.main_store_id()); return new;
end;
$$;
create trigger stock_location_initial after insert on crm.stock_items for each row execute function crm.stock_location_initial();
create function crm.stock_locations_reconcile() returns trigger language plpgsql set search_path='' as $$
declare v_id uuid; v_global bigint; v_locations numeric;
begin
 if tg_table_name='stock_items' then v_id:=coalesce(new.id,old.id); else v_id:=coalesce(new.item_id,old.item_id); end if;
 select quantity_milli into v_global from crm.stock_items where id=v_id;
 select coalesce(sum(quantity_milli),0) into v_locations from crm.site_stock_balances where item_id=v_id;
 if v_global is distinct from v_locations then raise exception using errcode='PT409',message='Stock locations do not match the inventory balance.'; end if;
 return null;
end;
$$;
create constraint trigger stock_global_reconcile after insert or update on crm.stock_items deferrable initially deferred for each row execute function crm.stock_locations_reconcile();
create constraint trigger stock_locations_reconcile after insert or update or delete on crm.site_stock_balances deferrable initially deferred for each row execute function crm.stock_locations_reconcile();

create function crm.attendance_extension_guard() returns trigger language plpgsql set search_path='' as $$
declare v_site crm.construction_sites; v_role text; v_assigned uuid;
begin
 if tg_op='INSERT' then
  new.shift_snapshot:=crm.shift_rule_json();
  if new.source='SELF' then
   select role into v_role from crm.members where user_id=new.user_id;
   select site_id into v_assigned from crm.site_assignments where user_id=new.user_id;
   if v_role<>'OWNER' then
    if v_assigned is null or (new.site_id is not null and new.site_id<>v_assigned) then raise exception using errcode='PT403',message='Ask the Owner to assign your construction site before checking in.'; end if;
    new.site_id:=v_assigned;
   end if;
  end if;
  if new.site_id is not null then v_site:=crm.extension_site(new.site_id,true); new.site:=v_site.name; else new.site:=''; end if;
 else
  new.shift_snapshot:=old.shift_snapshot;
  if (new.status,new.check_in,new.check_out,new.site_id,new.site,new.notes) is distinct from (old.status,old.check_in,old.check_out,old.site_id,old.site,old.notes) then
   new.approved_overtime_minutes:=0; new.overtime_reason:=''; new.overtime_reviewed_by:=null; new.overtime_reviewed_at:=null;
  end if;
  if new.site_id is distinct from old.site_id then
   if new.site_id is not null then v_site:=crm.extension_site(new.site_id,true); new.site:=v_site.name; else new.site:=''; end if;
  else new.site:=old.site; end if;
 end if;
 return new;
end;
$$;
create trigger attendance_extension_guard before insert or update on crm.attendance for each row execute function crm.attendance_extension_guard();

create function crm.attendance_metrics(p_row crm.attendance) returns jsonb language plpgsql stable set search_path='' as $$
declare v_elapsed bigint; v_worked bigint; v_expected bigint; v_late bigint; v_eligible bigint; v_start timestamptz; v_end timestamptz; v_break integer;
begin
 if p_row.check_in is not null and p_row.check_out is not null then
  v_elapsed:=floor(extract(epoch from (p_row.check_out-p_row.check_in))/60)::bigint; v_worked:=v_elapsed;
  if coalesce((p_row.shift_snapshot->>'configured')::boolean,false) then
   v_break:=(p_row.shift_snapshot->>'breakMinutes')::integer;
   v_start:=(p_row.work_date+(p_row.shift_snapshot->>'startLocal')::time) at time zone 'Asia/Kolkata';
   v_end:=((p_row.work_date+(p_row.shift_snapshot->>'endLocal')::time)+case when (p_row.shift_snapshot->>'overnight')::boolean then interval '1 day' else interval '0 day' end) at time zone 'Asia/Kolkata';
   v_worked:=greatest(0,v_elapsed-v_break); v_expected:=floor(extract(epoch from(v_end-v_start))/60)::bigint-v_break;
   v_late:=greatest(0,floor(extract(epoch from(p_row.check_in-v_start))/60)::bigint-(p_row.shift_snapshot->>'graceMinutes')::integer);
   v_eligible:=greatest(0,v_worked-v_expected);
  end if;
 end if;
 return jsonb_build_object('elapsedMinutes',v_elapsed,'workedMinutes',v_worked,'expectedMinutes',v_expected,'lateMinutes',v_late,
  'eligibleOvertimeMinutes',v_eligible,'approvedOvertimeMinutes',p_row.approved_overtime_minutes,'overtimeReason',p_row.overtime_reason,
  'overtimeReviewedBy',p_row.overtime_reviewed_by,'overtimeReviewedAt',p_row.overtime_reviewed_at);
end;
$$;
create or replace function crm.attendance_json(p_row crm.attendance) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'userId',p_row.user_id,'memberName',m.name,'workDate',p_row.work_date,'status',p_row.status,
  'checkIn',p_row.check_in,'checkOut',p_row.check_out,'site',p_row.site,'notes',p_row.notes,'source',p_row.source,'updatedAt',p_row.updated_at,
  'siteId',p_row.site_id,'shiftSnapshot',p_row.shift_snapshot,'metrics',crm.attendance_metrics(p_row)) from crm.members m where m.user_id=p_row.user_id;
$$;
create or replace function crm.stock_item_json(p_row crm.stock_items) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'sku',p_row.sku,'name',p_row.name,'unit',p_row.unit,'location',p_row.location,
  'quantityMilli',p_row.quantity_milli,'minQuantityMilli',p_row.min_quantity_milli,'active',p_row.active,'createdBy',p_row.created_by,
  'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
  'receivedMilli',coalesce(sum(s.quantity_milli) filter(where s.type='IN'),0)::text,
  'usedMilli',(coalesce(sum(s.quantity_milli) filter(where s.type='OUT'),0)-(select coalesce(sum(r.quantity_milli),0) from crm.stock_returns r where r.item_id=p_row.id))::text,
  'returnedMilli',(select coalesce(sum(r.quantity_milli),0)::text from crm.stock_returns r where r.item_id=p_row.id),
  'adjustedMilli',coalesce(sum(s.delta_milli) filter(where s.type='ADJUST' and s.kind is null),0)::text)
 from crm.stock_movements s where s.item_id=p_row.id;
$$;
create or replace function crm.stock_movement_json(p_row crm.stock_movements) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'itemId',p_row.item_id,'type',p_row.type,'quantityMilli',p_row.quantity_milli,'deltaMilli',p_row.delta_milli,
  'balanceAfterMilli',p_row.balance_after_milli,'note',p_row.note,'reference',p_row.reference,'actorId',p_row.actor_id,'actorName',p_row.actor_name,
  'createdAt',p_row.created_at,'siteId',coalesce(p_row.site_id,crm.main_store_id()),'kind',p_row.kind,
  'returnedMilli',(select coalesce(sum(quantity_milli),0)::text from crm.stock_returns where movement_id=p_row.id));
$$;
create function crm.site_json(p_row crm.construction_sites) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'name',p_row.name,'address',p_row.address,'workOrderId',p_row.work_order_id,'kind',p_row.kind,'active',p_row.active,'system',p_row.system);
$$;
create function crm.transfer_json(p_row crm.stock_transfers) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'itemId',p_row.item_id,'fromSiteId',p_row.from_site_id,'toSiteId',p_row.to_site_id,'quantityMilli',p_row.quantity_milli,
  'note',p_row.note,'reference',p_row.reference,'requestId',p_row.request_id,'actorId',p_row.actor_id,'actorName',p_row.actor_name,'createdAt',p_row.created_at);
$$;
create function crm.return_json(p_row crm.stock_returns) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'movementId',p_row.movement_id,'itemId',p_row.item_id,'siteId',p_row.site_id,'quantityMilli',p_row.quantity_milli,
  'reason',p_row.reason,'actorId',p_row.actor_id,'actorName',p_row.actor_name,'createdAt',p_row.created_at);
$$;
create function crm.material_request_json(p_row crm.material_requests) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'userId',p_row.user_id,'memberName',m.name,'siteId',p_row.site_id,'itemId',p_row.item_id,
  'quantityMilli',p_row.quantity_milli,'fulfilledMilli',p_row.fulfilled_milli,'status',p_row.status,'neededOn',p_row.needed_on,'note',p_row.note,
  'reviewNote',p_row.review_note,'reviewedBy',p_row.reviewed_by,'reviewedAt',p_row.reviewed_at,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at)
 from crm.members m where m.user_id=p_row.user_id;
$$;
create function crm.purchase_order_json(p_row crm.purchase_orders) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'number',p_row.number,'supplier',p_row.supplier,'siteId',p_row.site_id,'expectedOn',p_row.expected_on,
  'reference',p_row.reference,'notes',p_row.notes,'status',p_row.status,'cancelReason',p_row.cancel_reason,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
  'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'itemId',l.item_id,'quantityMilli',l.quantity_milli,'receivedMilli',l.received_milli) order by l.id),'[]'::jsonb)
    from crm.purchase_order_lines l where l.order_id=p_row.id));
$$;
create function crm.receipt_json(p_row crm.expense_receipts) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'expenseId',p_row.expense_id,'fileName',p_row.file_name,'mimeType',p_row.mime_type,
  'sizeBytes',p_row.size_bytes,'uploadedBy',p_row.uploaded_by,'createdAt',coalesce(p_row.completed_at,p_row.created_at));
$$;
create function crm.payment_net(p_work_order text) returns numeric language sql stable set search_path='' as $$
 select coalesce(sum(p.amount_paise),0) from crm.customer_payments p where p.work_order_id=p_work_order
  and not exists(select 1 from crm.customer_payment_voids v where v.payment_id=p.id);
$$;
create function crm.contract_amount(p_work_order text,p_write boolean default false) returns numeric language plpgsql stable set search_path='' as $$
declare v crm.workorders; v_amount numeric; v_text text;
begin
 select * into v from crm.workorders where id=p_work_order and not is_demo;
 if not found then raise exception using errcode='PT404',message='Choose a real work order.'; end if;
 if p_write and v.status='CANCELLED' then raise exception using errcode='PT409',message='New payment records cannot be added to a cancelled work order.'; end if;
 v_text:=v.payload#>>'{snapshot,totals,total}';
 if v_text is null or v_text !~ '^[0-9]+$' then raise exception using errcode='PT409',message='The work order contract amount is unavailable.'; end if;
 v_amount:=v_text::numeric;
 if v_amount>9007199254740991 then raise exception using errcode='PT409',message='The work order amount exceeds the supported limit.'; end if;
 return v_amount;
end;
$$;
create function crm.installment_json(p_row crm.payment_installments) returns jsonb language plpgsql stable set search_path='' as $$
declare v_prior numeric; v_paid numeric:=0; v_balance numeric:=0;
begin
 if p_row.cancelled_at is null then
  select coalesce(sum(amount_paise),0) into v_prior from crm.payment_installments
   where work_order_id=p_row.work_order_id and cancelled_at is null and (due_date,created_at,id)<(p_row.due_date,p_row.created_at,p_row.id);
  v_paid:=least(p_row.amount_paise,greatest(0,crm.payment_net(p_row.work_order_id)-v_prior)); v_balance:=p_row.amount_paise-v_paid;
 end if;
 return jsonb_build_object('id',p_row.id,'workOrderId',p_row.work_order_id,'title',p_row.title,'dueDate',p_row.due_date,'amountPaise',p_row.amount_paise,
  'paidPaise',v_paid::text,'balancePaise',v_balance::text,'cancelledAt',p_row.cancelled_at,'cancelReason',p_row.cancel_reason,'createdAt',p_row.created_at);
end;
$$;
create function crm.customer_payment_json(p_row crm.customer_payments) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'workOrderId',p_row.work_order_id,'paymentDate',p_row.payment_date,'amountPaise',p_row.amount_paise,
  'method',p_row.method,'reference',p_row.reference,'notes',p_row.notes,'actorId',p_row.actor_id,'createdAt',p_row.created_at,
  'voidedAt',v.created_at,'voidReason',coalesce(v.reason,'')) from (select 1) x left join crm.customer_payment_voids v on v.payment_id=p_row.id;
$$;
create function crm.payment_account_json(p_row crm.workorders,p_today date) returns jsonb language plpgsql stable set search_path='' as $$
declare v_contract numeric:=crm.contract_amount(p_row.id); v_scheduled numeric; v_received numeric:=crm.payment_net(p_row.id); v_overdue numeric;
begin
 select coalesce(sum(amount_paise),0) into v_scheduled from crm.payment_installments where work_order_id=p_row.id and cancelled_at is null;
 select coalesce(sum((crm.installment_json(i)->>'balancePaise')::numeric),0) into v_overdue from crm.payment_installments i
  where i.work_order_id=p_row.id and i.cancelled_at is null and i.due_date<p_today;
 return jsonb_build_object('workOrderId',p_row.id,'number',p_row.payload->>'number','title',p_row.payload->>'title','customerName',p_row.payload->>'customerName',
  'contractPaise',v_contract::text,'scheduledPaise',v_scheduled::text,'receivedPaise',v_received::text,'outstandingPaise',(v_contract-v_received)::text,
  'overduePaise',v_overdue::text,'unallocatedPaise',greatest(0,v_received-v_scheduled)::text);
end;
$$;

create function crm.extension_snapshot(p_member crm.members,p_month text,p_full boolean default false) returns jsonb language plpgsql set search_path='' as $$
declare v_start date:=crm.operations_month(p_month); v_end date:=(v_start+interval '1 month')::date; v_admin boolean:=p_member.role='OWNER';
 v_start_time timestamptz:=v_start::timestamp at time zone 'Asia/Kolkata'; v_end_time timestamptz:=v_end::timestamp at time zone 'Asia/Kolkata';
 v_calendar jsonb; v_summary jsonb; v_purchase jsonb; v_accounts jsonb; v_installments jsonb; v_payments jsonb;
begin
 select coalesce(jsonb_agg(crm.attendance_json(a) order by a.work_date desc,a.id),'[]'::jsonb) into v_calendar from crm.attendance a
  where (v_admin or a.user_id=p_member.user_id) and (p_full or (a.work_date>=v_start and a.work_date<v_end));
 select coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'memberName',s.name,'recordedDays',s.recorded,'presentDays',s.present,'halfDays',s.half,
  'absentDays',s.absent,'leaveDays',s.leave,'openShifts',s.open,'workedMinutes',s.worked,'lateDays',s.late,'eligibleOvertimeMinutes',s.eligible,'approvedOvertimeMinutes',s.approved)
  order by s.name,s.user_id),'[]'::jsonb) into v_summary from (
   select a.user_id,m.name,count(*) recorded,count(*) filter(where a.status='PRESENT') present,count(*) filter(where a.status='HALF_DAY') half,
    count(*) filter(where a.status='ABSENT') absent,count(*) filter(where a.status='LEAVE') leave,
    count(*) filter(where a.check_in is not null and a.check_out is null) open,
    coalesce(sum((crm.attendance_metrics(a)->>'workedMinutes')::bigint),0) worked,
    count(*) filter(where (crm.attendance_metrics(a)->>'lateMinutes')::bigint>0) late,
    coalesce(sum((crm.attendance_metrics(a)->>'eligibleOvertimeMinutes')::bigint),0) eligible,sum(a.approved_overtime_minutes) approved
   from crm.attendance a join crm.members m on m.user_id=a.user_id
   where (v_admin or a.user_id=p_member.user_id) and (p_full or (a.work_date>=v_start and a.work_date<v_end)) group by a.user_id,m.name
  ) s;
 if v_admin then
  select coalesce(jsonb_agg(crm.purchase_order_json(p) order by p.created_at desc,p.id),'[]'::jsonb) into v_purchase from crm.purchase_orders p;
  select coalesce(jsonb_agg(crm.payment_account_json(w,(clock_timestamp() at time zone 'Asia/Kolkata')::date) order by w.number,w.id),'[]'::jsonb) into v_accounts from crm.workorders w where not w.is_demo;
  select coalesce(jsonb_agg(crm.installment_json(i) order by i.due_date,i.created_at,i.id),'[]'::jsonb) into v_installments from crm.payment_installments i;
  select coalesce(jsonb_agg(crm.customer_payment_json(p) order by p.payment_date desc,p.created_at desc,p.id),'[]'::jsonb) into v_payments from crm.customer_payments p;
 end if;
 return jsonb_build_object(
  'sites',(select coalesce(jsonb_agg(crm.site_json(s) order by s.system desc,s.name,s.id),'[]'::jsonb) from crm.construction_sites s),
  'assignments',(select coalesce(jsonb_agg(jsonb_build_object('userId',a.user_id,'siteId',a.site_id,'updatedAt',a.updated_at) order by a.user_id),'[]'::jsonb) from crm.site_assignments a where v_admin or a.user_id=p_member.user_id),
  'shiftRule',crm.shift_rule_json(),'attendanceCalendar',v_calendar,'attendanceSummary',v_summary,
  'siteBalances',(select coalesce(jsonb_agg(jsonb_build_object('itemId',b.item_id,'siteId',b.site_id,'quantityMilli',b.quantity_milli) order by b.item_id,b.site_id),'[]'::jsonb) from crm.site_stock_balances b),
  'transfers',(select coalesce(jsonb_agg(crm.transfer_json(t) order by t.created_at desc,t.id),'[]'::jsonb) from crm.stock_transfers t where p_full or (t.created_at>=v_start_time and t.created_at<v_end_time)),
  'returns',(select coalesce(jsonb_agg(crm.return_json(r) order by r.created_at desc,r.id),'[]'::jsonb) from crm.stock_returns r where p_full or (r.created_at>=v_start_time and r.created_at<v_end_time)),
  'materialRequests',(select coalesce(jsonb_agg(crm.material_request_json(r) order by r.created_at desc,r.id),'[]'::jsonb) from crm.material_requests r where v_admin or r.user_id=p_member.user_id),
  'purchaseOrders',v_purchase,'paymentAccounts',v_accounts,'paymentInstallments',v_installments,'customerPayments',v_payments,
  'expenseReceipts',(select coalesce(jsonb_agg(crm.receipt_json(r) order by r.completed_at desc,r.id),'[]'::jsonb) from crm.expense_receipts r join crm.expenses e on e.id=r.expense_id where r.state='READY' and (v_admin or e.user_id=p_member.user_id)));
end;
$$;
create function public.crm_operations_v2_read(p_actor_id uuid,p_month text) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_member crm.members;
begin
 v_member:=crm.extension_lock(p_actor_id);
 return public.crm_operations_read(p_actor_id,p_month)||jsonb_build_object('extension',crm.extension_snapshot(v_member,p_month));
end;
$$;
create function public.crm_operations_v2_export(p_actor_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_member crm.members; v_month text:=to_char(clock_timestamp() at time zone 'Asia/Kolkata','YYYY-MM');
begin
 v_member:=crm.extension_lock(p_actor_id);
 return public.crm_operations_export(p_actor_id)||jsonb_build_object('extension',crm.extension_snapshot(v_member,v_month,true));
end;
$$;

create function crm.location_movement(p_actor crm.members,p_item uuid,p_site uuid,p_type text,p_quantity bigint,p_note text,p_reference text,p_kind text default null,p_id uuid default null) returns crm.stock_movements
language plpgsql set search_path='' as $$
declare v_item crm.stock_items; v_local bigint; v_delta bigint; v_global bigint; v_row crm.stock_movements;
begin
 perform crm.extension_site(p_site);
 select * into v_item from crm.stock_items where id=p_item and active;
 if not found then raise exception using errcode='PT404',message='Choose an active stock item.'; end if;
 select coalesce((select quantity_milli from crm.site_stock_balances where item_id=p_item and site_id=p_site),0) into v_local;
 if p_type not in ('IN','OUT','ADJUST') or (p_type<>'ADJUST' and p_quantity<=0) or p_quantity<0 or p_quantity>9000000000000 then raise exception using errcode='PT400',message='Enter a valid stock quantity.'; end if;
 if p_type='ADJUST' and length(btrim(p_note))=0 then raise exception using errcode='PT400',message='A correction reason is required.'; end if;
 v_delta:=case p_type when 'IN' then p_quantity when 'OUT' then -p_quantity else p_quantity-v_local end;
 if p_kind='RETURN' then v_delta:=p_quantity; end if;
 v_global:=v_item.quantity_milli+v_delta;
 if v_local+v_delta<0 then raise exception using errcode='PT409',message='There is not enough stock at this location.'; end if;
 if v_global<0 or v_global>9000000000000 or v_local+v_delta>9000000000000 then raise exception using errcode='PT400',message='The resulting stock quantity is outside the supported range.'; end if;
 update crm.stock_items set quantity_milli=v_global,updated_at=clock_timestamp() where id=p_item;
 insert into crm.stock_movements(id,item_id,site_id,type,kind,quantity_milli,delta_milli,balance_after_milli,note,reference,actor_id,actor_name)
  values(coalesce(p_id,gen_random_uuid()),p_item,p_site,p_type,p_kind,p_quantity,v_delta,v_global,p_note,p_reference,p_actor.user_id,p_actor.name) returning * into v_row;
 return v_row;
end;
$$;
create function crm.transfer_stock(p_actor crm.members,p_item uuid,p_from uuid,p_to uuid,p_quantity bigint,p_note text,p_reference text,p_request uuid default null) returns crm.stock_transfers
language plpgsql set search_path='' as $$
declare v_from bigint; v_to bigint; v_row crm.stock_transfers;
begin
 perform crm.extension_site(p_from); perform crm.extension_site(p_to);
 if p_from=p_to or p_quantity<=0 or p_quantity>9000000000000 then raise exception using errcode='PT400',message='Choose different stock locations and a positive quantity.'; end if;
 if not exists(select 1 from crm.stock_items where id=p_item and active) then raise exception using errcode='PT404',message='Choose an active stock item.'; end if;
 insert into crm.site_stock_balances(item_id,site_id) values(p_item,p_from),(p_item,p_to) on conflict do nothing;
 select quantity_milli into v_from from crm.site_stock_balances where item_id=p_item and site_id=p_from for update;
 select quantity_milli into v_to from crm.site_stock_balances where item_id=p_item and site_id=p_to for update;
 if p_quantity>v_from then raise exception using errcode='PT409',message='There is not enough stock at the source location.'; end if;
 if v_to+p_quantity>9000000000000 then raise exception using errcode='PT400',message='The destination stock limit would be exceeded.'; end if;
 update crm.site_stock_balances set quantity_milli=quantity_milli+case when site_id=p_to then p_quantity else -p_quantity end where item_id=p_item and site_id in(p_from,p_to);
 insert into crm.stock_transfers(item_id,from_site_id,to_site_id,quantity_milli,note,reference,request_id,actor_id,actor_name)
  values(p_item,p_from,p_to,p_quantity,p_note,p_reference,p_request,p_actor.user_id,p_actor.name) returning * into v_row;
 return v_row;
end;
$$;

alter table crm.operations_state add column purchase_sequence bigint not null default 0 check(purchase_sequence between 0 and 9007199254740991);
alter table crm.operations_receipts add column required_role text check(required_role is null or required_role='OWNER');
create function public.crm_operations_v2_mutate(p_actor_id uuid,p_expected_revision bigint,p_request_id text,p_action text,p_payload_hash text,p_payload jsonb,p_month text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_actor crm.members; v_receipt crm.operations_receipts; v_revision bigint; v_result jsonb;
 v_id uuid; v_site_id uuid; v_from uuid; v_to uuid; v_item_id uuid; v_user_id uuid; v_adjustment_id uuid;
 v_site crm.construction_sites; v_request crm.material_requests; v_order crm.purchase_orders; v_line crm.purchase_order_lines;
 v_move crm.stock_movements; v_transfer crm.stock_transfers; v_return crm.stock_returns; v_attendance crm.attendance;
 v_installment crm.payment_installments; v_payment crm.customer_payments;
 v_now timestamptz:=clock_timestamp(); v_today date; v_date date; v_in timestamptz; v_out timestamptz;
 v_name text; v_address text; v_work_order text; v_note text; v_reference text; v_status text; v_type text; v_reason text:='';
 v_quantity bigint; v_amount bigint; v_total numeric; v_contract numeric; v_sequence bigint; v_minutes bigint;
 v_configured boolean; v_overnight boolean; v_start time; v_end time; v_break integer; v_grace integer; v_duration integer; v_active boolean;
 v_before jsonb; v_after jsonb; v_entity text; v_entity_id uuid; v_message text; v_row jsonb; v_seen uuid[]:='{}'; v_required_role text;
begin
 -- The established dispatcher remains the sole implementation of unchanged
 -- actions. Its stock inserts and attendance updates run the new guards.
 if p_action in ('stock_item_save','stock_item_active','stock_move','attendance_check_out','expense_save','expense_withdraw','expense_review') then
  v_result:=public.crm_operations_mutate(p_actor_id,p_expected_revision,p_request_id,p_action,p_payload_hash,p_payload,p_month);
  return jsonb_build_object('data',public.crm_operations_v2_read(p_actor_id,p_month),'message',v_result->>'message');
 end if;
 v_actor:=crm.extension_lock(p_actor_id,true);
 select revision into v_revision from crm.operations_state where id=1;
 if p_action is null or p_action not in ('site_save','site_active','site_assign','shift_rule_save','attendance_check_in','attendance_correct','attendance_overtime_approve',
  'stock_location_move','stock_transfer','stock_return','material_request_create','material_request_cancel','material_request_review','material_request_fulfill',
  'purchase_order_create','purchase_order_receive','purchase_order_cancel','payment_installment_add','payment_installment_cancel','payment_record','payment_void') then
  raise exception using errcode='PT400',message='Unknown operations action.';
 end if;
 if v_actor.role='VIEWER' then raise exception using errcode='PT403',message='Your account has read-only access.'; end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception using errcode='PT400',message='The action payload must be an object.'; end if;
 if p_action in ('site_save','site_active','site_assign','shift_rule_save','attendance_correct','attendance_overtime_approve','material_request_review','material_request_fulfill',
  'purchase_order_create','purchase_order_receive','purchase_order_cancel','payment_installment_add','payment_installment_cancel','payment_record','payment_void') then v_required_role:='OWNER'; end if;
 if p_action='stock_location_move' then
  v_type:=crm.operations_text(p_payload,'type',6,true); if v_type='ADJUST' then v_required_role:='OWNER'; end if;
 end if;
 if v_required_role='OWNER' and v_actor.role<>'OWNER' then raise exception using errcode='PT403',message='Only the Owner can perform this action.'; end if;
 if p_action='material_request_cancel' and v_actor.role<>'OWNER' then
  if not exists(select 1 from crm.material_requests where id=crm.operations_uuid(p_payload,'id') and user_id=p_actor_id) then raise exception using errcode='PT403',message='You can cancel only your own material request.'; end if;
 end if;
 if p_expected_revision is null or p_expected_revision<0 or p_expected_revision>9007199254740991 or p_request_id is null or p_request_id!~'^[A-Za-z0-9_-]{8,120}$'
  or p_payload_hash is null or p_payload_hash!~'^[a-f0-9]{64}$' then raise exception using errcode='PT400',message='The request is not valid.'; end if;
 perform crm.operations_month(p_month);
 select * into v_receipt from crm.operations_receipts where request_id=p_request_id;
 if found then
  if v_receipt.required_role='OWNER' and v_actor.role<>'OWNER' then raise exception using errcode='PT403',message='Only the Owner can perform this action.'; end if;
  if v_receipt.actor_id<>p_actor_id or v_receipt.action<>p_action or v_receipt.payload_hash<>p_payload_hash or v_receipt.payload is distinct from p_payload then raise exception using errcode='PT409',message='This request ID belongs to a different action.'; end if;
  return jsonb_build_object('data',public.crm_operations_v2_read(p_actor_id,p_month),'message',v_receipt.message);
 end if;
 if v_revision<>p_expected_revision then raise exception using errcode='PT409',message='Operations changed. Refresh and try again.'; end if;
 if v_revision=9007199254740991 then raise exception using errcode='PT409',message='The operations revision limit has been reached.'; end if;
 v_now:=clock_timestamp(); v_today:=(v_now at time zone 'Asia/Kolkata')::date;

 case p_action
 when 'site_save' then
  perform crm.operations_keys(p_payload,array['id','name','address','workOrderId'],array['name']);
  v_id:=crm.operations_uuid(p_payload,'id',false); v_name:=crm.operations_text(p_payload,'name',200,true); v_address:=crm.operations_text(p_payload,'address',2000);
  if p_payload?'workOrderId' and p_payload->'workOrderId'<>'null'::jsonb then
   v_work_order:=crm.operations_text(p_payload,'workOrderId',120,true);
   if not exists(select 1 from crm.workorders where id=v_work_order and not is_demo) then raise exception using errcode='PT404',message='Choose a real work order.'; end if;
  end if;
  if v_id is null then insert into crm.construction_sites(name,address,work_order_id) values(v_name,v_address,v_work_order) returning * into v_site;
  else
   select * into v_site from crm.construction_sites where id=v_id;
   if not found then raise exception using errcode='PT404',message='Site not found.'; end if;
   if v_site.system then raise exception using errcode='PT409',message='The Main store is a permanent stock location and cannot be edited.'; end if;
   v_before:=crm.site_json(v_site);
   update crm.construction_sites set name=v_name,address=v_address,work_order_id=v_work_order where id=v_id returning * into v_site;
  end if;
  v_entity:='construction_site'; v_entity_id:=v_site.id; v_after:=crm.site_json(v_site); v_message:='Construction site saved.';
 when 'site_active' then
  perform crm.operations_keys(p_payload,array['id','active'],array['id','active']); v_id:=crm.operations_uuid(p_payload,'id');
  if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception using errcode='PT400',message='Active must be true or false.'; end if;
  v_active:=(p_payload->>'active')::boolean; select * into v_site from crm.construction_sites where id=v_id;
  if not found then raise exception using errcode='PT404',message='Site not found.'; end if;
  if not v_active and (v_site.system or exists(select 1 from crm.site_stock_balances where site_id=v_id and quantity_milli<>0)
   or exists(select 1 from crm.site_assignments a join crm.members m on m.user_id=a.user_id where a.site_id=v_id and m.active)
   or exists(select 1 from crm.purchase_orders where site_id=v_id and status in ('OPEN','PART_RECEIVED'))
   or exists(select 1 from crm.material_requests where site_id=v_id and status in ('SUBMITTED','APPROVED'))) then
   raise exception using errcode='PT409',message='Remove active assignments and resolve stock, requests and purchase orders before archiving this site.';
  end if;
  v_before:=crm.site_json(v_site); update crm.construction_sites set active=v_active where id=v_id returning * into v_site;
  v_entity:='construction_site'; v_entity_id:=v_id; v_after:=crm.site_json(v_site); v_message:=case when v_active then 'Site restored.' else 'Site archived.' end;
 when 'site_assign' then
  perform crm.operations_keys(p_payload,array['userId','siteId'],array['userId','siteId']); v_user_id:=crm.operations_uuid(p_payload,'userId'); v_site_id:=crm.extension_optional_uuid(p_payload,'siteId');
  if not exists(select 1 from crm.members where user_id=v_user_id and (v_site_id is null or active)) then raise exception using errcode='PT404',message='Choose an existing member, or an active member for a new assignment.'; end if;
  select jsonb_build_object('userId',a.user_id,'siteId',a.site_id,'updatedAt',a.updated_at) into v_before from crm.site_assignments a where user_id=v_user_id;
  if v_site_id is null then delete from crm.site_assignments where user_id=v_user_id;
  else perform crm.extension_site(v_site_id,true);
   insert into crm.site_assignments(user_id,site_id,updated_at) values(v_user_id,v_site_id,v_now)
    on conflict(user_id) do update set site_id=excluded.site_id,updated_at=excluded.updated_at;
  end if;
  v_entity:='site_assignment'; v_entity_id:=v_user_id; v_after:=jsonb_build_object('userId',v_user_id,'siteId',v_site_id,'updatedAt',v_now); v_message:='Site assignment saved.';
 when 'shift_rule_save' then
  perform crm.operations_keys(p_payload,array['configured','startLocal','endLocal','overnight','breakMinutes','graceMinutes'],array['configured']);
  if jsonb_typeof(p_payload->'configured') is distinct from 'boolean' or (p_payload?'overnight' and jsonb_typeof(p_payload->'overnight') is distinct from 'boolean') then raise exception using errcode='PT400',message='Check the shift settings.'; end if;
  v_configured:=(p_payload->>'configured')::boolean; v_overnight:=coalesce((p_payload->>'overnight')::boolean,false);
  v_break:=case when p_payload?'breakMinutes' then crm.extension_integer(p_payload,'breakMinutes',1439) else 0 end;
  v_grace:=case when p_payload?'graceMinutes' then crm.extension_integer(p_payload,'graceMinutes',120) else 0 end;
  if v_configured then
   v_name:=crm.operations_text(p_payload,'startLocal',5,true); v_note:=crm.operations_text(p_payload,'endLocal',5,true);
   if v_name!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or v_note!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception using errcode='PT400',message='Use HH:mm for shift times.'; end if;
   v_start:=v_name::time; v_end:=v_note::time; v_duration:=extract(epoch from(v_end-v_start))/60+case when v_overnight then 1440 else 0 end;
   if v_duration<=0 or v_duration>1440 or v_break>=v_duration then raise exception using errcode='PT400',message='Choose a shift up to 24 hours with a shorter break.'; end if;
  else v_start:=null; v_end:=null; v_overnight:=false; v_break:=0; v_grace:=0; end if;
  v_before:=crm.shift_rule_json();
  update crm.shift_rule set configured=v_configured,start_local=v_start,end_local=v_end,overnight=v_overnight,break_minutes=v_break,grace_minutes=v_grace,version=version+1 where id=1 returning audit_id into v_entity_id;
  v_entity:='shift_rule'; v_after:=crm.shift_rule_json(); v_message:='Shift rules saved for new attendance records.';
 when 'attendance_check_in' then
  perform crm.operations_keys(p_payload,array['siteId','site','notes']);
  v_site_id:=crm.extension_optional_uuid(p_payload,'siteId'); perform crm.operations_text(p_payload,'site',200); v_note:=crm.operations_text(p_payload,'notes',2000);
  if exists(select 1 from crm.attendance where user_id=p_actor_id and (work_date=v_today or (check_in is not null and check_out is null))) then raise exception using errcode='PT409',message='Attendance is already recorded or another shift is still open.'; end if;
  insert into crm.attendance(user_id,work_date,status,check_in,site_id,notes,source,created_at,updated_at)
   values(p_actor_id,v_today,'PRESENT',v_now,v_site_id,v_note,'SELF',v_now,v_now) returning * into v_attendance;
  v_entity:='attendance'; v_entity_id:=v_attendance.id; v_after:=crm.attendance_json(v_attendance); v_message:='You are checked in.';
 when 'attendance_correct' then
  perform crm.operations_keys(p_payload,array['userId','workDate','status','checkIn','checkOut','siteId','site','notes','reason'],array['userId','workDate','status','reason']);
  v_user_id:=crm.operations_uuid(p_payload,'userId'); v_date:=crm.operations_date(crm.operations_text(p_payload,'workDate',10,true)); v_status:=crm.operations_text(p_payload,'status',8,true);
  v_in:=crm.operations_timestamp(p_payload,'checkIn'); v_out:=crm.operations_timestamp(p_payload,'checkOut'); v_note:=crm.operations_text(p_payload,'notes',2000); v_reason:=crm.operations_text(p_payload,'reason',2000,true);
  perform crm.operations_text(p_payload,'site',200);
  if not exists(select 1 from crm.members where user_id=v_user_id) then raise exception using errcode='PT404',message='Team member not found.'; end if;
  if v_status not in ('PRESENT','HALF_DAY','ABSENT','LEAVE') or v_date>v_today or v_in>v_now or v_out>v_now
   or (v_status in ('ABSENT','LEAVE') and (v_in is not null or v_out is not null))
   or (v_out is not null and (v_in is null or v_out<=v_in)) or (v_in is not null and (v_in at time zone 'Asia/Kolkata')::date<>v_date) then raise exception using errcode='PT400',message='Check the attendance date, times and status.'; end if;
  if v_in is not null and v_out is null and exists(select 1 from crm.attendance where user_id=v_user_id and work_date<>v_date and check_in is not null and check_out is null) then raise exception using errcode='PT409',message='This member already has another open shift.'; end if;
  select * into v_attendance from crm.attendance where user_id=v_user_id and work_date=v_date;
  if found then v_before:=crm.attendance_json(v_attendance); v_site_id:=v_attendance.site_id; end if;
  if p_payload?'siteId' then v_site_id:=crm.extension_optional_uuid(p_payload,'siteId'); end if;
  -- A closed site's historical attendance still needs corrections. Validate
  -- only new site links; preserve the existing snapshot on an unchanged link.
  if v_site_id is not null and (v_before is null or v_site_id is distinct from v_attendance.site_id) then perform crm.extension_site(v_site_id,true); end if;
  if v_before is null then
   insert into crm.attendance(user_id,work_date,status,check_in,check_out,site_id,notes,source,created_at,updated_at)
    values(v_user_id,v_date,v_status,v_in,v_out,v_site_id,v_note,'ADMIN',v_now,v_now) returning * into v_attendance;
  else
   update crm.attendance set status=v_status,check_in=v_in,check_out=v_out,site_id=v_site_id,notes=v_note,source='ADMIN',updated_at=v_now
    where id=v_attendance.id returning * into v_attendance;
  end if;
  v_entity:='attendance'; v_entity_id:=v_attendance.id; v_after:=crm.attendance_json(v_attendance); v_message:='Attendance correction saved.';
 when 'attendance_overtime_approve' then
  perform crm.operations_keys(p_payload,array['id','minutes','reason'],array['id','minutes','reason']); v_id:=crm.operations_uuid(p_payload,'id'); v_minutes:=crm.extension_integer(p_payload,'minutes',9007199254740991); v_reason:=crm.operations_text(p_payload,'reason',2000,true);
  select * into v_attendance from crm.attendance where id=v_id;
  if not found then raise exception using errcode='PT404',message='Attendance record not found.'; end if;
  v_total:=(crm.attendance_metrics(v_attendance)->>'eligibleOvertimeMinutes')::numeric;
  if v_total is null or v_minutes>v_total then raise exception using errcode='PT400',message='Approve no more than the eligible overtime of a completed configured shift.'; end if;
  v_before:=crm.attendance_json(v_attendance);
  update crm.attendance set approved_overtime_minutes=v_minutes,overtime_reason=v_reason,overtime_reviewed_by=p_actor_id,overtime_reviewed_at=v_now,updated_at=v_now where id=v_id returning * into v_attendance;
  v_entity:='attendance'; v_entity_id:=v_id; v_after:=crm.attendance_json(v_attendance); v_message:='Overtime approval saved.';
 when 'stock_location_move' then
  perform crm.operations_keys(p_payload,array['itemId','siteId','type','quantity','note','reference'],array['itemId','siteId','type','quantity']);
  v_item_id:=crm.operations_uuid(p_payload,'itemId'); v_site_id:=crm.operations_uuid(p_payload,'siteId'); v_quantity:=crm.operations_decimal(p_payload,'quantity',3);
  v_note:=crm.operations_text(p_payload,'note',2000); v_reference:=crm.operations_text(p_payload,'reference',200);
  select crm.stock_item_json(i) into v_before from crm.stock_items i where id=v_item_id;
  v_move:=crm.location_movement(v_actor,v_item_id,v_site_id,v_type,v_quantity,v_note,v_reference);
  v_entity:='stock_movement'; v_entity_id:=v_move.id; v_after:=crm.stock_movement_json(v_move); v_reason:=v_note; v_message:='Stock movement recorded.';
 when 'stock_transfer' then
  perform crm.operations_keys(p_payload,array['itemId','fromSiteId','toSiteId','quantity','note','reference'],array['itemId','fromSiteId','toSiteId','quantity']);
  v_transfer:=crm.transfer_stock(v_actor,crm.operations_uuid(p_payload,'itemId'),crm.operations_uuid(p_payload,'fromSiteId'),crm.operations_uuid(p_payload,'toSiteId'),crm.operations_decimal(p_payload,'quantity',3),crm.operations_text(p_payload,'note',2000),crm.operations_text(p_payload,'reference',200));
  v_entity:='stock_transfer'; v_entity_id:=v_transfer.id; v_after:=crm.transfer_json(v_transfer); v_message:='Stock transferred between locations.';
 when 'stock_return' then
  perform crm.operations_keys(p_payload,array['movementId','quantity','siteId','reason'],array['movementId','quantity','reason']); v_id:=crm.operations_uuid(p_payload,'movementId'); v_quantity:=crm.operations_decimal(p_payload,'quantity',3); v_reason:=crm.operations_text(p_payload,'reason',2000,true);
  select * into v_move from crm.stock_movements where id=v_id and type='OUT';
  if not found then raise exception using errcode='PT404',message='Choose an original stock-out movement.'; end if;
  select coalesce(sum(quantity_milli),0) into v_total from crm.stock_returns where movement_id=v_id;
  if v_quantity<=0 or v_total+v_quantity>v_move.quantity_milli then raise exception using errcode='PT409',message='The return exceeds the unreturned quantity of this stock-out movement.'; end if;
  v_site_id:=coalesce(crm.extension_optional_uuid(p_payload,'siteId'),v_move.site_id,crm.main_store_id()); v_adjustment_id:=gen_random_uuid();
  insert into crm.stock_returns(movement_id,adjustment_id,item_id,site_id,quantity_milli,reason,actor_id,actor_name,created_at)
   values(v_id,v_adjustment_id,v_move.item_id,v_site_id,v_quantity,v_reason,p_actor_id,v_actor.name,v_now) returning * into v_return;
  perform crm.location_movement(v_actor,v_move.item_id,v_site_id,'ADJUST',v_quantity,v_reason,'','RETURN',v_adjustment_id);
  v_entity:='stock_return'; v_entity_id:=v_return.id; v_after:=crm.return_json(v_return); v_message:='Unused material returned to stock.';
 when 'material_request_create' then
  perform crm.operations_keys(p_payload,array['siteId','itemId','quantity','neededOn','note'],array['siteId','itemId','quantity']); v_site_id:=crm.operations_uuid(p_payload,'siteId'); v_item_id:=crm.operations_uuid(p_payload,'itemId'); v_quantity:=crm.operations_decimal(p_payload,'quantity',3);
  perform crm.extension_site(v_site_id,true);
  if v_actor.role<>'OWNER' and not exists(select 1 from crm.site_assignments where user_id=p_actor_id and site_id=v_site_id) then raise exception using errcode='PT403',message='Request material for your assigned site.'; end if;
  if v_quantity<=0 or not exists(select 1 from crm.stock_items where id=v_item_id and active) then raise exception using errcode='PT400',message='Choose an active material and a positive quantity.'; end if;
  insert into crm.material_requests(user_id,site_id,item_id,quantity_milli,needed_on,note) values(p_actor_id,v_site_id,v_item_id,v_quantity,crm.extension_optional_date(p_payload,'neededOn'),crm.operations_text(p_payload,'note',2000)) returning * into v_request;
  v_entity:='material_request'; v_entity_id:=v_request.id; v_after:=crm.material_request_json(v_request); v_message:='Material request submitted.';
 when 'material_request_cancel','material_request_review','material_request_fulfill' then
  if p_action='material_request_cancel' then perform crm.operations_keys(p_payload,array['id','reason'],array['id','reason']);
  elsif p_action='material_request_review' then perform crm.operations_keys(p_payload,array['id','status','note'],array['id','status']);
  else perform crm.operations_keys(p_payload,array['id','fromSiteId','quantity','reference'],array['id','fromSiteId','quantity']); end if;
  v_id:=crm.operations_uuid(p_payload,'id'); select * into v_request from crm.material_requests where id=v_id;
  if not found then raise exception using errcode='PT404',message='Material request not found.'; end if;
  v_before:=crm.material_request_json(v_request);
  if p_action='material_request_cancel' then
   v_reason:=crm.operations_text(p_payload,'reason',2000,true);
   if v_request.status not in ('SUBMITTED','APPROVED') or (v_actor.role<>'OWNER' and (v_request.user_id<>p_actor_id or v_request.status<>'SUBMITTED')) then raise exception using errcode='PT409',message='This material request cannot be cancelled by your account.'; end if;
   if v_request.user_id<>p_actor_id or v_request.status<>'SUBMITTED' then v_required_role:='OWNER'; end if;
   update crm.material_requests set status='CANCELLED',review_note=v_reason,reviewed_by=p_actor_id,reviewed_at=v_now,updated_at=v_now where id=v_id returning * into v_request;
   v_message:='Material request cancelled.';
  elsif p_action='material_request_review' then
   v_status:=crm.operations_text(p_payload,'status',8,true); v_note:=crm.operations_text(p_payload,'note',2000);
   if v_status not in ('APPROVED','REJECTED') or (v_status='REJECTED' and v_note='') then raise exception using errcode='PT400',message='Choose a review status and include a rejection reason.'; end if;
   if v_request.status<>'SUBMITTED' then raise exception using errcode='PT409',message='Only submitted requests can be reviewed.'; end if;
   update crm.material_requests set status=v_status,review_note=v_note,reviewed_by=p_actor_id,reviewed_at=v_now,updated_at=v_now where id=v_id returning * into v_request;
   v_reason:=v_note; v_message:='Material request reviewed.';
  else
   v_quantity:=crm.operations_decimal(p_payload,'quantity',3);
   if v_request.status<>'APPROVED' or v_quantity<=0 or v_request.fulfilled_milli+v_quantity>v_request.quantity_milli then raise exception using errcode='PT409',message='The delivery exceeds the outstanding approved quantity.'; end if;
   perform crm.transfer_stock(v_actor,v_request.item_id,crm.operations_uuid(p_payload,'fromSiteId'),v_request.site_id,v_quantity,'Material request delivery',crm.operations_text(p_payload,'reference',200),v_id);
   update crm.material_requests set fulfilled_milli=fulfilled_milli+v_quantity,status=case when fulfilled_milli+v_quantity=quantity_milli then 'FULFILLED' else 'APPROVED' end,updated_at=v_now where id=v_id returning * into v_request;
   v_message:='Material request delivery recorded.';
  end if;
  v_entity:='material_request'; v_entity_id:=v_id; v_after:=crm.material_request_json(v_request);
 when 'purchase_order_create' then
  perform crm.operations_keys(p_payload,array['supplier','siteId','expectedOn','reference','notes','lines'],array['supplier','siteId','lines']);
  v_name:=crm.operations_text(p_payload,'supplier',200,true); v_site_id:=crm.operations_uuid(p_payload,'siteId'); perform crm.extension_site(v_site_id);
  if jsonb_typeof(p_payload->'lines') is distinct from 'array' then raise exception using errcode='PT400',message='Purchase order lines are required.'; end if;
  if jsonb_array_length(p_payload->'lines') not between 1 and 25 then raise exception using errcode='PT400',message='Use between 1 and 25 purchase order lines.'; end if;
  update crm.operations_state set purchase_sequence=purchase_sequence+1 where id=1 returning purchase_sequence into v_sequence;
  insert into crm.purchase_orders(number,supplier,site_id,expected_on,reference,notes) values('SC/PO/'||lpad(v_sequence::text,greatest(6,length(v_sequence::text)),'0'),v_name,v_site_id,crm.extension_optional_date(p_payload,'expectedOn'),crm.operations_text(p_payload,'reference',200),crm.operations_text(p_payload,'notes',2000)) returning * into v_order;
  for v_row in select value from jsonb_array_elements(p_payload->'lines') loop
   perform crm.operations_keys(v_row,array['itemId','quantity'],array['itemId','quantity']); v_item_id:=crm.operations_uuid(v_row,'itemId'); v_quantity:=crm.operations_decimal(v_row,'quantity',3);
   if v_item_id=any(v_seen) or v_quantity<=0 or not exists(select 1 from crm.stock_items where id=v_item_id and active) then raise exception using errcode='PT400',message='Use distinct active materials and positive quantities.'; end if;
   v_seen:=array_append(v_seen,v_item_id); insert into crm.purchase_order_lines(order_id,item_id,quantity_milli) values(v_order.id,v_item_id,v_quantity);
  end loop;
  v_entity:='purchase_order'; v_entity_id:=v_order.id; v_after:=crm.purchase_order_json(v_order); v_message:='Purchase order created.';
 when 'purchase_order_receive','purchase_order_cancel' then
  if p_action='purchase_order_cancel' then perform crm.operations_keys(p_payload,array['id','reason'],array['id','reason']);
  else perform crm.operations_keys(p_payload,array['id','lines','reference'],array['id','lines']); end if;
  v_id:=crm.operations_uuid(p_payload,'id'); select * into v_order from crm.purchase_orders where id=v_id;
  if not found then raise exception using errcode='PT404',message='Purchase order not found.'; end if;
  if v_order.status not in ('OPEN','PART_RECEIVED') then raise exception using errcode='PT409',message='This purchase order is already closed.'; end if;
  v_before:=crm.purchase_order_json(v_order);
  if p_action='purchase_order_cancel' then
   v_reason:=crm.operations_text(p_payload,'reason',2000,true); update crm.purchase_orders set status='CANCELLED',cancel_reason=v_reason,updated_at=v_now where id=v_id returning * into v_order; v_message:='Outstanding purchase quantity cancelled.';
  else
   if jsonb_typeof(p_payload->'lines') is distinct from 'array' then raise exception using errcode='PT400',message='Choose the delivered lines.'; end if;
   if jsonb_array_length(p_payload->'lines') not between 1 and 25 then raise exception using errcode='PT400',message='Use between 1 and 25 receipt lines.'; end if;
   v_reference:=crm.operations_text(p_payload,'reference',200);
   for v_row in select value from jsonb_array_elements(p_payload->'lines') loop
    perform crm.operations_keys(v_row,array['lineId','quantity'],array['lineId','quantity']); v_item_id:=crm.operations_uuid(v_row,'lineId'); v_quantity:=crm.operations_decimal(v_row,'quantity',3);
    if v_item_id=any(v_seen) then raise exception using errcode='PT400',message='A purchase line can appear only once.'; end if;
    v_seen:=array_append(v_seen,v_item_id); select * into v_line from crm.purchase_order_lines where id=v_item_id and order_id=v_id;
    if not found or v_quantity<=0 or v_line.received_milli+v_quantity>v_line.quantity_milli then raise exception using errcode='PT409',message='The delivery exceeds the outstanding purchase quantity.'; end if;
    perform crm.location_movement(v_actor,v_line.item_id,v_order.site_id,'IN',v_quantity,'Received purchase order '||v_order.number,v_reference);
    update crm.purchase_order_lines set received_milli=received_milli+v_quantity where id=v_line.id;
   end loop;
   update crm.purchase_orders set status=case when exists(select 1 from crm.purchase_order_lines where order_id=v_id and received_milli<quantity_milli) then 'PART_RECEIVED' else 'RECEIVED' end,updated_at=v_now where id=v_id returning * into v_order;
   v_message:='Purchase delivery received into stock.';
  end if;
  v_entity:='purchase_order'; v_entity_id:=v_id; v_after:=crm.purchase_order_json(v_order);
 when 'payment_installment_add' then
  perform crm.operations_keys(p_payload,array['workOrderId','title','dueDate','amount'],array['workOrderId','title','dueDate','amount']); v_work_order:=crm.operations_text(p_payload,'workOrderId',120,true); v_contract:=crm.contract_amount(v_work_order,true);
  v_amount:=crm.operations_decimal(p_payload,'amount',2); v_name:=crm.operations_text(p_payload,'title',200,true); v_date:=crm.operations_date(crm.operations_text(p_payload,'dueDate',10,true));
  select coalesce(sum(amount_paise),0) into v_total from crm.payment_installments where work_order_id=v_work_order and cancelled_at is null;
  if v_amount<=0 or v_total+v_amount>v_contract then raise exception using errcode='PT409',message='The active payment schedule would exceed the agreed work order amount.'; end if;
  insert into crm.payment_installments(work_order_id,title,due_date,amount_paise) values(v_work_order,v_name,v_date,v_amount) returning * into v_installment;
  v_entity:='payment_installment'; v_entity_id:=v_installment.id; v_after:=crm.installment_json(v_installment); v_message:='Payment installment added.';
 when 'payment_installment_cancel' then
  perform crm.operations_keys(p_payload,array['id','reason'],array['id','reason']); v_id:=crm.operations_uuid(p_payload,'id'); v_reason:=crm.operations_text(p_payload,'reason',2000,true);
  select * into v_installment from crm.payment_installments where id=v_id;
  if not found then raise exception using errcode='PT404',message='Payment installment not found.'; end if;
  if v_installment.cancelled_at is not null then raise exception using errcode='PT409',message='This installment is already cancelled.'; end if;
  v_before:=crm.installment_json(v_installment); update crm.payment_installments set cancelled_at=v_now,cancel_reason=v_reason where id=v_id returning * into v_installment;
  v_entity:='payment_installment'; v_entity_id:=v_id; v_after:=crm.installment_json(v_installment); v_message:='Payment installment cancelled.';
 when 'payment_record' then
  perform crm.operations_keys(p_payload,array['workOrderId','paymentDate','amount','method','reference','notes'],array['workOrderId','paymentDate','amount','method']);
  v_work_order:=crm.operations_text(p_payload,'workOrderId',120,true); v_contract:=crm.contract_amount(v_work_order,true); v_date:=crm.operations_date(crm.operations_text(p_payload,'paymentDate',10,true));
  v_amount:=crm.operations_decimal(p_payload,'amount',2); v_type:=crm.operations_text(p_payload,'method',6,true);
  if v_date>v_today or v_amount<=0 or v_type not in ('CASH','BANK','UPI','CHEQUE','OTHER') then raise exception using errcode='PT400',message='Check the payment date, amount and method.'; end if;
  if crm.payment_net(v_work_order)+v_amount>v_contract then raise exception using errcode='PT409',message='The recorded payment would exceed the agreed work order amount.'; end if;
  insert into crm.customer_payments(work_order_id,payment_date,amount_paise,method,reference,notes,actor_id)
   values(v_work_order,v_date,v_amount,v_type,crm.operations_text(p_payload,'reference',200),crm.operations_text(p_payload,'notes',2000),p_actor_id) returning * into v_payment;
  v_entity:='customer_payment'; v_entity_id:=v_payment.id; v_after:=crm.customer_payment_json(v_payment); v_message:='Customer payment recorded.';
 when 'payment_void' then
  perform crm.operations_keys(p_payload,array['id','reason'],array['id','reason']); v_id:=crm.operations_uuid(p_payload,'id'); v_reason:=crm.operations_text(p_payload,'reason',2000,true);
  select * into v_payment from crm.customer_payments where id=v_id;
  if not found then raise exception using errcode='PT404',message='Customer payment not found.'; end if;
  if exists(select 1 from crm.customer_payment_voids where payment_id=v_id) then raise exception using errcode='PT409',message='This customer payment is already voided.'; end if;
  v_before:=crm.customer_payment_json(v_payment); insert into crm.customer_payment_voids(payment_id,reason,actor_id) values(v_id,v_reason,p_actor_id);
  v_entity:='customer_payment'; v_entity_id:=v_id; v_after:=crm.customer_payment_json(v_payment); v_message:='Customer payment voided; the original record is retained.';
 end case;
 perform crm.extension_audit(v_actor,p_action,v_entity,v_entity_id,v_before,v_after,v_reason);
 update crm.operations_state set revision=revision+1 where id=1 returning revision into v_revision;
 insert into crm.operations_receipts(request_id,actor_id,action,payload_hash,payload,revision,message,required_role)
  values(p_request_id,p_actor_id,p_action,p_payload_hash,p_payload,v_revision,v_message,v_required_role);
 return jsonb_build_object('data',public.crm_operations_v2_read(p_actor_id,p_month),'message',v_message);
end;
$$;

create or replace function public.crm_team_activity_read(
  p_actor_id uuid,p_month text,p_employee_id uuid default null,p_module text default 'all',p_page integer default 1
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_member crm.members; v_start date; v_start_time timestamptz; v_end_time timestamptz;
  v_result jsonb;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'The workspace is not initialized.'; end if;
  perform 1 from crm.operations_state where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'Operations are not initialized.'; end if;
  v_member := crm.active_member(p_actor_id);
  if v_member.role <> 'OWNER' then raise exception using errcode = 'PT403', message = 'Only the Owner can view team activity.'; end if;
  -- Authorization precedes querying or counting either audit source.
  v_start := crm.operations_month(p_month);
  if p_module is null or p_module not in ('all','leads','followups','quotations','workorders','customers','team','settings','stock','attendance','expenses','payments') then
    raise exception using errcode = 'PT400', message = 'Choose a valid activity module.';
  end if;
  if p_page is null or p_page < 1 or p_page > 10000 then raise exception using errcode = 'PT400', message = 'Choose a page between 1 and 10000.'; end if;
  v_start_time := v_start::timestamp at time zone 'Asia/Kolkata';
  v_end_time := (v_start + interval '1 month')::timestamp at time zone 'Asia/Kolkata';

  with combined as (
    select a.id,a.actor_id,coalesce(nullif(a.payload->>'actor',''),m.name,'Unknown team member') as actor_name,
      coalesce(a.payload->>'action','record.updated') as action,
      crm.team_activity_module(a.payload->>'entityType',a.payload->>'action') as module,
      coalesce(a.payload->>'entityType','workspace') as entity_type,coalesce(a.payload->>'entityId','') as entity_id,
      coalesce(nullif(a.payload->>'description',''),'Updated a CRM record.') as description,
      a.created_at,'CRM'::text as source,null::jsonb as before_data,null::jsonb as after_data,''::text as reason
    from crm.audit_events a left join crm.members m on m.user_id = a.actor_id
    where a.created_at >= v_start_time and a.created_at < v_end_time
      and (p_employee_id is null or a.actor_id = p_employee_id)
    union all
    select a.id::text,a.actor_id,a.actor_name,a.action,crm.team_activity_module(a.entity_type,a.action),
      a.entity_type,a.entity_id::text,crm.operations_activity_description(a),a.created_at,'OPERATIONS'::text,
      a.before_data,a.after_data,a.reason
    from crm.operations_audit a
    where a.created_at >= v_start_time and a.created_at < v_end_time
      and (p_employee_id is null or a.actor_id = p_employee_id)
  ), filtered as materialized (
    select * from combined where p_module = 'all' or module = p_module
  )
  select jsonb_build_object('month',p_month,'employeeId',p_employee_id,'module',p_module,'page',p_page,
    'pageSize',100,'total',(select count(*) from filtered),'serverTime',clock_timestamp(),
    'entries',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'actorId',a.actor_id,'actorName',a.actor_name,
      'action',a.action,'module',a.module,'entityType',a.entity_type,'entityId',a.entity_id,'description',a.description,
      'createdAt',a.created_at,'source',a.source,'before',a.before_data,'after',a.after_data,'reason',a.reason)
      order by a.created_at desc,a.source,a.id),'[]'::jsonb)
      from (select * from filtered order by created_at desc,source,id limit 100 offset (p_page - 1) * 100) a)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function crm.team_activity_module(p_entity_type text,p_action text) returns text language sql immutable set search_path='' as $$
 select case
  when p_entity_type in ('customer_payment','payment_installment') or p_action like 'payment\_%' escape '\' then 'payments'
  when p_entity_type in ('construction_site','site_assignment','shift_rule','attendance') then 'attendance'
  when p_entity_type in ('stock_item','stock_movement','stock_transfer','stock_return','material_request','purchase_order') then 'stock'
  when p_entity_type in ('expense','expense_receipt') then 'expenses'
  when p_entity_type='lead' then 'leads' when p_entity_type='followup' then 'followups'
  when p_entity_type in ('quotation','quote') then 'quotations' when p_entity_type in ('workorder','milestone') then 'workorders'
  when p_entity_type='customer' then 'customers' when p_entity_type='member' then 'team'
  when p_entity_type in ('company','workspace') then 'settings'
  when p_action like 'stock\_%' escape '\' then 'stock' when p_action like 'attendance\_%' escape '\' then 'attendance'
  when p_action like 'expense\_%' escape '\' then 'expenses' when p_action like 'lead\_%' escape '\' then 'leads'
  when p_action like 'followup\_%' escape '\' then 'followups' when p_action like 'quote\_%' escape '\' then 'quotations'
  when p_action like 'workorder\_%' escape '\' or p_action like 'milestone\_%' escape '\' then 'workorders'
  when p_action like 'customer\_%' escape '\' then 'customers'
  when p_action like 'member\_%' escape '\' or p_action like 'member.%' then 'team' else 'settings' end;
$$;
create or replace function crm.operations_activity_description(p_row crm.operations_audit) returns text language sql immutable set search_path='' as $$
 select case
  when p_row.action='stock_item_save' then case when p_row.before_data is null then 'Added stock item ' else 'Updated stock item ' end||coalesce(p_row.after_data->>'name','')
  when p_row.action='stock_item_active' then case when p_row.after_data->>'active'='true' then 'Restored stock item ' else 'Archived stock item ' end||coalesce(p_row.after_data->>'name','')
  when p_row.action in ('stock_move','stock_location_move') then case p_row.after_data->>'type' when 'IN' then 'Received stock: ' when 'OUT' then 'Used stock: ' else 'Adjusted stock balance: ' end||coalesce(p_row.before_data->>'name','Stock item')
  when p_row.action='stock_transfer' then 'Transferred material between stock locations'
  when p_row.action='stock_return' then 'Returned unused material to stock'
  when p_row.action='attendance_check_in' then 'Checked in for '||coalesce(p_row.after_data->>'memberName','team member')||' on '||coalesce(p_row.after_data->>'workDate','')
  when p_row.action='attendance_check_out' then 'Checked out for '||coalesce(p_row.after_data->>'memberName','team member')||' on '||coalesce(p_row.after_data->>'workDate','')
  when p_row.action='attendance_correct' then 'Corrected attendance for '||coalesce(p_row.after_data->>'memberName','team member')||' on '||coalesce(p_row.after_data->>'workDate','')
  when p_row.action='attendance_overtime_approve' then 'Reviewed overtime for '||coalesce(p_row.after_data->>'memberName','team member')||' on '||coalesce(p_row.after_data->>'workDate','')
  when p_row.action='site_save' then 'Saved construction site '||coalesce(p_row.after_data->>'name','')
  when p_row.action='site_active' then case when p_row.after_data->>'active'='true' then 'Restored site ' else 'Archived site ' end||coalesce(p_row.after_data->>'name','')
  when p_row.action='site_assign' then 'Updated a team member construction site assignment'
  when p_row.action='shift_rule_save' then 'Updated shift rules for new attendance'
  when p_row.action='material_request_create' then 'Submitted a material request'
  when p_row.action='material_request_review' then 'Reviewed a material request'
  when p_row.action='material_request_fulfill' then 'Delivered material for an approved request'
  when p_row.action='material_request_cancel' then 'Cancelled an outstanding material request'
  when p_row.action='purchase_order_create' then 'Created purchase order '||coalesce(p_row.after_data->>'number','')
  when p_row.action='purchase_order_receive' then 'Received a delivery for purchase order '||coalesce(p_row.after_data->>'number','')
  when p_row.action='purchase_order_cancel' then 'Cancelled remaining purchase quantity for '||coalesce(p_row.after_data->>'number','')
  when p_row.action='payment_installment_add' then 'Added payment installment '||coalesce(p_row.after_data->>'title','')
  when p_row.action='payment_installment_cancel' then 'Cancelled payment installment '||coalesce(p_row.after_data->>'title','')
  when p_row.action='payment_record' then 'Recorded a customer payment'
  when p_row.action='payment_void' then 'Voided a customer payment with a retained record'
  when p_row.action='expense_save' then case when p_row.before_data is null then 'Submitted expense: ' when p_row.before_data->>'status'='REJECTED' then 'Resubmitted expense: ' else 'Updated expense: ' end||coalesce(p_row.after_data->>'title','')
  when p_row.action='expense_withdraw' then 'Withdrew expense: '||coalesce(p_row.after_data->>'title','')
  when p_row.action='expense_review' then case p_row.after_data->>'status' when 'APPROVED' then 'Approved expense: ' when 'REJECTED' then 'Rejected expense: ' else 'Marked expense as paid: ' end||coalesce(p_row.after_data->>'title','')
  when p_row.action='expense_receipt_add' then 'Attached expense receipt '||coalesce(p_row.after_data->>'fileName','')
  when p_row.action='expense_receipt_remove' then 'Removed expense receipt '||coalesce(p_row.after_data->>'fileName','')
  else 'Updated a workspace record.' end;
$$;
create function crm.stock_unit_history_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if new.unit<>old.unit and (exists(select 1 from crm.stock_movements where item_id=old.id) or exists(select 1 from crm.stock_transfers where item_id=old.id)
  or exists(select 1 from crm.material_requests where item_id=old.id) or exists(select 1 from crm.purchase_order_lines where item_id=old.id)) then
  raise exception using errcode='PT409',message='The unit cannot change after stock, material requests or purchase orders have been recorded.';
 end if; return new;
end;
$$;
create trigger stock_unit_history_guard before update on crm.stock_items for each row execute function crm.stock_unit_history_guard();
create function crm.expense_receipt_identity_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' then raise exception using errcode='PT403',message='Receipt metadata is retained after removal.'; end if;
 if (to_jsonb(new)-array['state','completed_at','removed_at']) is distinct from (to_jsonb(old)-array['state','completed_at','removed_at'])
  or old.state='REMOVED' or (old.state='READY' and new.state<>'REMOVED') then raise exception using errcode='PT403',message='Receipt identity and uploaded content cannot be changed.'; end if;
 return new;
end;
$$;
create trigger expense_receipt_identity_guard before update or delete on crm.expense_receipts for each row execute function crm.expense_receipt_identity_guard();

revoke all on all functions in schema crm from public,anon,authenticated,service_role;
revoke all on function public.crm_operations_v2_read(uuid,text) from public,anon,authenticated;
revoke all on function public.crm_operations_v2_export(uuid) from public,anon,authenticated;
revoke all on function public.crm_operations_v2_mutate(uuid,bigint,text,text,text,jsonb,text) from public,anon,authenticated;
revoke all on function public.crm_expense_receipt_reserve(uuid,uuid,text,text,text,bigint,text) from public,anon,authenticated;
revoke all on function public.crm_expense_receipt_complete(uuid,uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.crm_expense_receipt_access(uuid,uuid) from public,anon,authenticated;
revoke all on function public.crm_expense_receipt_remove(uuid,uuid) from public,anon,authenticated;
revoke all on function public.crm_team_activity_read(uuid,text,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.crm_operations_v2_read(uuid,text),public.crm_operations_v2_export(uuid),public.crm_operations_v2_mutate(uuid,bigint,text,text,text,jsonb,text),
 public.crm_expense_receipt_reserve(uuid,uuid,text,text,text,bigint,text),public.crm_expense_receipt_complete(uuid,uuid,text,bigint,text),
 public.crm_expense_receipt_access(uuid,uuid),public.crm_expense_receipt_remove(uuid,uuid),public.crm_team_activity_read(uuid,text,uuid,text,integer) to service_role;
notify pgrst,'reload schema';
commit;
