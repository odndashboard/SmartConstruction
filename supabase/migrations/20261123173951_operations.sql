-- Stock, attendance and expenses share the existing trusted-server boundary.
-- New operations tables do not change the legacy workspace revision or put
-- private employee data in its audit feed. The existing workspace read RPC is
-- tightened below so employee activity is visible only to the Owner.
begin;

create table crm.operations_state (
  id smallint primary key check (id = 1),
  revision bigint not null default 0 check (revision between 0 and 9007199254740991)
);
insert into crm.operations_state(id) values (1);

create table crm.stock_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null check (length(sku) between 1 and 64),
  name text not null check (length(name) between 1 and 200),
  unit text not null check (length(unit) between 1 and 24),
  location text not null default '' check (length(location) <= 200),
  quantity_milli bigint not null default 0 check (quantity_milli between 0 and 9000000000000),
  min_quantity_milli bigint not null default 0 check (min_quantity_milli between 0 and 9000000000000),
  active boolean not null default true,
  created_by uuid not null references crm.members(user_id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (active or quantity_milli = 0)
);
create unique index stock_items_sku_unique on crm.stock_items(lower(sku));
create index stock_items_created_idx on crm.stock_items(created_at desc, id desc);

create table crm.stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references crm.stock_items(id) on delete restrict,
  type text not null check (type in ('IN','OUT','ADJUST')),
  quantity_milli bigint not null check (quantity_milli between 0 and 9000000000000),
  delta_milli bigint not null check (delta_milli between -9000000000000 and 9000000000000),
  balance_after_milli bigint not null check (balance_after_milli between 0 and 9000000000000),
  note text not null default '' check (length(note) <= 2000),
  reference text not null default '' check (length(reference) <= 200),
  actor_id uuid not null references crm.members(user_id) on delete restrict,
  actor_name text not null check (length(actor_name) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  check ((type = 'IN' and quantity_milli > 0 and delta_milli = quantity_milli)
      or (type = 'OUT' and quantity_milli > 0 and delta_milli = -quantity_milli)
      or (type = 'ADJUST' and quantity_milli = balance_after_milli and length(btrim(note)) > 0))
);
create index stock_movements_created_idx on crm.stock_movements(created_at desc, id desc);
create index stock_movements_item_idx on crm.stock_movements(item_id, created_at desc, id desc);

create table crm.attendance (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm.members(user_id) on delete restrict,
  work_date date not null,
  status text not null check (status in ('PRESENT','HALF_DAY','ABSENT','LEAVE')),
  check_in timestamptz,
  check_out timestamptz,
  site text not null default '' check (length(site) <= 200),
  notes text not null default '' check (length(notes) <= 2000),
  source text not null check (source in ('SELF','ADMIN')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (user_id, work_date),
  check (check_out is null or (check_in is not null and check_out > check_in)),
  check (check_in is null or (check_in at time zone 'Asia/Kolkata')::date = work_date),
  check (status not in ('ABSENT','LEAVE') or (check_in is null and check_out is null))
);
create unique index attendance_one_open_shift on crm.attendance(user_id)
  where check_in is not null and check_out is null;
create index attendance_date_idx on crm.attendance(work_date desc, id desc);

create table crm.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references crm.members(user_id) on delete restrict,
  expense_date date not null,
  title text not null check (length(title) between 1 and 200),
  category text not null check (category in ('Materials','Travel','Labour','Equipment','Food','Other')),
  amount_paise bigint not null check (amount_paise between 1 and 9000000000000),
  site text not null default '' check (length(site) <= 200),
  reference text not null default '' check (length(reference) <= 200),
  notes text not null default '' check (length(notes) <= 2000),
  status text not null default 'SUBMITTED' check (status in ('SUBMITTED','APPROVED','REJECTED','PAID','WITHDRAWN')),
  review_note text not null default '' check (length(review_note) <= 2000),
  reviewed_by uuid references crm.members(user_id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((reviewed_by is null) = (reviewed_at is null)),
  check (status not in ('APPROVED','REJECTED','PAID') or reviewed_by is not null),
  check (status <> 'REJECTED' or length(btrim(review_note)) > 0),
  check (status <> 'SUBMITTED' or (reviewed_by is null and reviewed_at is null and review_note = ''))
);
create index expenses_date_idx on crm.expenses(expense_date desc, created_at desc, id desc);
create index expenses_user_date_idx on crm.expenses(user_id, expense_date desc, created_at desc, id desc);
create index expenses_status_idx on crm.expenses(status, expense_date);

-- Full snapshots preserve correction and review history. Only Owner export can
-- read this table; the existing shared crm.audit_events is deliberately unused.
create table crm.operations_audit (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references crm.members(user_id) on delete restrict,
  actor_name text not null,
  action text not null,
  entity_type text not null check (entity_type in ('stock_item','stock_movement','attendance','expense')),
  entity_id uuid not null,
  before_data jsonb,
  after_data jsonb not null check (jsonb_typeof(after_data) = 'object'),
  reason text not null default '' check (length(reason) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  check (before_data is null or jsonb_typeof(before_data) = 'object')
);
create index operations_audit_created_idx on crm.operations_audit(created_at desc, id desc);
create index operations_audit_actor_created_idx on crm.operations_audit(actor_id, created_at desc, id);
create index audit_events_actor_created_idx on crm.audit_events(actor_id, created_at desc, id);

create table crm.operations_receipts (
  request_id text primary key check (request_id ~ '^[A-Za-z0-9_-]{8,120}$'),
  actor_id uuid not null references crm.members(user_id) on delete restrict,
  action text not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null check (revision between 0 and 9007199254740991),
  message text not null,
  created_at timestamptz not null default clock_timestamp()
);

alter table crm.operations_state enable row level security;
alter table crm.stock_items enable row level security;
alter table crm.stock_movements enable row level security;
alter table crm.attendance enable row level security;
alter table crm.expenses enable row level security;
alter table crm.operations_audit enable row level security;
alter table crm.operations_receipts enable row level security;
revoke all on crm.operations_state, crm.stock_items, crm.stock_movements,
  crm.attendance, crm.expenses, crm.operations_audit, crm.operations_receipts
  from public, anon, authenticated, service_role;

create function crm.operations_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'PT403', message = 'Stock history, audit events and request receipts are immutable.';
end;
$$;
create trigger stock_movements_immutable before update or delete on crm.stock_movements
  for each row execute function crm.operations_immutable();
create trigger operations_audit_immutable before update or delete on crm.operations_audit
  for each row execute function crm.operations_immutable();
create trigger operations_receipts_immutable before update or delete on crm.operations_receipts
  for each row execute function crm.operations_immutable();

-- Validation also lives in PostgreSQL: a trusted server cannot accidentally
-- turn extra JSON fields, a floating point value or a client clock into state.
create function crm.operations_keys(p_value jsonb, p_allowed text[], p_required text[] default '{}') returns void
language plpgsql set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'object'
     or not (p_value ?& p_required)
     or exists (select 1 from jsonb_object_keys(p_value) as k(key) where not (k.key = any(p_allowed))) then
    raise exception using errcode = 'PT400', message = 'The action contains missing or unexpected fields.';
  end if;
end;
$$;
create function crm.operations_text(p_value jsonb, p_key text, p_max integer, p_required boolean default false) returns text
language plpgsql set search_path = '' as $$
declare v_text text;
begin
  if not (p_value ? p_key) then
    if p_required then raise exception using errcode = 'PT400', message = p_key || ' is required.'; end if;
    return '';
  end if;
  if jsonb_typeof(p_value->p_key) is distinct from 'string' then
    raise exception using errcode = 'PT400', message = p_key || ' must be text.';
  end if;
  v_text := regexp_replace(p_value->>p_key, '^[[:space:]]+|[[:space:]]+$', '', 'g');
  if length(v_text) > p_max or (p_required and length(v_text) = 0) then
    raise exception using errcode = 'PT400', message = p_key || ' is empty or too long.';
  end if;
  return v_text;
end;
$$;
create function crm.operations_uuid(p_value jsonb, p_key text, p_required boolean default true) returns uuid
language plpgsql set search_path = '' as $$
declare v_text text;
begin
  if not (p_value ? p_key) and not p_required then return null; end if;
  v_text := crm.operations_text(p_value, p_key, 36, true);
  if v_text !~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
    raise exception using errcode = 'PT400', message = p_key || ' must be a valid record ID.';
  end if;
  return v_text::uuid;
end;
$$;
create function crm.operations_decimal(p_value jsonb, p_key text, p_places integer, p_required boolean default true) returns bigint
language plpgsql set search_path = '' as $$
declare v_text text; v_scaled numeric;
begin
  if not (p_value ? p_key) and not p_required then return 0; end if;
  v_text := crm.operations_text(p_value, p_key, 30, true);
  if p_places not in (2,3) or v_text !~ ('^[0-9]+([.][0-9]{1,' || p_places || '})?$') then
    raise exception using errcode = 'PT400', message = p_key || ' has invalid decimal precision.';
  end if;
  v_scaled := v_text::numeric * case p_places when 2 then 100 else 1000 end;
  if v_scaled < 0 or v_scaled > 9000000000000 then
    raise exception using errcode = 'PT400', message = p_key || ' exceeds the supported limit.';
  end if;
  return v_scaled::bigint;
end;
$$;
create function crm.operations_date(p_value text) returns date
language plpgsql set search_path = '' as $$
declare v_date date;
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or left(p_value,4) = '0000' then
    raise exception using errcode = 'PT400', message = 'Use a valid calendar date in YYYY-MM-DD format.';
  end if;
  begin
    v_date := p_value::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'PT400', message = 'Enter a real calendar date.';
  end;
  if to_char(v_date, 'YYYY-MM-DD') <> p_value then
    raise exception using errcode = 'PT400', message = 'Enter a real calendar date.';
  end if;
  return v_date;
end;
$$;
create function crm.operations_month(p_month text) returns date
language plpgsql set search_path = '' as $$
begin
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or left(p_month,4) = '0000' then
    raise exception using errcode = 'PT400', message = 'Choose a valid month in YYYY-MM format.';
  end if;
  return crm.operations_date(p_month || '-01');
end;
$$;
create function crm.operations_timestamp(p_value jsonb, p_key text) returns timestamptz
language plpgsql set search_path = '' as $$
declare v_text text; v_time timestamptz;
begin
  if not (p_value ? p_key) or p_value->p_key = 'null'::jsonb then return null; end if;
  v_text := crm.operations_text(p_value, p_key, 40, true);
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception using errcode = 'PT400', message = p_key || ' needs a valid ISO date, time and time zone.';
  end if;
  perform crm.operations_date(left(v_text,10));
  begin
    v_time := v_text::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using errcode = 'PT400', message = p_key || ' is not a valid date and time.';
  end;
  return v_time;
end;
$$;

create function crm.stock_item_json(p_row crm.stock_items) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p_row.id,'sku',p_row.sku,'name',p_row.name,'unit',p_row.unit,
    'location',p_row.location,'quantityMilli',p_row.quantity_milli,'minQuantityMilli',p_row.min_quantity_milli,
    'active',p_row.active,'createdBy',p_row.created_by,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,
    'receivedMilli',coalesce(sum(s.quantity_milli) filter (where s.type = 'IN'),0)::text,
    'usedMilli',coalesce(sum(s.quantity_milli) filter (where s.type = 'OUT'),0)::text,
    'adjustedMilli',coalesce(sum(s.delta_milli) filter (where s.type = 'ADJUST'),0)::text)
    from crm.stock_movements s where s.item_id = p_row.id;
$$;
create function crm.stock_movement_json(p_row crm.stock_movements) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id',p_row.id,'itemId',p_row.item_id,'type',p_row.type,
    'quantityMilli',p_row.quantity_milli,'deltaMilli',p_row.delta_milli,'balanceAfterMilli',p_row.balance_after_milli,
    'note',p_row.note,'reference',p_row.reference,'actorId',p_row.actor_id,'actorName',p_row.actor_name,'createdAt',p_row.created_at);
$$;
create function crm.attendance_json(p_row crm.attendance) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p_row.id,'userId',p_row.user_id,'memberName',m.name,'workDate',p_row.work_date,
    'status',p_row.status,'checkIn',p_row.check_in,'checkOut',p_row.check_out,'site',p_row.site,'notes',p_row.notes,
    'source',p_row.source,'updatedAt',p_row.updated_at) from crm.members m where m.user_id = p_row.user_id;
$$;
create function crm.expense_json(p_row crm.expenses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p_row.id,'userId',p_row.user_id,'memberName',m.name,'expenseDate',p_row.expense_date,
    'title',p_row.title,'category',p_row.category,'amountPaise',p_row.amount_paise,'site',p_row.site,
    'reference',p_row.reference,'notes',p_row.notes,'status',p_row.status,'reviewNote',p_row.review_note,
    'reviewedBy',p_row.reviewed_by,'reviewedAt',p_row.reviewed_at,'createdAt',p_row.created_at,'updatedAt',p_row.updated_at)
    from crm.members m where m.user_id = p_row.user_id;
$$;
create function crm.operations_expense_totals(p_start date default null, p_end date default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('count',count(*),
    'submittedPaise',coalesce(sum(amount_paise) filter (where status = 'SUBMITTED'),0)::text,
    'approvedPaise',coalesce(sum(amount_paise) filter (where status = 'APPROVED'),0)::text,
    'paidPaise',coalesce(sum(amount_paise) filter (where status = 'PAID'),0)::text,
    'rejectedPaise',coalesce(sum(amount_paise) filter (where status = 'REJECTED'),0)::text,
    'withdrawnPaise',coalesce(sum(amount_paise) filter (where status = 'WITHDRAWN'),0)::text)
    from crm.expenses where (p_start is null or expense_date >= p_start) and (p_end is null or expense_date < p_end);
$$;

-- Called only after locks and active-member validation by the three RPCs.
create function crm.operations_snapshot(p_member crm.members, p_month text, p_revision bigint, p_now timestamptz) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_start date := crm.operations_month(p_month);
  v_end date := (v_start + interval '1 month')::date;
  v_start_time timestamptz := v_start::timestamp at time zone 'Asia/Kolkata';
  v_end_time timestamptz := v_end::timestamp at time zone 'Asia/Kolkata';
  v_owner boolean := p_member.role = 'OWNER';
  v_today date := (p_now at time zone 'Asia/Kolkata')::date;
  v_items jsonb; v_movements jsonb; v_attendance jsonb; v_expenses jsonb;
  v_today_record jsonb; v_open_record jsonb; v_summary jsonb;
  v_movement_count bigint; v_attendance_count bigint; v_expense_count bigint;
begin
  select coalesce(jsonb_agg(crm.stock_item_json(i) order by i.created_at desc, i.id desc),'[]'::jsonb)
    into v_items from crm.stock_items i;
  select count(*) into v_movement_count from crm.stock_movements where created_at >= v_start_time and created_at < v_end_time;
  select coalesce(jsonb_agg(crm.stock_movement_json(s) order by s.created_at desc, s.id desc),'[]'::jsonb) into v_movements
    from (select * from crm.stock_movements where created_at >= v_start_time and created_at < v_end_time order by created_at desc, id desc limit 500) s;
  select count(*) into v_attendance_count from crm.attendance
    where work_date >= v_start and work_date < v_end and (v_owner or user_id = p_member.user_id);
  select coalesce(jsonb_agg(crm.attendance_json(a) order by a.work_date desc, a.id desc),'[]'::jsonb) into v_attendance
    from (select * from crm.attendance where work_date >= v_start and work_date < v_end
      and (v_owner or user_id = p_member.user_id) order by work_date desc, id desc limit 500) a;
  select crm.attendance_json(a) into v_today_record from crm.attendance a where a.user_id = p_member.user_id and a.work_date = v_today;
  select crm.attendance_json(a) into v_open_record from crm.attendance a
    where a.user_id = p_member.user_id and a.check_in is not null and a.check_out is null;
  select count(*) into v_expense_count from crm.expenses
    where expense_date >= v_start and expense_date < v_end and (v_owner or user_id = p_member.user_id);
  select coalesce(jsonb_agg(crm.expense_json(e) order by e.expense_date desc, e.created_at desc, e.id desc),'[]'::jsonb) into v_expenses
    from (select * from crm.expenses where expense_date >= v_start and expense_date < v_end
      and (v_owner or user_id = p_member.user_id) order by expense_date desc, created_at desc, id desc limit 500) e;
  if v_owner then
    v_summary := jsonb_build_object('month',crm.operations_expense_totals(v_start,v_end),'allTime',crm.operations_expense_totals());
  end if;
  return jsonb_build_object('revision',p_revision,'month',p_month,'today',v_today,'serverTime',p_now,
    'user',crm.member_json(p_member),'permissions',jsonb_build_object('admin',v_owner,'canWrite',p_member.role <> 'VIEWER'),
    'stockItems',v_items,'stockMovements',v_movements,'attendance',v_attendance,
    'myTodayAttendance',v_today_record,'myOpenAttendance',v_open_record,'expenses',v_expenses,'expenseSummary',v_summary,
    'counts',jsonb_build_object('stockMovements',v_movement_count,'attendance',v_attendance_count,'expenses',v_expense_count),'historyLimit',500);
end;
$$;

create function public.crm_operations_read(p_actor_id uuid, p_month text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_member crm.members; v_revision bigint;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'The workspace is not initialized.'; end if;
  select revision into v_revision from crm.operations_state where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'Operations are not initialized.'; end if;
  v_member := crm.active_member(p_actor_id);
  return crm.operations_snapshot(v_member,p_month,v_revision,clock_timestamp());
end;
$$;

create function public.crm_operations_export(p_actor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_member crm.members; v_result jsonb; v_audit jsonb; v_owner boolean; v_revision bigint;
begin
  perform crm.require_service();
  perform 1 from crm.workspace where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'The workspace is not initialized.'; end if;
  select revision into v_revision from crm.operations_state where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'Operations are not initialized.'; end if;
  v_member := crm.active_member(p_actor_id);
  v_owner := v_member.role = 'OWNER';
  select jsonb_build_object(
    'revision',v_revision,
    'stockItems',(select coalesce(jsonb_agg(crm.stock_item_json(i) order by i.created_at desc,i.id desc),'[]'::jsonb) from crm.stock_items i),
    'stockMovements',(select coalesce(jsonb_agg(crm.stock_movement_json(s) order by s.created_at desc,s.id desc),'[]'::jsonb) from crm.stock_movements s),
    'attendance',(select coalesce(jsonb_agg(crm.attendance_json(a) order by a.work_date desc,a.id desc),'[]'::jsonb) from crm.attendance a where v_owner or a.user_id = p_actor_id),
    'expenses',(select coalesce(jsonb_agg(crm.expense_json(e) order by e.expense_date desc,e.created_at desc,e.id desc),'[]'::jsonb) from crm.expenses e where v_owner or e.user_id = p_actor_id)
  ) into v_result;
  if v_owner then
    select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'actorId',a.actor_id,'actorName',a.actor_name,
      'action',a.action,'entityType',a.entity_type,'entityId',a.entity_id,'before',a.before_data,'after',a.after_data,
      'reason',a.reason,'createdAt',a.created_at) order by a.created_at desc,a.id desc),'[]'::jsonb) into v_audit from crm.operations_audit a;
    v_result := v_result || jsonb_build_object('audit',v_audit);
  end if;
  return v_result;
end;
$$;

-- Activity is administrator-only through both the new combined page and the
-- older workspace/export endpoint. All other workspace fields are unchanged.
create or replace function public.crm_workspace_read(p_actor_id uuid,p_full_audit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_workspace crm.workspace; v_actor crm.members; v_activity jsonb;
begin
  perform crm.require_service();
  select * into v_workspace from crm.workspace where id=1 for share;
  if not found then raise exception using errcode='PT503',message='The CRM database is not initialized.'; end if;
  v_actor := crm.active_member(p_actor_id);
  if v_actor.role <> 'OWNER' then
    v_activity := '[]'::jsonb;
  elsif p_full_audit then
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

create function crm.team_activity_module(p_entity_type text,p_action text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_entity_type in ('stock_item','stock_movement') then 'stock'
    when p_entity_type = 'attendance' then 'attendance'
    when p_entity_type = 'expense' then 'expenses'
    when p_entity_type = 'lead' then 'leads'
    when p_entity_type = 'followup' then 'followups'
    when p_entity_type in ('quotation','quote') then 'quotations'
    when p_entity_type in ('workorder','milestone') then 'workorders'
    when p_entity_type = 'customer' then 'customers'
    when p_entity_type = 'member' then 'team'
    when p_entity_type in ('company','workspace') then 'settings'
    when p_action like 'stock\_%' escape '\' then 'stock'
    when p_action like 'attendance\_%' escape '\' then 'attendance'
    when p_action like 'expense\_%' escape '\' then 'expenses'
    when p_action like 'lead\_%' escape '\' then 'leads'
    when p_action like 'followup\_%' escape '\' then 'followups'
    when p_action like 'quote\_%' escape '\' then 'quotations'
    when p_action like 'workorder\_%' escape '\' or p_action like 'milestone\_%' escape '\' then 'workorders'
    when p_action like 'customer\_%' escape '\' then 'customers'
    when p_action like 'member\_%' escape '\' or p_action like 'member.%' then 'team'
    else 'settings' end;
$$;

create function crm.operations_activity_description(p_row crm.operations_audit) returns text
language sql immutable set search_path = '' as $$
  select case p_row.action
    when 'stock_item_save' then case when p_row.before_data is null then 'Added stock item ' else 'Updated stock item ' end || coalesce(p_row.after_data->>'name','')
    when 'stock_item_active' then case when p_row.after_data->>'active' = 'true' then 'Restored stock item ' else 'Archived stock item ' end || coalesce(p_row.after_data->>'name','')
    when 'stock_move' then case p_row.after_data->>'type'
      when 'IN' then 'Received stock: ' when 'OUT' then 'Used stock: ' else 'Adjusted stock balance: ' end || coalesce(p_row.before_data->>'name','Stock item')
    when 'attendance_check_in' then 'Checked in for ' || coalesce(p_row.after_data->>'memberName','team member') || ' on ' || coalesce(p_row.after_data->>'workDate','')
    when 'attendance_check_out' then 'Checked out for ' || coalesce(p_row.after_data->>'memberName','team member') || ' on ' || coalesce(p_row.after_data->>'workDate','')
    when 'attendance_correct' then 'Updated attendance for ' || coalesce(p_row.after_data->>'memberName','team member') || ' on ' || coalesce(p_row.after_data->>'workDate','') || ' to ' || lower(replace(coalesce(p_row.after_data->>'status','present'),'_',' '))
    when 'expense_save' then case when p_row.before_data is null then 'Submitted expense: '
      when p_row.before_data->>'status' = 'REJECTED' then 'Resubmitted expense: ' else 'Updated expense: ' end || coalesce(p_row.after_data->>'title','')
    when 'expense_withdraw' then 'Withdrew expense: ' || coalesce(p_row.after_data->>'title','')
    when 'expense_review' then case p_row.after_data->>'status'
      when 'APPROVED' then 'Approved expense: ' when 'REJECTED' then 'Rejected expense: ' else 'Marked expense as paid: ' end || coalesce(p_row.after_data->>'title','')
    else 'Updated a workspace record.' end;
$$;

create function public.crm_team_activity_read(
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
  if p_module is null or p_module not in ('all','leads','followups','quotations','workorders','customers','team','settings','stock','attendance','expenses') then
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

create function public.crm_operations_mutate(
  p_actor_id uuid, p_expected_revision bigint, p_request_id text, p_action text,
  p_payload_hash text, p_payload jsonb, p_month text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_member crm.members; v_receipt crm.operations_receipts; v_revision bigint;
  v_item crm.stock_items; v_movement crm.stock_movements; v_attendance crm.attendance; v_expense crm.expenses;
  v_before jsonb; v_after jsonb; v_entity_type text; v_entity_id uuid; v_reason text := '';
  v_id uuid; v_user_id uuid; v_now timestamptz; v_today date; v_date date;
  v_check_in timestamptz; v_check_out timestamptz; v_status text; v_type text;
  v_sku text; v_name text; v_unit text; v_location text; v_site text; v_notes text; v_note text;
  v_reference text; v_title text; v_category text; v_active boolean;
  v_quantity bigint; v_min bigint; v_opening bigint; v_amount bigint; v_balance bigint; v_delta bigint;
  v_message text;
begin
  perform crm.require_service();
  -- Membership changes take workspace FOR UPDATE. Lock before authorization so
  -- removal or role changes serialize with operations reads, writes and replay.
  perform 1 from crm.workspace where id = 1 for share;
  if not found then raise exception using errcode = 'PT503', message = 'The workspace is not initialized.'; end if;
  select revision into v_revision from crm.operations_state where id = 1 for update;
  if not found then raise exception using errcode = 'PT503', message = 'Operations are not initialized.'; end if;
  v_member := crm.active_member(p_actor_id);
  if p_action is null or p_action not in ('stock_item_save','stock_item_active','stock_move','attendance_check_in','attendance_check_out','attendance_correct','expense_save','expense_withdraw','expense_review') then
    raise exception using errcode = 'PT400', message = 'Unknown operations action.';
  end if;
  if v_member.role = 'VIEWER' then raise exception using errcode = 'PT403', message = 'Your account has read-only access.'; end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'The action payload must be an object.';
  end if;
  -- Use the same normalized movement type for permission checks and execution,
  -- including before receipt replay after an Owner has changed roles.
  if p_action = 'stock_move' then v_type := crm.operations_text(p_payload,'type',6,true); end if;
  if v_member.role <> 'OWNER' and (p_action in ('stock_item_active','attendance_correct','expense_review')
    or (p_action = 'stock_item_save' and p_payload ? 'id')
    or (p_action = 'stock_move' and v_type = 'ADJUST')) then
    raise exception using errcode = 'PT403', message = 'Only the Owner can perform this action.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision > 9007199254740991
     or p_request_id is null or p_request_id !~ '^[A-Za-z0-9_-]{8,120}$'
     or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'PT400', message = 'The request is not valid.';
  end if;
  perform crm.operations_month(p_month);
  select * into v_receipt from crm.operations_receipts where request_id = p_request_id;
  if found then
    if v_receipt.actor_id <> p_actor_id or v_receipt.action <> p_action
       or v_receipt.payload_hash <> p_payload_hash or v_receipt.payload is distinct from p_payload then
      raise exception using errcode = 'PT409', message = 'This request ID belongs to a different action.';
    end if;
    return jsonb_build_object('data',crm.operations_snapshot(v_member,p_month,v_revision,clock_timestamp()),'message',v_receipt.message);
  end if;
  if p_expected_revision <> v_revision then
    raise exception using errcode = 'PT409', message = 'Operations changed. Refresh and try again.';
  end if;
  if v_revision = 9007199254740991 then raise exception using errcode = 'PT409', message = 'The operations revision limit has been reached.'; end if;
  v_now := clock_timestamp();
  v_today := (v_now at time zone 'Asia/Kolkata')::date;

  case p_action
  when 'stock_item_save' then
    perform crm.operations_keys(p_payload,array['id','sku','name','unit','location','minQuantity','openingQuantity'],array['sku','name','unit']);
    v_id := crm.operations_uuid(p_payload,'id',false);
    v_sku := crm.operations_text(p_payload,'sku',64,true);
    v_name := crm.operations_text(p_payload,'name',200,true);
    v_unit := crm.operations_text(p_payload,'unit',24,true);
    v_location := crm.operations_text(p_payload,'location',200);
    v_min := crm.operations_decimal(p_payload,'minQuantity',3,false);
    v_opening := crm.operations_decimal(p_payload,'openingQuantity',3,false);
    if exists (select 1 from crm.stock_items where lower(sku) = lower(v_sku) and (v_id is null or id <> v_id)) then
      raise exception using errcode = 'PT409', message = 'This stock code is already in use.';
    end if;
    if v_id is null then
      insert into crm.stock_items(sku,name,unit,location,quantity_milli,min_quantity_milli,created_by,created_at,updated_at)
        values(v_sku,v_name,v_unit,v_location,v_opening,v_min,p_actor_id,v_now,v_now) returning * into v_item;
      if v_opening > 0 then
        insert into crm.stock_movements(item_id,type,quantity_milli,delta_milli,balance_after_milli,note,actor_id,actor_name,created_at)
          values(v_item.id,'IN',v_opening,v_opening,v_opening,'Opening balance',p_actor_id,v_member.name,v_now);
      end if;
      v_message := 'Stock item created.';
    else
      if v_opening <> 0 then raise exception using errcode = 'PT400', message = 'Use a stock movement to change an existing balance.'; end if;
      select * into v_item from crm.stock_items where id = v_id;
      if not found then raise exception using errcode = 'PT404', message = 'Stock item not found.'; end if;
      if v_item.unit <> v_unit and exists (select 1 from crm.stock_movements where item_id = v_id) then
        raise exception using errcode = 'PT409', message = 'The unit cannot change after stock movements have been recorded.';
      end if;
      v_before := crm.stock_item_json(v_item);
      update crm.stock_items set sku = v_sku,name = v_name,unit = v_unit,location = v_location,
        min_quantity_milli = v_min,updated_at = v_now where id = v_id returning * into v_item;
      v_message := 'Stock item updated.';
    end if;
    v_entity_type := 'stock_item'; v_entity_id := v_item.id; v_after := crm.stock_item_json(v_item);

  when 'stock_item_active' then
    perform crm.operations_keys(p_payload,array['id','active'],array['id','active']);
    v_id := crm.operations_uuid(p_payload,'id');
    if jsonb_typeof(p_payload->'active') is distinct from 'boolean' then raise exception using errcode = 'PT400', message = 'Active must be true or false.'; end if;
    v_active := (p_payload->>'active')::boolean;
    select * into v_item from crm.stock_items where id = v_id;
    if not found then raise exception using errcode = 'PT404', message = 'Stock item not found.'; end if;
    if not v_active and v_item.quantity_milli <> 0 then raise exception using errcode = 'PT409', message = 'Only stock items with a zero balance can be archived.'; end if;
    v_before := crm.stock_item_json(v_item);
    update crm.stock_items set active = v_active,updated_at = v_now where id = v_id returning * into v_item;
    v_entity_type := 'stock_item'; v_entity_id := v_item.id; v_after := crm.stock_item_json(v_item);
    v_message := case when v_active then 'Stock item restored.' else 'Stock item archived.' end;

  when 'stock_move' then
    perform crm.operations_keys(p_payload,array['itemId','type','quantity','note','reference'],array['itemId','type','quantity']);
    v_id := crm.operations_uuid(p_payload,'itemId');
    v_quantity := crm.operations_decimal(p_payload,'quantity',3);
    v_note := crm.operations_text(p_payload,'note',2000);
    v_reference := crm.operations_text(p_payload,'reference',200);
    if v_type not in ('IN','OUT','ADJUST') or (v_type <> 'ADJUST' and v_quantity = 0) then
      raise exception using errcode = 'PT400', message = 'Enter a valid movement and a positive quantity.';
    end if;
    if v_type = 'ADJUST' and v_note = '' then raise exception using errcode = 'PT400', message = 'Explain why the stock balance needs correction.'; end if;
    select * into v_item from crm.stock_items where id = v_id;
    if not found then raise exception using errcode = 'PT404', message = 'Stock item not found.'; end if;
    if not v_item.active then raise exception using errcode = 'PT409', message = 'Restore this stock item before recording a movement.'; end if;
    v_balance := case v_type when 'IN' then v_item.quantity_milli + v_quantity when 'OUT' then v_item.quantity_milli - v_quantity else v_quantity end;
    if v_balance < 0 then raise exception using errcode = 'PT409', message = 'There is not enough stock for this movement.'; end if;
    if v_balance > 9000000000000 then raise exception using errcode = 'PT400', message = 'The resulting stock balance exceeds the supported limit.'; end if;
    v_delta := v_balance - v_item.quantity_milli;
    v_before := crm.stock_item_json(v_item);
    update crm.stock_items set quantity_milli = v_balance,updated_at = v_now where id = v_id;
    insert into crm.stock_movements(item_id,type,quantity_milli,delta_milli,balance_after_milli,note,reference,actor_id,actor_name,created_at)
      values(v_id,v_type,v_quantity,v_delta,v_balance,v_note,v_reference,p_actor_id,v_member.name,v_now) returning * into v_movement;
    v_entity_type := 'stock_movement'; v_entity_id := v_movement.id; v_after := crm.stock_movement_json(v_movement);
    v_reason := v_note; v_message := 'Stock movement recorded.';

  when 'attendance_check_in' then
    perform crm.operations_keys(p_payload,array['site','notes']);
    v_site := crm.operations_text(p_payload,'site',200);
    v_notes := crm.operations_text(p_payload,'notes',2000);
    if exists (select 1 from crm.attendance where user_id = p_actor_id and check_in is not null and check_out is null) then
      raise exception using errcode = 'PT409', message = 'Check out of your open attendance record first.';
    end if;
    if exists (select 1 from crm.attendance where user_id = p_actor_id and work_date = v_today) then
      raise exception using errcode = 'PT409', message = 'Attendance is already recorded for today. Ask the Owner for a correction.';
    end if;
    insert into crm.attendance(user_id,work_date,status,check_in,site,notes,source,created_at,updated_at)
      values(p_actor_id,v_today,'PRESENT',v_now,v_site,v_notes,'SELF',v_now,v_now) returning * into v_attendance;
    v_entity_type := 'attendance'; v_entity_id := v_attendance.id; v_after := crm.attendance_json(v_attendance);
    v_message := 'You are checked in.';

  when 'attendance_check_out' then
    perform crm.operations_keys(p_payload,'{}');
    select * into v_attendance from crm.attendance where user_id = p_actor_id and check_in is not null and check_out is null;
    if not found then raise exception using errcode = 'PT409', message = 'You do not have an open attendance record.'; end if;
    if v_now <= v_attendance.check_in then raise exception using errcode = 'PT409', message = 'Check-out must be after check-in.'; end if;
    v_before := crm.attendance_json(v_attendance);
    update crm.attendance set check_out = v_now,updated_at = v_now where id = v_attendance.id returning * into v_attendance;
    v_entity_type := 'attendance'; v_entity_id := v_attendance.id; v_after := crm.attendance_json(v_attendance);
    v_message := 'You are checked out.';

  when 'attendance_correct' then
    perform crm.operations_keys(p_payload,array['userId','workDate','status','checkIn','checkOut','site','notes','reason'],array['userId','workDate','status','reason']);
    v_user_id := crm.operations_uuid(p_payload,'userId');
    v_date := crm.operations_date(crm.operations_text(p_payload,'workDate',10,true));
    v_status := crm.operations_text(p_payload,'status',8,true);
    v_check_in := crm.operations_timestamp(p_payload,'checkIn');
    v_check_out := crm.operations_timestamp(p_payload,'checkOut');
    v_site := crm.operations_text(p_payload,'site',200);
    v_notes := crm.operations_text(p_payload,'notes',2000);
    v_reason := crm.operations_text(p_payload,'reason',2000,true);
    if not exists (select 1 from crm.members where user_id = v_user_id) then raise exception using errcode = 'PT404', message = 'Team member not found.'; end if;
    if v_status not in ('PRESENT','HALF_DAY','ABSENT','LEAVE') then raise exception using errcode = 'PT400', message = 'Choose a valid attendance status.'; end if;
    if v_date > v_today or v_check_in > v_now or v_check_out > v_now then raise exception using errcode = 'PT400', message = 'Attendance cannot be recorded in the future.'; end if;
    if (v_status in ('ABSENT','LEAVE') and (v_check_in is not null or v_check_out is not null))
      or (v_check_out is not null and (v_check_in is null or v_check_out <= v_check_in))
      or (v_check_in is not null and (v_check_in at time zone 'Asia/Kolkata')::date <> v_date) then
      raise exception using errcode = 'PT400', message = 'Attendance times do not match the date or status.';
    end if;
    if v_check_in is not null and v_check_out is null and exists (
      select 1 from crm.attendance where user_id = v_user_id and work_date <> v_date and check_in is not null and check_out is null
    ) then raise exception using errcode = 'PT409', message = 'This member already has another open attendance record.'; end if;
    select * into v_attendance from crm.attendance where user_id = v_user_id and work_date = v_date;
    if found then v_before := crm.attendance_json(v_attendance); end if;
    insert into crm.attendance(user_id,work_date,status,check_in,check_out,site,notes,source,created_at,updated_at)
      values(v_user_id,v_date,v_status,v_check_in,v_check_out,v_site,v_notes,'ADMIN',v_now,v_now)
      on conflict (user_id,work_date) do update set status = excluded.status,check_in = excluded.check_in,
        check_out = excluded.check_out,site = excluded.site,notes = excluded.notes,source = 'ADMIN',updated_at = excluded.updated_at
      returning * into v_attendance;
    v_entity_type := 'attendance'; v_entity_id := v_attendance.id; v_after := crm.attendance_json(v_attendance);
    v_message := 'Attendance saved with a correction record.';

  when 'expense_save' then
    perform crm.operations_keys(p_payload,array['id','expenseDate','title','category','amount','site','reference','notes'],array['expenseDate','title','category','amount']);
    v_id := crm.operations_uuid(p_payload,'id',false);
    v_date := crm.operations_date(crm.operations_text(p_payload,'expenseDate',10,true));
    v_title := crm.operations_text(p_payload,'title',200,true);
    v_category := crm.operations_text(p_payload,'category',16,true);
    v_amount := crm.operations_decimal(p_payload,'amount',2);
    v_site := crm.operations_text(p_payload,'site',200);
    v_reference := crm.operations_text(p_payload,'reference',200);
    v_notes := crm.operations_text(p_payload,'notes',2000);
    if v_date > v_today then raise exception using errcode = 'PT400', message = 'Expense date cannot be in the future.'; end if;
    if v_amount = 0 or v_category not in ('Materials','Travel','Labour','Equipment','Food','Other') then
      raise exception using errcode = 'PT400', message = 'Choose a valid category and a positive expense amount.';
    end if;
    if v_id is null then
      insert into crm.expenses(user_id,expense_date,title,category,amount_paise,site,reference,notes,created_at,updated_at)
        values(p_actor_id,v_date,v_title,v_category,v_amount,v_site,v_reference,v_notes,v_now,v_now) returning * into v_expense;
    else
      select * into v_expense from crm.expenses where id = v_id and user_id = p_actor_id;
      if not found then raise exception using errcode = 'PT404', message = 'Your expense was not found.'; end if;
      if v_expense.status not in ('SUBMITTED','REJECTED') then raise exception using errcode = 'PT409', message = 'Only your submitted or rejected expenses can be edited.'; end if;
      v_before := crm.expense_json(v_expense);
      update crm.expenses set expense_date = v_date,title = v_title,category = v_category,amount_paise = v_amount,
        site = v_site,reference = v_reference,notes = v_notes,status = 'SUBMITTED',review_note = '',reviewed_by = null,
        reviewed_at = null,updated_at = v_now where id = v_id returning * into v_expense;
    end if;
    v_entity_type := 'expense'; v_entity_id := v_expense.id; v_after := crm.expense_json(v_expense); v_message := 'Expense submitted.';

  when 'expense_withdraw' then
    perform crm.operations_keys(p_payload,array['id'],array['id']);
    v_id := crm.operations_uuid(p_payload,'id');
    select * into v_expense from crm.expenses where id = v_id and user_id = p_actor_id;
    if not found then raise exception using errcode = 'PT404', message = 'Your expense was not found.'; end if;
    if v_expense.status not in ('SUBMITTED','REJECTED') then raise exception using errcode = 'PT409', message = 'Only your submitted or rejected expenses can be withdrawn.'; end if;
    v_before := crm.expense_json(v_expense);
    update crm.expenses set status = 'WITHDRAWN',updated_at = v_now where id = v_id returning * into v_expense;
    v_entity_type := 'expense'; v_entity_id := v_expense.id; v_after := crm.expense_json(v_expense); v_message := 'Expense withdrawn.';

  when 'expense_review' then
    perform crm.operations_keys(p_payload,array['id','status','note'],array['id','status']);
    v_id := crm.operations_uuid(p_payload,'id');
    v_status := crm.operations_text(p_payload,'status',8,true);
    v_note := crm.operations_text(p_payload,'note',2000);
    if v_status not in ('APPROVED','REJECTED','PAID') or (v_status = 'REJECTED' and v_note = '') then
      raise exception using errcode = 'PT400', message = 'Choose a valid review and give a reason for rejection.';
    end if;
    select * into v_expense from crm.expenses where id = v_id;
    if not found then raise exception using errcode = 'PT404', message = 'Expense not found.'; end if;
    if not ((v_expense.status = 'SUBMITTED' and v_status in ('APPROVED','REJECTED')) or (v_expense.status = 'APPROVED' and v_status = 'PAID')) then
      raise exception using errcode = 'PT409', message = 'This expense cannot move to the requested status.';
    end if;
    v_before := crm.expense_json(v_expense);
    update crm.expenses set status = v_status,review_note = v_note,reviewed_by = p_actor_id,
      reviewed_at = v_now,updated_at = v_now where id = v_id returning * into v_expense;
    v_entity_type := 'expense'; v_entity_id := v_expense.id; v_after := crm.expense_json(v_expense);
    v_reason := v_note; v_message := case v_status when 'APPROVED' then 'Expense approved.' when 'REJECTED' then 'Expense rejected.' else 'Expense marked as paid.' end;
  end case;

  insert into crm.operations_audit(actor_id,actor_name,action,entity_type,entity_id,before_data,after_data,reason,created_at)
    values(p_actor_id,v_member.name,p_action,v_entity_type,v_entity_id,v_before,v_after,v_reason,v_now);
  update crm.operations_state set revision = revision + 1 where id = 1 returning revision into v_revision;
  insert into crm.operations_receipts(request_id,actor_id,action,payload_hash,payload,revision,message,created_at)
    values(p_request_id,p_actor_id,p_action,p_payload_hash,p_payload,v_revision,v_message,v_now);
  return jsonb_build_object('data',crm.operations_snapshot(v_member,p_month,v_revision,clock_timestamp()),'message',v_message);
end;
$$;

-- New private helpers inherit PostgreSQL's PUBLIC execute unless revoked.
-- The existing workspace read keeps its service-only grant after replacement.
revoke all on function crm.operations_immutable() from public,anon,authenticated,service_role;
revoke all on function crm.operations_keys(jsonb,text[],text[]) from public,anon,authenticated,service_role;
revoke all on function crm.operations_text(jsonb,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function crm.operations_uuid(jsonb,text,boolean) from public,anon,authenticated,service_role;
revoke all on function crm.operations_decimal(jsonb,text,integer,boolean) from public,anon,authenticated,service_role;
revoke all on function crm.operations_date(text) from public,anon,authenticated,service_role;
revoke all on function crm.operations_month(text) from public,anon,authenticated,service_role;
revoke all on function crm.operations_timestamp(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function crm.stock_item_json(crm.stock_items) from public,anon,authenticated,service_role;
revoke all on function crm.stock_movement_json(crm.stock_movements) from public,anon,authenticated,service_role;
revoke all on function crm.attendance_json(crm.attendance) from public,anon,authenticated,service_role;
revoke all on function crm.expense_json(crm.expenses) from public,anon,authenticated,service_role;
revoke all on function crm.operations_expense_totals(date,date) from public,anon,authenticated,service_role;
revoke all on function crm.operations_snapshot(crm.members,text,bigint,timestamptz) from public,anon,authenticated,service_role;
revoke all on function crm.team_activity_module(text,text) from public,anon,authenticated,service_role;
revoke all on function crm.operations_activity_description(crm.operations_audit) from public,anon,authenticated,service_role;
revoke all on function public.crm_workspace_read(uuid,boolean) from public,anon,authenticated;
revoke all on function public.crm_team_activity_read(uuid,text,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.crm_operations_read(uuid,text) from public,anon,authenticated;
revoke all on function public.crm_operations_export(uuid) from public,anon,authenticated;
revoke all on function public.crm_operations_mutate(uuid,bigint,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.crm_operations_read(uuid,text) to service_role;
grant execute on function public.crm_operations_export(uuid) to service_role;
grant execute on function public.crm_operations_mutate(uuid,bigint,text,text,text,jsonb,text) to service_role;
grant execute on function public.crm_workspace_read(uuid,boolean) to service_role;
grant execute on function public.crm_team_activity_read(uuid,text,uuid,text,integer) to service_role;
notify pgrst, 'reload schema';
commit;
