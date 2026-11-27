-- Mushroom Farm app — ALL database setup in one file (fresh install only).
-- Made by "npm run sql:combine" from supabase/migrations/0001_schema.sql … 0012_edit_bills_orders.sql.
-- Paste into Supabase → SQL Editor → Run, ONCE, on a new project.
-- If you already ran some of the numbered files, run only the missing ones instead.

-- ===== 0001_schema.sql =====
-- =====================================================================
-- Mushroom Farm app — 0001 schema
-- Paste the whole file into Supabase -> SQL Editor -> New query -> Run.
-- Money is stored as whole paise (bigint): Rs 12.50 = 1250.
-- All timestamps are UTC; "business_date" columns are the IST calendar day.
-- =====================================================================

-- ---------- Types ----------------------------------------------------
create type user_role         as enum ('owner', 'cashier', 'worker', 'customer');
create type product_unit      as enum ('kg', 'packet', 'piece');
create type pay_mode          as enum ('cash', 'upi', 'advance');
create type money_mode        as enum ('cash', 'upi');
create type coupon_kind       as enum ('percent', 'flat');
create type coupon_scope      as enum ('all', 'selected');
create type bill_status       as enum ('active', 'void');
create type pay_type          as enum ('daily', 'monthly');
create type attendance_status as enum ('present', 'absent', 'half_day', 'leave');
create type worker_txn_type   as enum ('earned', 'bonus', 'payment', 'advance', 'deduction', 'reversal');
create type order_status      as enum ('pending', 'advance_paid', 'ready', 'delivered', 'cancelled');
create type order_pay_kind    as enum ('advance', 'refund');
create type report_kind       as enum ('daily', 'manual', 'backup');
create type report_status     as enum ('running', 'done', 'failed');

-- ---------- Small helpers ---------------------------------------------
-- Today's date in India.
create function ist_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- Indian financial year label for a date: 2025-11-21 -> '25-26'.
create function fy_label(d date) returns text
language sql immutable as $$
  select lpad((y % 100)::text, 2, '0') || '-' || lpad(((y + 1) % 100)::text, 2, '0')
  from (select case when extract(month from d) >= 4
                    then extract(year from d)::int
                    else extract(year from d)::int - 1 end as y) t
$$;

create function set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- Blocks deletes (and, for append-only tables, updates) on financial records.
create function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception 'Rows in "%" cannot be %d. Use void / reversal instead.',
    tg_table_name, lower(tg_op) using errcode = 'P0001';
end $$;

-- ---------- Users and settings ------------------------------------------
create table profiles (
  id          uuid primary key references auth.users (id) on delete restrict,
  phone       text not null unique check (phone ~ '^91[6-9][0-9]{9}$'),
  full_name   text not null check (length(trim(full_name)) between 1 and 100),
  role        user_role not null,
  active      boolean not null default true,
  lang        text not null default 'en' check (lang in ('en', 'hi', 'mr')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table app_settings (
  id                  boolean primary key default true check (id),
  farm_name           text not null default 'Mushroom Farm',
  address             text not null default '',
  phone               text not null default '',
  gstin               text,                          -- leave empty if not registered
  prices_include_gst  boolean not null default true,
  upi_id              text,                          -- e.g. farm@upi, used for QR on bills
  bill_prefix         text not null default 'MF' check (bill_prefix ~ '^[A-Z]{1,5}$'),
  bill_footer         text not null default 'Thank you! Visit again.',
  report_email        text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
insert into app_settings (id) values (true);

-- Gapless document numbers per financial year (bills, returns, orders).
create table doc_counters (
  key      text primary key,          -- e.g. 'MF/25-26'
  last_no  integer not null default 0
);

-- ---------- Catalogue and customers ----------------------------------------
create table products (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 1 and 80),
  local_name        text,                                   -- Hindi / Marathi name later
  unit              product_unit not null default 'packet',
  price_paise       bigint not null check (price_paise >= 0),
  gst_rate_bp       integer not null default 0 check (gst_rate_bp between 0 and 2800), -- 500 = 5%
  hsn_code          text,
  sort_order        integer not null default 0,
  archived_at       timestamptz,
  created_by        uuid default auth.uid() references profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table customers (
  id          uuid primary key default gen_random_uuid(),
  name        text check (length(name) <= 100),
  phone       text unique check (phone ~ '^91[6-9][0-9]{9}$'),
  profile_id  uuid unique references profiles (id),
  notes       text,
  created_by  uuid default auth.uid() references profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table coupons (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique check (code ~ '^[A-Z0-9_-]{3,20}$'),
  description     text,
  kind            coupon_kind not null,
  value           bigint not null check (value > 0),     -- percent: basis points (1000 = 10%); flat: paise
  applies_to      coupon_scope not null default 'all',
  customer_id     uuid references customers (id),        -- null = anyone
  min_bill_paise  bigint not null default 0 check (min_bill_paise >= 0),
  starts_at       timestamptz,
  expires_at      timestamptz,
  usage_limit     integer check (usage_limit > 0),
  used_count      integer not null default 0 check (used_count >= 0),
  active          boolean not null default true,
  created_by      uuid default auth.uid() references profiles (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (kind <> 'percent' or value <= 10000)
);

create table coupon_products (
  coupon_id   uuid not null references coupons (id),
  product_id  uuid not null references products (id),
  primary key (coupon_id, product_id)
);

-- ---------- Orders (declared before bills because bills reference them) -------
create table orders (
  id               uuid primary key default gen_random_uuid(),
  order_no         text not null unique,
  customer_id      uuid references customers (id),
  customer_name    text not null check (length(trim(customer_name)) between 1 and 100),
  customer_phone   text check (customer_phone ~ '^91[6-9][0-9]{9}$'),
  delivery_date    date not null,
  delivery_note    text,
  status           order_status not null default 'pending',
  subtotal_paise   bigint not null default 0 check (subtotal_paise >= 0),
  notes            text,
  cancel_reason    text,
  bill_id          uuid unique,                       -- FK added after bills table
  created_by       uuid default auth.uid() references profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders (id),
  product_id        uuid not null references products (id),
  product_name      text not null,
  unit              product_unit not null,
  unit_price_paise  bigint not null check (unit_price_paise >= 0),
  qty               numeric(10, 3) not null check (qty > 0),
  line_total_paise  bigint not null check (line_total_paise >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table order_payments (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders (id),
  kind           order_pay_kind not null default 'advance',
  mode           money_mode not null,
  amount_paise   bigint not null check (amount_paise > 0),
  business_date  date not null default ist_today(),
  note           text,
  created_by     uuid default auth.uid() references profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- Billing -------------------------------------------------------
create table bills (
  id              uuid primary key default gen_random_uuid(),
  bill_no         text not null unique,                -- MF/25-26/000123
  business_date   date not null default ist_today(),
  customer_id     uuid references customers (id),
  customer_name   text,                                -- as typed at the counter
  customer_phone  text check (customer_phone ~ '^91[6-9][0-9]{9}$'),
  subtotal_paise  bigint not null check (subtotal_paise >= 0),
  discount_paise  bigint not null default 0 check (discount_paise >= 0),
  tax_paise       bigint not null default 0 check (tax_paise >= 0),   -- GST portion (info)
  total_paise     bigint not null check (total_paise >= 0),
  coupon_id       uuid references coupons (id),
  order_id        uuid unique references orders (id),
  status          bill_status not null default 'active',
  void_reason     text,
  voided_by       uuid references profiles (id),
  voided_at       timestamptz,
  share_token     text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_by      uuid default auth.uid() references profiles (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (discount_paise <= subtotal_paise)
);
alter table orders add constraint orders_bill_fk foreign key (bill_id) references bills (id);

create table bill_items (
  id                uuid primary key default gen_random_uuid(),
  bill_id           uuid not null references bills (id),
  product_id        uuid not null references products (id),
  product_name      text not null,                   -- copy at time of sale
  unit              product_unit not null,
  unit_price_paise  bigint not null check (unit_price_paise >= 0),
  qty               numeric(10, 3) not null check (qty > 0),
  gst_rate_bp       integer not null default 0,
  discount_paise    bigint not null default 0 check (discount_paise >= 0),
  tax_paise         bigint not null default 0 check (tax_paise >= 0),
  line_total_paise  bigint not null check (line_total_paise >= 0),   -- after discount
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table payments (
  id             uuid primary key default gen_random_uuid(),
  bill_id        uuid not null references bills (id),
  mode           pay_mode not null,
  amount_paise   bigint not null check (amount_paise > 0),
  reference      text,                                -- UPI ref (optional)
  business_date  date not null default ist_today(),
  created_by     uuid default auth.uid() references profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table returns (
  id             uuid primary key default gen_random_uuid(),
  return_no      text not null unique,                -- RT/25-26/0001
  bill_id        uuid not null references bills (id),
  business_date  date not null default ist_today(),
  amount_paise   bigint not null check (amount_paise > 0),
  refund_mode    money_mode not null,
  reason         text,
  created_by     uuid default auth.uid() references profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table return_items (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references returns (id),
  bill_item_id   uuid not null references bill_items (id),
  qty            numeric(10, 3) not null check (qty > 0),
  amount_paise   bigint not null check (amount_paise >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table cash_out (
  id             uuid primary key default gen_random_uuid(),
  business_date  date not null default ist_today(),
  amount_paise   bigint not null check (amount_paise > 0),
  reason         text not null check (length(trim(reason)) between 1 and 200),
  taken_by       text not null check (length(trim(taken_by)) between 1 and 100),
  voided         boolean not null default false,
  void_reason    text,
  voided_by      uuid references profiles (id),
  voided_at      timestamptz,
  created_by     uuid default auth.uid() references profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- Workforce -----------------------------------------------------
create table workers (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid unique references profiles (id),       -- set when the worker has an app login
  name        text not null check (length(trim(name)) between 1 and 100),
  phone       text unique check (phone ~ '^91[6-9][0-9]{9}$'),
  pay_type    pay_type not null default 'daily',
  rate_paise  bigint not null default 0 check (rate_paise >= 0),   -- per day, or per month
  category    text,                                           -- your own worker class
  joined_on   date not null default ist_today(),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table attendance (
  id          uuid primary key default gen_random_uuid(),
  worker_id   uuid not null references workers (id),
  att_date    date not null,
  status      attendance_status not null,
  note        text,
  marked_by   uuid default auth.uid() references profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (worker_id, att_date)
);

-- Append-only ledger. Positive = farm owes the worker more. Balance = sum(amount_paise).
create table worker_transactions (
  id             uuid primary key default gen_random_uuid(),
  worker_id      uuid not null references workers (id),
  txn_date       date not null default ist_today(),
  type           worker_txn_type not null,
  amount_paise   bigint not null check (amount_paise <> 0),
  mode           money_mode,                         -- for payments / advances
  period_month   date check (period_month = date_trunc('month', period_month)::date),
  attendance_id  uuid references attendance (id),
  reverses_id    uuid references worker_transactions (id),
  note           text,
  created_by     uuid default auth.uid() references profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (
    (type in ('earned', 'bonus') and amount_paise > 0) or
    (type in ('payment', 'advance', 'deduction') and amount_paise < 0) or
    (type = 'reversal' and reverses_id is not null)
  )
);

-- ---------- Reports and audit ----------------------------------------------
create table report_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          report_kind not null,
  from_date     date,
  to_date       date,
  status        report_status not null default 'running',
  storage_path  text,
  emailed_at    timestamptz,
  error         text,
  triggered_by  uuid references profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table audit_log (
  id          bigint generated always as identity primary key,
  table_name  text not null,
  row_id      text,
  action      text not null,
  actor       uuid,
  at          timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);

-- ---------- Indexes ---------------------------------------------------------
create index on bills (business_date);
create index on bills (customer_id);
create index on bills (created_by, business_date);
create index on bill_items (bill_id);
create index on bill_items (product_id);
create index on payments (bill_id);
create index on payments (business_date);
create index on returns (bill_id);
create index on returns (business_date);
create index on return_items (return_id);
create index on return_items (bill_item_id);
create index on cash_out (business_date);
create index on attendance (att_date);
create index on worker_transactions (worker_id, txn_date);
create index on orders (delivery_date);
create index on orders (customer_id);
create index on order_items (order_id);
create index on order_payments (order_id);
create index on order_payments (business_date);
create index on coupons (customer_id);
create index on audit_log (table_name, row_id);

-- ---------- Triggers: updated_at -------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','app_settings','products','customers','coupons','orders','order_items',
    'order_payments','bills','bill_items','payments','returns','return_items','cash_out',
    'workers','attendance','worker_transactions','report_runs'
  ] loop
    execute format('create trigger %I_updated_at before update on %I
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ---------- Triggers: no hard deletes on business records -------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','products','customers','coupons','orders','order_payments','bills',
    'bill_items','payments','returns','return_items','cash_out','workers','attendance',
    'worker_transactions','audit_log','report_runs'
  ] loop
    execute format('create trigger %I_no_delete before delete on %I
                    for each row execute function forbid_change()', t, t);
  end loop;
end $$;

-- Append-only: these rows can never be edited either.
do $$
declare t text;
begin
  foreach t in array array[
    'bill_items','payments','returns','return_items','order_payments','worker_transactions','audit_log'
  ] loop
    execute format('create trigger %I_no_update before update on %I
                    for each row execute function forbid_change()', t, t);
  end loop;
end $$;

-- Bills: only the void fields may change, and only once.
create function guard_bill_update() returns trigger
language plpgsql as $$
declare allowed text[] := array['status','void_reason','voided_by','voided_at','updated_at'];
begin
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'A bill cannot be edited. Void it and create a new bill.' using errcode = 'P0001';
  end if;
  if old.status = 'void' then
    raise exception 'This bill is already void.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger bills_guard before update on bills for each row execute function guard_bill_update();

-- Cash out: only the void fields may change, and only once.
create function guard_cash_out_update() returns trigger
language plpgsql as $$
declare allowed text[] := array['voided','void_reason','voided_by','voided_at','updated_at'];
begin
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'A cash-out entry cannot be edited. Void it and add a new one.' using errcode = 'P0001';
  end if;
  if old.voided then
    raise exception 'This cash-out entry is already void.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger cash_out_guard before update on cash_out for each row execute function guard_cash_out_update();

-- ---------- Audit trail of every edit ----------------------------------------------
-- (Append-only tables are their own history, so we log UPDATEs on editable tables.)
create function audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (table_name, row_id, action, actor, old_data, new_data)
  values (tg_table_name, to_jsonb(new) ->> 'id', tg_op, auth.uid(), to_jsonb(old), to_jsonb(new));
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','app_settings','products','customers','coupons','orders','order_items',
    'bills','cash_out','workers','attendance'
  ] loop
    execute format('create trigger %I_audit after update on %I
                    for each row execute function audit_row()', t, t);
  end loop;
end $$;

-- ---------- Document numbering -------------------------------------------------------
-- Returns e.g. 'MF/25-26/000123'. Gapless: the counter row is locked until the
-- calling transaction commits, and rolls back with it.
create function next_doc_no(p_prefix text, p_date date, p_width int)
returns text
language plpgsql security definer set search_path = public as $$
declare k text := p_prefix || '/' || fy_label(p_date);
        n int;
begin
  insert into doc_counters (key, last_no) values (k, 1)
  on conflict (key) do update set last_no = doc_counters.last_no + 1
  returning last_no into n;
  return k || '/' || lpad(n::text, p_width, '0');
end $$;


-- ===== 0002_security.sql =====
-- =====================================================================
-- Mushroom Farm app — 0002 security (Row Level Security)
-- Run after 0001_schema.sql.
--
-- Rule of thumb:
--   * Every table has RLS on. No policy = no access.
--   * The public "anon" key can read nothing at all.
--   * Money is written only through checked database functions (added in
--     later phases), never by inserting rows directly from the app.
-- =====================================================================

-- ---------- Who is calling? (SECURITY DEFINER so they can read profiles) ----
create function my_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'owner' from profiles where id = auth.uid() and active), false)
$$;

create function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('owner', 'cashier') from profiles where id = auth.uid() and active), false)
$$;

create function is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active)
$$;

create function my_worker_id() returns uuid
language sql stable security definer set search_path = public as $$
  select w.id from workers w join profiles p on p.id = w.profile_id
  where p.id = auth.uid() and p.active
$$;

create function my_customer_id() returns uuid
language sql stable security definer set search_path = public as $$
  select c.id from customers c join profiles p on p.id = c.profile_id
  where p.id = auth.uid() and p.active
$$;

-- ---------- Lock everything down first ------------------------------------
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon, public;

-- Internal helpers: not callable from the app at all.
revoke execute on function next_doc_no(text, date, int) from authenticated;
revoke execute on function audit_row()                   from authenticated;
revoke execute on function forbid_change()               from authenticated;
revoke execute on function guard_bill_update()           from authenticated;
revoke execute on function guard_cash_out_update()       from authenticated;
revoke execute on function set_updated_at()              from authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','app_settings','doc_counters','products','customers','coupons','coupon_products',
    'orders','order_items','order_payments','bills','bill_items','payments','returns',
    'return_items','cash_out','workers','attendance','worker_transactions','report_runs','audit_log'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- profiles ----------------------------------------------------------
-- Accounts are created/changed only by the admin-users Edge Function (service key).
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or (select is_owner()));

-- Each user may change only their own language.
create function set_my_lang(p_lang text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_lang not in ('en', 'hi', 'mr') then raise exception 'Unknown language'; end if;
  update profiles set lang = p_lang where id = auth.uid() and active;
end $$;
grant execute on function set_my_lang(text) to authenticated;

-- ---------- app_settings ---------------------------------------------------------
create policy settings_read  on app_settings for select to authenticated using ((select is_active_user()));
create policy settings_write on app_settings for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

-- ---------- doc_counters: no policies = functions only ----------------------------

-- ---------- products ------------------------------------------------------------
create policy products_read   on products for select to authenticated using ((select is_staff()));
create policy products_insert on products for insert to authenticated with check ((select is_owner()));
create policy products_update on products for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

-- ---------- customers -----------------------------------------------------------
create policy customers_read on customers for select to authenticated
  using ((select is_staff()) or id = (select my_customer_id()));
create policy customers_insert on customers for insert to authenticated with check ((select is_staff()));
create policy customers_update on customers for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

-- ---------- coupons ---------------------------------------------------------------
create policy coupons_read on coupons for select to authenticated
  using ((select is_owner())
         or ((select is_staff()) and active)
         or (customer_id is not null and customer_id = (select my_customer_id())));
create policy coupons_insert on coupons for insert to authenticated with check ((select is_owner()));
create policy coupons_update on coupons for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

create policy coupon_products_read on coupon_products for select to authenticated using ((select is_staff()));
create policy coupon_products_write on coupon_products for insert to authenticated with check ((select is_owner()));
create policy coupon_products_delete on coupon_products for delete to authenticated using ((select is_owner()));

-- ---------- bills and children ---------------------------------------------------
-- Owner: all. Cashier: bills they made today. Customer: their own bills.
create policy bills_read on bills for select to authenticated
  using ((select is_owner())
         or ((select my_role()) = 'cashier' and created_by = auth.uid() and business_date = ist_today())
         or (customer_id is not null and customer_id = (select my_customer_id())));

-- Child rows are visible exactly when the parent bill is visible (bills RLS applies inside).
create policy bill_items_read on bill_items for select to authenticated
  using (exists (select 1 from bills b where b.id = bill_id));
create policy payments_read on payments for select to authenticated
  using (exists (select 1 from bills b where b.id = bill_id));

create policy returns_read on returns for select to authenticated
  using ((select is_owner())
         or ((select my_role()) = 'cashier' and created_by = auth.uid() and business_date = ist_today())
         or exists (select 1 from bills b where b.id = bill_id
                    and b.customer_id is not null and b.customer_id = (select my_customer_id())));
create policy return_items_read on return_items for select to authenticated
  using (exists (select 1 from returns r where r.id = return_id));

create policy cash_out_read on cash_out for select to authenticated
  using ((select is_owner())
         or ((select my_role()) = 'cashier' and created_by = auth.uid() and business_date = ist_today()));

-- ---------- workforce ------------------------------------------------------------
-- Owner manages; each worker (or cashier who is also a worker) sees only their own rows.
create policy workers_read on workers for select to authenticated
  using ((select is_owner()) or id = (select my_worker_id()));
create policy workers_insert on workers for insert to authenticated with check ((select is_owner()));
create policy workers_update on workers for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

create policy attendance_read on attendance for select to authenticated
  using ((select is_owner()) or worker_id = (select my_worker_id()));
create policy attendance_insert on attendance for insert to authenticated with check ((select is_owner()));
create policy attendance_update on attendance for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

create policy wtx_read on worker_transactions for select to authenticated
  using ((select is_owner()) or worker_id = (select my_worker_id()));
create policy wtx_insert on worker_transactions for insert to authenticated with check ((select is_owner()));

-- ---------- orders --------------------------------------------------------------
-- Cashier sees today's deliveries (to convert them to bills at the counter).
create policy orders_read on orders for select to authenticated
  using ((select is_owner())
         or ((select my_role()) = 'cashier' and delivery_date = ist_today())
         or (customer_id is not null and customer_id = (select my_customer_id())));
create policy orders_insert on orders for insert to authenticated with check ((select is_owner()));
create policy orders_update on orders for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));

create policy order_items_read on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));
create policy order_items_insert on order_items for insert to authenticated with check ((select is_owner()));
create policy order_items_update on order_items for update to authenticated
  using ((select is_owner())) with check ((select is_owner()));
create policy order_items_delete on order_items for delete to authenticated
  using ((select is_owner()) and exists (select 1 from orders o where o.id = order_id and o.status in ('pending', 'advance_paid')));

create policy order_payments_read on order_payments for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id));
create policy order_payments_insert on order_payments for insert to authenticated with check ((select is_owner()));

-- ---------- reports and audit: owner only -----------------------------------------
create policy report_runs_read on report_runs for select to authenticated using ((select is_owner()));
create policy audit_read       on audit_log   for select to authenticated using ((select is_owner()));

-- ---------- First owner (run once, by you, in the SQL editor) ---------------------
-- Not callable from the app. See docs/PHASE-1-SETUP.md step 4.
create function bootstrap_owner(p_phone text, p_name text) returns text
language plpgsql security definer set search_path = public as $$
declare v_phone text := regexp_replace(p_phone, '\D', '', 'g');
        v_id uuid;
begin
  if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
  if exists (select 1 from profiles where role = 'owner') then
    raise exception 'An owner already exists. Add more users from the app.';
  end if;
  select id into v_id from auth.users where email = v_phone || '@farm.local';
  if v_id is null then
    raise exception 'No login found for %@farm.local. Create it first in Authentication -> Users.', v_phone;
  end if;
  insert into profiles (id, phone, full_name, role) values (v_id, v_phone, p_name, 'owner');
  return 'Owner created: ' || p_name || ' (' || v_phone || ')';
end $$;
revoke execute on function bootstrap_owner(text, text) from public, anon, authenticated;


-- ===== 0003_billing.sql =====
-- =====================================================================
-- Mushroom Farm app — 0003 billing
-- Run after 0002_security.sql.
-- Bills are created ONLY through create_bill(): the server looks up prices,
-- computes totals and GST, checks payments add up, and numbers the bill.
-- =====================================================================

-- Protects against double bills when the "Save" button is tapped twice on a slow network.
alter table bills add column client_ref uuid unique;

create function create_bill(
  p_items          jsonb,                 -- [{"product_id": "...", "qty": 2}, ...]
  p_payments       jsonb,                 -- [{"mode": "cash", "amount_paise": 12000}, ...]
  p_customer_name  text default null,
  p_customer_phone text default null,
  p_client_ref     uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  v_existing bills;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_gross    bigint;
  v_tax      bigint;
  v_line     bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_sub      bigint := 0;
  v_taxsum   bigint := 0;
  v_total    bigint;
  v_pay      jsonb;
  v_mode     text;
  v_amt      bigint;
  v_paysum   bigint := 0;
  v_phone    text;
  v_name     text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_customer uuid;
  v_today    date := ist_today();
  v_bill_id  uuid;
  v_bill_no  text;
  v_token    text;
begin
  if not is_staff() then
    raise exception 'Only the owner or a cashier can create bills.' using errcode = '42501';
  end if;

  -- Same request sent twice? Return the bill already made.
  if p_client_ref is not null then
    select * into v_existing from bills where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'bill_no', v_existing.bill_no,
                                'share_token', v_existing.share_token, 'duplicate', true);
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one bill.'; end if;
  if v_name is not null and length(v_name) > 100 then raise exception 'Customer name is too long.'; end if;

  select * into s from app_settings where id;

  -- 1. Price every line from the database (never trust prices sent by the phone).
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    if v_prod.archived_at is not null then
      raise exception '"%" is no longer sold.', v_prod.name;
    end if;
    begin
      v_qty := (v_item ->> 'qty')::numeric;
    exception when others then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 10000 or v_qty <> round(v_qty, 3) then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end if;
    if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then
      raise exception '"%" must be a whole number.', v_prod.name;
    end if;

    v_gross := round(v_prod.price_paise * v_qty);
    if s.prices_include_gst then
      v_tax  := round(v_gross * v_prod.gst_rate_bp / (10000.0 + v_prod.gst_rate_bp));
      v_line := v_gross;
    else
      v_tax  := round(v_gross * v_prod.gst_rate_bp / 10000.0);
      v_line := v_gross + v_tax;
    end if;
    v_sub    := v_sub + v_gross;
    v_taxsum := v_taxsum + v_tax;
    v_lines  := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit,
      'price', v_prod.price_paise, 'qty', v_qty, 'gst', v_prod.gst_rate_bp,
      'tax', v_tax, 'line', v_line);
  end loop;

  v_total := v_sub + case when s.prices_include_gst then 0 else v_taxsum end;

  -- 2. Payments must add up exactly to the total.
  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then raise exception 'Payment is missing.'; end if;
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_mode := v_pay ->> 'mode';
    v_amt  := (v_pay ->> 'amount_paise')::bigint;
    if v_mode not in ('cash', 'upi') then raise exception 'Payment must be cash or UPI.'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Payment amounts must be more than zero.'; end if;
    v_paysum := v_paysum + v_amt;
  end loop;
  if v_paysum <> v_total then
    raise exception 'Payments (₹%) do not match the bill total (₹%).',
      to_char(v_paysum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  end if;

  -- 3. Optional customer: find or create by mobile number.
  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
    if v_customer is null then
      insert into customers (name, phone) values (v_name, v_phone) returning id into v_customer;
    elsif v_name is not null then
      update customers set name = v_name where id = v_customer and name is null;
    end if;
  end if;

  -- 4. Save. The bill number is taken inside this transaction, so numbers have no gaps.
  v_bill_no := next_doc_no(s.bill_prefix, v_today, 6);
  insert into bills (bill_no, business_date, customer_id, customer_name, customer_phone,
                     subtotal_paise, discount_paise, tax_paise, total_paise, client_ref)
  values (v_bill_no, v_today, v_customer, v_name, v_phone,
          v_sub, 0, v_taxsum, v_total, p_client_ref)
  returning id, share_token into v_bill_id, v_token;

  insert into bill_items (bill_id, product_id, product_name, unit, unit_price_paise, qty,
                          gst_rate_bp, tax_paise, line_total_paise)
  select v_bill_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit,
         (l ->> 'price')::bigint, (l ->> 'qty')::numeric, (l ->> 'gst')::int,
         (l ->> 'tax')::bigint, (l ->> 'line')::bigint
  from jsonb_array_elements(v_lines) l;

  insert into payments (bill_id, mode, amount_paise, business_date)
  select v_bill_id, (p ->> 'mode')::pay_mode, (p ->> 'amount_paise')::bigint, v_today
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) p;

  return jsonb_build_object('id', v_bill_id, 'bill_no', v_bill_no, 'share_token', v_token,
                            'total_paise', v_total, 'duplicate', false);
end $$;

-- Owner only. A voided bill stays in the records, marked VOID, with the reason.
create function void_bill(p_bill_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'Only the owner can void a bill.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  if exists (select 1 from returns where bill_id = p_bill_id) then
    raise exception 'This bill has returns. It cannot be voided.';
  end if;
  update bills set status = 'void', void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_bill_id and status = 'active';
  if not found then raise exception 'Bill not found or already void.'; end if;
end $$;

-- Printable bill for a share link. Needs the secret token; works without login
-- (so customers can open the WhatsApp link). Never returns the customer's phone.
create function get_public_bill(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_no', b.bill_no,
    'created_at', b.created_at,
    'customer_name', b.customer_name,
    'subtotal_paise', b.subtotal_paise,
    'discount_paise', b.discount_paise,
    'tax_paise', b.tax_paise,
    'total_paise', b.total_paise,
    'status', b.status,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', i.product_name, 'unit', i.unit, 'qty', i.qty,
                'price_paise', i.unit_price_paise, 'gst_rate_bp', i.gst_rate_bp,
                'tax_paise', i.tax_paise, 'line_total_paise', i.line_total_paise)
                order by i.created_at, i.id), '[]'::jsonb)
              from bill_items i where i.bill_id = b.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('mode', p.mode, 'amount_paise', p.amount_paise)
                order by p.created_at, p.id), '[]'::jsonb)
              from payments p where p.bill_id = b.id),
    'farm', (select jsonb_build_object('name', farm_name, 'address', address, 'phone', phone,
                    'gstin', gstin, 'prices_include_gst', prices_include_gst, 'footer', bill_footer)
             from app_settings where id)
  )
  from bills b
  where length(p_token) = 32 and b.share_token = p_token
$$;

revoke execute on function create_bill(jsonb, jsonb, text, text, uuid) from public, anon;
revoke execute on function void_bill(uuid, text)                       from public, anon;
grant  execute on function create_bill(jsonb, jsonb, text, text, uuid) to authenticated;
grant  execute on function void_bill(uuid, text)                       to authenticated;
grant  execute on function get_public_bill(text)                       to anon, authenticated;


-- ===== 0004_returns_cash_coupons.sql =====
-- =====================================================================
-- Mushroom Farm app — 0004 coupons, returns, cash out, cash summary
-- Run after 0003_billing.sql.
-- =====================================================================

alter table returns  add column client_ref uuid unique;
alter table cash_out add column client_ref uuid unique;

-- ---------------------------------------------------------------------
-- Pricing (internal). Used by both preview_bill (for the screen) and
-- create_bill (for saving), so the discount shown is the discount saved.
-- ---------------------------------------------------------------------
create function price_bill(p_items jsonb, p_coupon_code text, p_customer_phone text, p_lock boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_gross    bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_line     jsonb;
  v_sub      bigint := 0;
  v_code     text := upper(nullif(trim(coalesce(p_coupon_code, '')), ''));
  v_coupon   coupons;
  v_phone    text;
  v_customer uuid;
  v_elig     boolean;
  v_eligible bigint := 0;
  v_disc     bigint := 0;
  v_left     bigint;
  v_share    bigint;
  v_last     int := -1;
  v_net      bigint;
  v_tax      bigint;
  v_taxsum   bigint := 0;
  v_total    bigint := 0;
  i          int;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one bill.'; end if;
  select * into s from app_settings where id;

  -- Customer mobile (optional)
  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
  end if;

  -- Coupon (optional)
  if v_code is not null then
    if p_lock then
      select * into v_coupon from coupons where code = v_code for update;
    else
      select * into v_coupon from coupons where code = v_code;
    end if;
    if not found then raise exception 'Coupon "%" not found.', v_code; end if;
    if not v_coupon.active then raise exception 'Coupon "%" is switched off.', v_code; end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
      raise exception 'Coupon "%" has not started yet.', v_code;
    end if;
    if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
      raise exception 'Coupon "%" has expired.', v_code;
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'Coupon "%" has been fully used.', v_code;
    end if;
    if v_coupon.customer_id is not null and v_coupon.customer_id is distinct from v_customer then
      raise exception 'Coupon "%" is for one customer only. Enter that customer''s mobile number.', v_code;
    end if;
  end if;

  -- 1. Price each line from the database.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    if v_prod.archived_at is not null then raise exception '"%" is no longer sold.', v_prod.name; end if;
    begin
      v_qty := (v_item ->> 'qty')::numeric;
    exception when others then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 10000 or v_qty <> round(v_qty, 3) then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end if;
    if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then
      raise exception '"%" must be a whole number.', v_prod.name;
    end if;

    v_gross := round(v_prod.price_paise * v_qty);
    v_elig := v_code is not null and (v_coupon.applies_to = 'all' or exists (
                select 1 from coupon_products cp where cp.coupon_id = v_coupon.id and cp.product_id = v_prod.id));
    v_sub := v_sub + v_gross;
    if v_elig then
      v_eligible := v_eligible + v_gross;
      v_last := jsonb_array_length(v_lines);
    end if;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit, 'price', v_prod.price_paise,
      'qty', v_qty, 'gst', v_prod.gst_rate_bp, 'gross', v_gross, 'eligible', v_elig);
  end loop;

  -- 2. Coupon discount, shared across the eligible lines.
  if v_code is not null then
    if v_eligible = 0 then raise exception 'Coupon "%" does not apply to these products.', v_code; end if;
    if v_sub < v_coupon.min_bill_paise then
      raise exception 'Coupon "%" needs a bill of at least ₹%.', v_code,
        to_char(v_coupon.min_bill_paise / 100.0, 'FM999999990.00');
    end if;
    v_disc := case when v_coupon.kind = 'percent'
                   then round(v_eligible * v_coupon.value / 10000.0)
                   else least(v_coupon.value, v_eligible) end;
  end if;

  v_left := v_disc;
  for i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_line := v_lines -> i;
    v_gross := (v_line ->> 'gross')::bigint;
    if (v_line ->> 'eligible')::boolean then
      v_share := case when i = v_last then v_left else (v_gross * v_disc) / v_eligible end;
      v_left := v_left - v_share;
    else
      v_share := 0;
    end if;
    v_net := v_gross - v_share;
    if s.prices_include_gst then
      v_tax := round(v_net * (v_line ->> 'gst')::int / (10000.0 + (v_line ->> 'gst')::int));
    else
      v_tax := round(v_net * (v_line ->> 'gst')::int / 10000.0);
      v_net := v_net + v_tax;
    end if;
    v_taxsum := v_taxsum + v_tax;
    v_total := v_total + v_net;
    v_out := v_out || (v_line || jsonb_build_object('discount', v_share, 'tax', v_tax, 'line', v_net));
  end loop;

  return jsonb_build_object(
    'lines', v_out, 'subtotal_paise', v_sub, 'discount_paise', v_disc, 'tax_paise', v_taxsum,
    'total_paise', v_total, 'coupon_id', v_coupon.id, 'coupon_code', v_code,
    'customer_phone', v_phone, 'customer_id', v_customer);
end $$;

-- Shown on the bill screen before saving (e.g. after typing a coupon code).
create function preview_bill(p_items jsonb, p_coupon_code text default null, p_customer_phone text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not is_staff() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  r := price_bill(p_items, p_coupon_code, p_customer_phone, false);
  return jsonb_build_object('subtotal_paise', r -> 'subtotal_paise', 'discount_paise', r -> 'discount_paise',
                            'tax_paise', r -> 'tax_paise', 'total_paise', r -> 'total_paise',
                            'coupon_code', r -> 'coupon_code');
end $$;

-- ---------------------------------------------------------------------
-- create_bill now takes an optional coupon code.
-- ---------------------------------------------------------------------
drop function create_bill(jsonb, jsonb, text, text, uuid);

create function create_bill(
  p_items          jsonb,
  p_payments       jsonb,
  p_customer_name  text default null,
  p_customer_phone text default null,
  p_client_ref     uuid default null,
  p_coupon_code    text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  v_existing bills;
  r          jsonb;
  v_total    bigint;
  v_pay      jsonb;
  v_mode     text;
  v_amt      bigint;
  v_paysum   bigint := 0;
  v_name     text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_phone    text;
  v_customer uuid;
  v_today    date := ist_today();
  v_bill_id  uuid;
  v_bill_no  text;
  v_token    text;
begin
  if not is_staff() then
    raise exception 'Only the owner or a cashier can create bills.' using errcode = '42501';
  end if;
  if p_client_ref is not null then
    select * into v_existing from bills where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'bill_no', v_existing.bill_no,
                                'share_token', v_existing.share_token, 'total_paise', v_existing.total_paise,
                                'duplicate', true);
    end if;
  end if;
  if v_name is not null and length(v_name) > 100 then raise exception 'Customer name is too long.'; end if;

  select * into s from app_settings where id;
  r := price_bill(p_items, p_coupon_code, p_customer_phone, true);
  v_total := (r ->> 'total_paise')::bigint;
  v_phone := r ->> 'customer_phone';
  v_customer := (r ->> 'customer_id')::uuid;

  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then raise exception 'Payment is missing.'; end if;
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_mode := v_pay ->> 'mode';
    v_amt  := (v_pay ->> 'amount_paise')::bigint;
    if v_mode is null or v_mode not in ('cash', 'upi') then raise exception 'Payment must be cash or UPI.'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Payment amounts must be more than zero.'; end if;
    v_paysum := v_paysum + v_amt;
  end loop;
  if v_paysum <> v_total then
    raise exception 'Payments (₹%) do not match the bill total (₹%).',
      to_char(v_paysum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  end if;

  if v_phone is not null and v_customer is null then
    insert into customers (name, phone) values (v_name, v_phone) returning id into v_customer;
  elsif v_customer is not null and v_name is not null then
    update customers set name = v_name where id = v_customer and name is null;
  end if;

  v_bill_no := next_doc_no(s.bill_prefix, v_today, 6);
  insert into bills (bill_no, business_date, customer_id, customer_name, customer_phone, subtotal_paise,
                     discount_paise, tax_paise, total_paise, coupon_id, client_ref)
  values (v_bill_no, v_today, v_customer, v_name, v_phone, (r ->> 'subtotal_paise')::bigint,
          (r ->> 'discount_paise')::bigint, (r ->> 'tax_paise')::bigint, v_total,
          (r ->> 'coupon_id')::uuid, p_client_ref)
  returning id, share_token into v_bill_id, v_token;

  insert into bill_items (bill_id, product_id, product_name, unit, unit_price_paise, qty, gst_rate_bp,
                          discount_paise, tax_paise, line_total_paise)
  select v_bill_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit,
         (l ->> 'price')::bigint, (l ->> 'qty')::numeric, (l ->> 'gst')::int,
         (l ->> 'discount')::bigint, (l ->> 'tax')::bigint, (l ->> 'line')::bigint
  from jsonb_array_elements(r -> 'lines') l;

  insert into payments (bill_id, mode, amount_paise, business_date)
  select v_bill_id, (p ->> 'mode')::pay_mode, (p ->> 'amount_paise')::bigint, v_today
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) p;

  if r ->> 'coupon_id' is not null then
    update coupons set used_count = used_count + 1 where id = (r ->> 'coupon_id')::uuid;
  end if;

  return jsonb_build_object('id', v_bill_id, 'bill_no', v_bill_no, 'share_token', v_token,
                            'total_paise', v_total, 'duplicate', false);
end $$;

-- Voiding a bill gives its coupon use back.
create or replace function void_bill(p_bill_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_coupon uuid;
begin
  if not is_owner() then raise exception 'Only the owner can void a bill.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  if exists (select 1 from returns where bill_id = p_bill_id) then
    raise exception 'This bill has returns. It cannot be voided.';
  end if;
  update bills set status = 'void', void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_bill_id and status = 'active'
  returning coupon_id into v_coupon;
  if not found then raise exception 'Bill not found or already void.'; end if;
  if v_coupon is not null then
    update coupons set used_count = greatest(used_count - 1, 0) where id = v_coupon;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Returns / refunds
-- ---------------------------------------------------------------------
-- Find a bill to return items from. Accepts the full number (MF/25-26/000123)
-- or just the last digits (123 = the latest bill ending in 000123).
-- Cashiers can find bills from the last 30 days; the owner any bill.
create function find_bill_for_return(p_bill_no text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_no text := upper(trim(coalesce(p_bill_no, '')));
  b    bills;
begin
  if not is_staff() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if v_no ~ '^\d{1,6}$' then
    select * into b from bills where bill_no like '%/' || lpad(v_no, 6, '0') order by created_at desc limit 1;
  else
    select * into b from bills where bill_no = v_no;
  end if;
  if not found then return null; end if;
  if not is_owner() and b.business_date < ist_today() - 30 then
    raise exception 'Bills older than 30 days can only be returned by the owner.';
  end if;

  return jsonb_build_object(
    'id', b.id, 'bill_no', b.bill_no, 'created_at', b.created_at, 'status', b.status,
    'total_paise', b.total_paise, 'customer_name', b.customer_name,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', i.id, 'name', i.product_name, 'unit', i.unit, 'qty', i.qty,
                'line_total_paise', i.line_total_paise,
                'returned_qty', coalesce(rq.q, 0), 'returned_paise', coalesce(rq.a, 0))
                order by i.created_at, i.id), '[]'::jsonb)
              from bill_items i
              left join lateral (select sum(ri.qty) q, sum(ri.amount_paise) a
                                 from return_items ri where ri.bill_item_id = i.id) rq on true
              where i.bill_id = b.id),
    'returns', (select coalesce(jsonb_agg(jsonb_build_object(
                  'return_no', r.return_no, 'created_at', r.created_at, 'amount_paise', r.amount_paise,
                  'refund_mode', r.refund_mode, 'reason', r.reason) order by r.created_at), '[]'::jsonb)
                from returns r where r.bill_id = b.id));
end $$;

create function create_return(
  p_bill_id     uuid,
  p_items       jsonb,          -- [{"bill_item_id": "...", "qty": 1}, ...]
  p_refund_mode text,
  p_reason      text default null,
  p_client_ref  uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b          bills;
  v_existing returns;
  v_item     jsonb;
  bi         bill_items;
  v_qty      numeric;
  v_ret_q    numeric;
  v_ret_a    bigint;
  v_left     numeric;
  v_amt      bigint;
  v_rows     jsonb := '[]'::jsonb;
  v_sum      bigint := 0;
  v_id       uuid;
  v_no       text;
  v_today    date := ist_today();
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can record returns.' using errcode = '42501'; end if;
  if p_client_ref is not null then
    select * into v_existing from returns where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'return_no', v_existing.return_no,
                                'amount_paise', v_existing.amount_paise, 'duplicate', true);
    end if;
  end if;
  if p_refund_mode is null or p_refund_mode not in ('cash', 'upi') then
    raise exception 'Refund must be cash or UPI.';
  end if;
  if length(coalesce(p_reason, '')) > 200 then raise exception 'Reason is too long.'; end if;

  -- Lock the bill so two returns on it cannot run at the same moment.
  select * into b from bills where id = p_bill_id for update;
  if not found then raise exception 'Bill not found.'; end if;
  if b.status = 'void' then raise exception 'This bill is void. Nothing to return.'; end if;
  if not is_owner() and b.business_date < v_today - 30 then
    raise exception 'Bills older than 30 days can only be returned by the owner.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Choose at least one item to return.';
  end if;
  if (select count(distinct x ->> 'bill_item_id') from jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items) then
    raise exception 'The same item is listed twice.';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into bi from bill_items where id = (v_item ->> 'bill_item_id')::uuid and bill_id = b.id;
    if not found then raise exception 'Item is not on this bill.'; end if;
    v_qty := (v_item ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 or v_qty <> round(v_qty, 3) then
      raise exception 'Wrong return quantity for "%".', bi.product_name;
    end if;
    if bi.unit <> 'kg' and v_qty <> trunc(v_qty) then
      raise exception '"%" must be a whole number.', bi.product_name;
    end if;
    select coalesce(sum(qty), 0), coalesce(sum(amount_paise), 0) into v_ret_q, v_ret_a
    from return_items where bill_item_id = bi.id;
    v_left := bi.qty - v_ret_q;
    if v_qty > v_left then
      raise exception 'Only % of "%" can still be returned.', v_left, bi.product_name;
    end if;
    -- Refund the price actually paid (after any discount). The last unit returned takes
    -- whatever is left so rounding never refunds more than was paid.
    v_amt := case when v_qty = v_left then bi.line_total_paise - v_ret_a
                  else round(bi.line_total_paise * v_qty / bi.qty) end;
    v_sum := v_sum + v_amt;
    v_rows := v_rows || jsonb_build_object('bill_item_id', bi.id, 'qty', v_qty, 'amount', v_amt);
  end loop;
  if v_sum <= 0 then raise exception 'Nothing to refund.'; end if;

  v_no := next_doc_no('RT', v_today, 4);
  insert into returns (return_no, bill_id, business_date, amount_paise, refund_mode, reason, client_ref)
  values (v_no, b.id, v_today, v_sum, p_refund_mode::money_mode, nullif(trim(coalesce(p_reason, '')), ''), p_client_ref)
  returning id into v_id;
  insert into return_items (return_id, bill_item_id, qty, amount_paise)
  select v_id, (x ->> 'bill_item_id')::uuid, (x ->> 'qty')::numeric, (x ->> 'amount')::bigint
  from jsonb_array_elements(v_rows) x;

  return jsonb_build_object('id', v_id, 'return_no', v_no, 'amount_paise', v_sum, 'duplicate', false);
end $$;

-- ---------------------------------------------------------------------
-- Cash out (money taken from the till)
-- ---------------------------------------------------------------------
create function record_cash_out(p_amount_paise bigint, p_reason text, p_taken_by text, p_client_ref uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can record cash out.' using errcode = '42501'; end if;
  if p_client_ref is not null then
    select id into v_id from cash_out where client_ref = p_client_ref;
    if found then return v_id; end if;
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'Enter an amount.'; end if;
  if p_amount_paise > 100000000 then raise exception 'Amount is too large.'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Enter a reason.'; end if;
  if length(trim(coalesce(p_taken_by, ''))) = 0 then raise exception 'Enter who took the cash.'; end if;
  insert into cash_out (amount_paise, reason, taken_by, client_ref)
  values (p_amount_paise, trim(p_reason), trim(p_taken_by), p_client_ref)
  returning id into v_id;
  return v_id;
end $$;

create function void_cash_out(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'Only the owner can cancel a cash-out entry.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  update cash_out set voided = true, void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_id and not voided;
  if not found then raise exception 'Entry not found or already cancelled.'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Cash summary for a day. Cashier: only their own entries, only today.
-- Owner: everyone's entries, any day.
-- ---------------------------------------------------------------------
create function cash_summary(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_owner boolean := is_owner();
  v_date  date;
  v_by    uuid;
  r       jsonb;
begin
  if not is_staff() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  v_date := case when v_owner then coalesce(p_date, ist_today()) else ist_today() end;
  v_by   := case when v_owner then null else auth.uid() end;

  select jsonb_build_object(
    'date', v_date,
    'bills', (select count(*) from bills where business_date = v_date and status = 'active'
              and (v_by is null or created_by = v_by)),
    'sales_paise', (select coalesce(sum(total_paise), 0) from bills where business_date = v_date
                    and status = 'active' and (v_by is null or created_by = v_by)),
    'discount_paise', (select coalesce(sum(discount_paise), 0) from bills where business_date = v_date
                       and status = 'active' and (v_by is null or created_by = v_by)),
    'cash_sales_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                         where p.business_date = v_date and b.status = 'active' and p.mode = 'cash'
                         and (v_by is null or p.created_by = v_by)),
    'upi_sales_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                        where p.business_date = v_date and b.status = 'active' and p.mode = 'upi'
                        and (v_by is null or p.created_by = v_by)),
    'cash_refunds_paise', (select coalesce(sum(amount_paise), 0) from returns where business_date = v_date
                           and refund_mode = 'cash' and (v_by is null or created_by = v_by)),
    'upi_refunds_paise', (select coalesce(sum(amount_paise), 0) from returns where business_date = v_date
                          and refund_mode = 'upi' and (v_by is null or created_by = v_by)),
    'cash_out_paise', (select coalesce(sum(amount_paise), 0) from cash_out where business_date = v_date
                       and not voided and (v_by is null or created_by = v_by))
  ) into r;

  return r || jsonb_build_object('net_cash_paise',
    (r ->> 'cash_sales_paise')::bigint - (r ->> 'cash_refunds_paise')::bigint - (r ->> 'cash_out_paise')::bigint);
end $$;

-- ---------------------------------------------------------------------
-- Share link now also shows coupon and returns.
-- ---------------------------------------------------------------------
create or replace function get_public_bill(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_no', b.bill_no,
    'created_at', b.created_at,
    'customer_name', b.customer_name,
    'subtotal_paise', b.subtotal_paise,
    'discount_paise', b.discount_paise,
    'tax_paise', b.tax_paise,
    'total_paise', b.total_paise,
    'status', b.status,
    'coupon_code', (select c.code from coupons c where c.id = b.coupon_id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', i.product_name, 'unit', i.unit, 'qty', i.qty,
                'price_paise', i.unit_price_paise, 'gst_rate_bp', i.gst_rate_bp,
                'tax_paise', i.tax_paise, 'line_total_paise', i.line_total_paise)
                order by i.created_at, i.id), '[]'::jsonb)
              from bill_items i where i.bill_id = b.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('mode', p.mode, 'amount_paise', p.amount_paise)
                order by p.created_at, p.id), '[]'::jsonb)
              from payments p where p.bill_id = b.id),
    'returns', (select coalesce(jsonb_agg(jsonb_build_object('return_no', r.return_no, 'created_at', r.created_at,
                  'amount_paise', r.amount_paise, 'refund_mode', r.refund_mode) order by r.created_at), '[]'::jsonb)
              from returns r where r.bill_id = b.id),
    'farm', (select jsonb_build_object('name', farm_name, 'address', address, 'phone', phone,
                    'gstin', gstin, 'prices_include_gst', prices_include_gst, 'footer', bill_footer)
             from app_settings where id)
  )
  from bills b
  where length(p_token) = 32 and b.share_token = p_token
$$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
revoke execute on function price_bill(jsonb, text, text, boolean)                 from public, anon, authenticated;
revoke execute on function preview_bill(jsonb, text, text)                        from public, anon;
revoke execute on function create_bill(jsonb, jsonb, text, text, uuid, text)      from public, anon;
revoke execute on function find_bill_for_return(text)                             from public, anon;
revoke execute on function create_return(uuid, jsonb, text, text, uuid)           from public, anon;
revoke execute on function record_cash_out(bigint, text, text, uuid)              from public, anon;
revoke execute on function void_cash_out(uuid, text)                              from public, anon;
revoke execute on function cash_summary(date)                                     from public, anon;
grant  execute on function preview_bill(jsonb, text, text)                        to authenticated;
grant  execute on function create_bill(jsonb, jsonb, text, text, uuid, text)      to authenticated;
grant  execute on function find_bill_for_return(text)                             to authenticated;
grant  execute on function create_return(uuid, jsonb, text, text, uuid)           to authenticated;
grant  execute on function record_cash_out(bigint, text, text, uuid)              to authenticated;
grant  execute on function void_cash_out(uuid, text)                              to authenticated;
grant  execute on function cash_summary(date)                                     to authenticated;
grant  execute on function get_public_bill(text)                                  to anon, authenticated;


-- ===== 0005_workforce.sql =====
-- =====================================================================
-- Mushroom Farm app — 0005 workforce: attendance, wages, worker ledger
-- Run after 0004_returns_cash_coupons.sql.
--
-- The ledger (worker_transactions) is the single source of truth.
-- Balance = sum(amount_paise). Positive = the farm owes the worker.
--   earned     +  day wage (from attendance) or monthly salary (from "close month")
--   bonus      +
--   payment    −  money paid to the worker
--   advance    −  money paid before it was earned
--   deduction  −  e.g. monthly leave deduction decided by the owner
--   reversal   ±  cancels an earlier row (nothing is ever edited or deleted)
-- Attendance and ledger rows are written only through the functions below.
-- =====================================================================

drop policy attendance_insert on attendance;
drop policy attendance_update on attendance;
drop policy wtx_insert on worker_transactions;

-- Wage for one day of a daily-wage worker.
create function day_wage(p_rate bigint, p_status attendance_status) returns bigint
language sql immutable as $$
  select case p_status when 'present' then p_rate when 'half_day' then round(p_rate / 2.0)::bigint else 0 end
$$;

-- ---------------------------------------------------------------------
-- Attendance for one day, many workers at once.
-- p_entries: [{"worker_id": "...", "status": "present" | "absent" | "half_day" | "leave"}]
-- Daily-wage workers get their wage posted to the ledger automatically.
-- Changing a mark later reverses the old wage and posts the new one.
-- ---------------------------------------------------------------------
create function mark_attendance(p_date date, p_entries jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  e        jsonb;
  w        workers;
  v_status attendance_status;
  a        attendance;
  v_want   bigint;
  v_have   bigint;
  v_last   uuid;
  v_n      int := 0;
begin
  if not is_owner() then raise exception 'Only the owner can mark attendance.' using errcode = '42501'; end if;
  if p_date is null or p_date > ist_today() then raise exception 'Attendance cannot be marked for a future date.'; end if;
  if jsonb_typeof(p_entries) is distinct from 'array' then raise exception 'Nothing to save.'; end if;

  for e in select * from jsonb_array_elements(p_entries) loop
    select * into w from workers where id = (e ->> 'worker_id')::uuid;
    if not found then raise exception 'Worker not found.'; end if;
    begin
      v_status := (e ->> 'status')::attendance_status;
    exception when others then
      raise exception 'Unknown attendance mark for %.', w.name;
    end;
    if v_status is null then raise exception 'Unknown attendance mark for %.', w.name; end if;

    select * into a from attendance where worker_id = w.id and att_date = p_date;
    if found and a.status = v_status then
      continue;                                    -- nothing changed
    elsif found then
      update attendance set status = v_status, marked_by = auth.uid() where id = a.id returning * into a;
    else
      insert into attendance (worker_id, att_date, status) values (w.id, p_date, v_status) returning * into a;
    end if;
    v_n := v_n + 1;

    -- Ledger: what should this day pay vs what is already posted for it?
    v_want := case when w.pay_type = 'daily' then day_wage(w.rate_paise, v_status) else 0 end;
    select coalesce(sum(amount_paise), 0) into v_have from worker_transactions where attendance_id = a.id;
    if v_have <> v_want then
      if v_have <> 0 then
        select id into v_last from worker_transactions
        where attendance_id = a.id and type = 'earned' order by created_at desc, id desc limit 1;
        insert into worker_transactions (worker_id, txn_date, type, amount_paise, attendance_id, reverses_id, note)
        values (w.id, p_date, 'reversal', -v_have, a.id, v_last, 'Attendance changed');
      end if;
      if v_want > 0 then
        insert into worker_transactions (worker_id, txn_date, type, amount_paise, attendance_id, note)
        values (w.id, p_date, 'earned', v_want,
                a.id, case v_status when 'half_day' then 'Half-day wage' else 'Day wage' end);
      end if;
    end if;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- Payments, advances, bonuses, deductions. Amount is always entered as a
-- positive number; the sign is applied here.
-- ---------------------------------------------------------------------
create function add_worker_txn(
  p_worker_id    uuid,
  p_type         text,
  p_amount_paise bigint,
  p_date         date default null,
  p_mode         text default null,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_date date := coalesce(p_date, ist_today());
  v_id   uuid;
begin
  if not is_owner() then raise exception 'Only the owner can record worker payments.' using errcode = '42501'; end if;
  if not exists (select 1 from workers where id = p_worker_id) then raise exception 'Worker not found.'; end if;
  if p_type not in ('payment', 'advance', 'bonus', 'deduction') then raise exception 'Unknown entry type.'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'Enter an amount.'; end if;
  if p_amount_paise > 100000000 then raise exception 'Amount is too large.'; end if;
  if v_date > ist_today() then raise exception 'Date cannot be in the future.'; end if;
  if p_type in ('payment', 'advance') and (p_mode is null or p_mode not in ('cash', 'upi')) then
    raise exception 'Choose cash or UPI.';
  end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'Note is too long.'; end if;

  insert into worker_transactions (worker_id, txn_date, type, amount_paise, mode, note)
  values (p_worker_id, v_date, p_type::worker_txn_type,
          case when p_type = 'bonus' then p_amount_paise else -p_amount_paise end,
          case when p_type in ('payment', 'advance') then p_mode::money_mode end,
          nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Undo a mistaken entry (payment, advance, bonus, deduction or a month's salary).
-- Day wages are undone by changing the attendance instead.
create function reverse_worker_txn(p_txn_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare t worker_transactions;
begin
  if not is_owner() then raise exception 'Only the owner can undo entries.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  select * into t from worker_transactions where id = p_txn_id;
  if not found then raise exception 'Entry not found.'; end if;
  if t.type = 'reversal' then raise exception 'An undo cannot be undone. Add a new entry instead.'; end if;
  if t.attendance_id is not null then raise exception 'To change a day wage, change that day''s attendance.'; end if;
  if exists (select 1 from worker_transactions where reverses_id = t.id) then
    raise exception 'This entry has already been undone.';
  end if;
  insert into worker_transactions (worker_id, txn_date, type, amount_paise, mode, period_month, reverses_id, note)
  values (t.worker_id, ist_today(), 'reversal', -t.amount_paise, t.mode, t.period_month, t.id,
          'Undo: ' || trim(p_reason));
end $$;

-- ---------------------------------------------------------------------
-- Monthly workers: post the month's salary (and any deduction the owner decides).
-- ---------------------------------------------------------------------
create function close_month(
  p_worker_id       uuid,
  p_month           date,
  p_salary_paise    bigint default null,
  p_deduction_paise bigint default 0,
  p_note            text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  w       workers;
  v_month date := date_trunc('month', p_month)::date;
  v_day   date;
  v_sal   bigint;
begin
  if not is_owner() then raise exception 'Only the owner can close a month.' using errcode = '42501'; end if;
  select * into w from workers where id = p_worker_id;
  if not found then raise exception 'Worker not found.'; end if;
  if w.pay_type <> 'monthly' then raise exception '% is paid daily. Wages are added from attendance.', w.name; end if;
  if v_month > date_trunc('month', ist_today())::date then raise exception 'That month has not started yet.'; end if;
  if exists (select 1 from worker_transactions t
             where t.worker_id = w.id and t.period_month = v_month and t.type = 'earned'
               and not exists (select 1 from worker_transactions r where r.reverses_id = t.id)) then
    raise exception 'This month is already closed for %. Undo its salary entry first to redo it.', w.name;
  end if;
  v_sal := coalesce(p_salary_paise, w.rate_paise);
  if v_sal <= 0 then raise exception 'Salary must be more than zero.'; end if;
  if coalesce(p_deduction_paise, 0) < 0 or coalesce(p_deduction_paise, 0) > v_sal then
    raise exception 'Deduction must be between zero and the salary.';
  end if;

  v_day := least((v_month + interval '1 month - 1 day')::date, ist_today());
  insert into worker_transactions (worker_id, txn_date, type, amount_paise, period_month, note)
  values (w.id, v_day, 'earned', v_sal, v_month, 'Salary ' || to_char(v_month, 'Mon YYYY'));
  if coalesce(p_deduction_paise, 0) > 0 then
    insert into worker_transactions (worker_id, txn_date, type, amount_paise, period_month, note)
    values (w.id, v_day, 'deduction', -p_deduction_paise, v_month,
            coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Leave deduction ' || to_char(v_month, 'Mon YYYY')));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- One worker, one month: attendance counts and money movements.
-- The owner can ask about anyone; a worker only about themself.
-- ---------------------------------------------------------------------
create function worker_month(p_worker_id uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  w       workers;
  r       jsonb;
begin
  if not (is_owner() or p_worker_id = my_worker_id()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select * into w from workers where id = p_worker_id;
  if not found then raise exception 'Worker not found.'; end if;

  with tx as (
    -- A reversal counts against the type of the row it undoes.
    select t.amount_paise,
           case when t.type = 'reversal' then o.type else t.type end as kind
    from worker_transactions t
    left join worker_transactions o on o.id = t.reverses_id
    where t.worker_id = w.id and t.txn_date between v_month and v_end
  ), sal as (
    select t.id, t.amount_paise from worker_transactions t
    where t.worker_id = w.id and t.period_month = v_month and t.type = 'earned'
      and not exists (select 1 from worker_transactions x where x.reverses_id = t.id)
    order by t.created_at desc limit 1
  )
  select jsonb_build_object(
    'month', v_month,
    'pay_type', w.pay_type,
    'rate_paise', w.rate_paise,
    'present',  (select count(*) from attendance where worker_id = w.id and att_date between v_month and v_end and status = 'present'),
    'half_day', (select count(*) from attendance where worker_id = w.id and att_date between v_month and v_end and status = 'half_day'),
    'absent',   (select count(*) from attendance where worker_id = w.id and att_date between v_month and v_end and status = 'absent'),
    'leave',    (select count(*) from attendance where worker_id = w.id and att_date between v_month and v_end and status = 'leave'),
    'earned_paise',    (select coalesce(sum(amount_paise), 0) from tx where kind = 'earned'),
    'bonus_paise',     (select coalesce(sum(amount_paise), 0) from tx where kind = 'bonus'),
    'paid_paise',      (select coalesce(-sum(amount_paise), 0) from tx where kind = 'payment'),
    'advance_paise',   (select coalesce(-sum(amount_paise), 0) from tx where kind = 'advance'),
    'deduction_paise', (select coalesce(-sum(amount_paise), 0) from tx where kind = 'deduction'),
    'closed', exists (select 1 from sal),
    'salary_txn_id', (select id from sal),
    'balance_paise', (select coalesce(sum(amount_paise), 0) from worker_transactions where worker_id = w.id)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Current balance per worker. security_invoker = the caller's own access
-- rules apply, so a worker sees only their own row and a cashier sees none.
-- ---------------------------------------------------------------------
create view worker_balances with (security_invoker = true) as
select w.id as worker_id, w.name, w.phone, w.pay_type, w.rate_paise, w.category, w.active, w.profile_id,
       coalesce(sum(t.amount_paise), 0)::bigint as balance_paise,
       max(t.txn_date) filter (where t.type in ('payment', 'advance')) as last_paid_on
from workers w
left join worker_transactions t on t.worker_id = w.id
group by w.id;

revoke all on worker_balances from anon;
grant select on worker_balances to authenticated;

revoke execute on function mark_attendance(date, jsonb)                          from public, anon;
revoke execute on function add_worker_txn(uuid, text, bigint, date, text, text)  from public, anon;
revoke execute on function reverse_worker_txn(uuid, text)                        from public, anon;
revoke execute on function close_month(uuid, date, bigint, bigint, text)         from public, anon;
revoke execute on function worker_month(uuid, date)                              from public, anon;
grant  execute on function mark_attendance(date, jsonb)                          to authenticated;
grant  execute on function add_worker_txn(uuid, text, bigint, date, text, text)  to authenticated;
grant  execute on function reverse_worker_txn(uuid, text)                        to authenticated;
grant  execute on function close_month(uuid, date, bigint, bigint, text)         to authenticated;
grant  execute on function worker_month(uuid, date)                              to authenticated;


-- ===== 0006_orders.sql =====
-- =====================================================================
-- Mushroom Farm app — 0006 bulk / future orders and delivery calendar
-- Run after 0005_workforce.sql.
--
-- Flow: owner saves an order (prices can be special bulk prices) →
-- takes an advance (cash/UPI, counted in that day's cash) → marks it ready →
-- on delivery, "Deliver & bill" makes a normal bill where the advance is
-- already applied, and the customer pays only the balance.
-- All order writes go through the functions below.
-- =====================================================================

alter table order_payments add column client_ref uuid unique;

drop policy orders_insert       on orders;
drop policy orders_update       on orders;
drop policy order_items_insert  on order_items;
drop policy order_items_update  on order_items;
drop policy order_items_delete  on order_items;
drop policy order_payments_insert on order_payments;

-- Advance still held for an order (advances minus refunds).
create function order_net_advance(p_order_id uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)::bigint
  from order_payments where order_id = p_order_id
$$;

-- ---------------------------------------------------------------------
-- Create or edit an order.
-- p_items: [{"product_id": "...", "qty": 10, "price_paise": 5500}]  (price optional = list price)
-- ---------------------------------------------------------------------
create function save_order(
  p_order_id       uuid,
  p_customer_name  text,
  p_customer_phone text,
  p_delivery_date  date,
  p_delivery_note  text,
  p_notes          text,
  p_items          jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          orders;
  v_name     text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_phone    text;
  v_customer uuid;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_price    bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_sub      bigint := 0;
  v_id       uuid;
  v_no       text;
begin
  if not is_owner() then raise exception 'Only the owner can create or change orders.' using errcode = '42501'; end if;
  if v_name is null or length(v_name) > 100 then raise exception 'Enter the customer name.'; end if;
  if p_delivery_date is null then raise exception 'Choose a delivery date.'; end if;
  if length(coalesce(p_delivery_note, '')) > 200 or length(coalesce(p_notes, '')) > 500 then
    raise exception 'Notes are too long.';
  end if;

  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
    if v_customer is null then
      insert into customers (name, phone) values (v_name, v_phone) returning id into v_customer;
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one order.'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    begin
      v_qty := (v_item ->> 'qty')::numeric;
      v_price := coalesce((v_item ->> 'price_paise')::bigint, v_prod.price_paise);
    exception when others then
      raise exception 'Wrong quantity or price for "%".', v_prod.name;
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 or v_qty <> round(v_qty, 3) then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end if;
    if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then raise exception '"%" must be a whole number.', v_prod.name; end if;
    if v_price < 0 or v_price > 100000000 then raise exception 'Wrong price for "%".', v_prod.name; end if;
    v_sub := v_sub + round(v_price * v_qty);
    v_lines := v_lines || jsonb_build_object('product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit,
                                             'price', v_price, 'qty', v_qty, 'line', round(v_price * v_qty));
  end loop;

  if p_order_id is null then
    if p_delivery_date < ist_today() then raise exception 'Delivery date cannot be in the past.'; end if;
    v_no := next_doc_no('OR', ist_today(), 4);
    insert into orders (order_no, customer_id, customer_name, customer_phone, delivery_date, delivery_note, notes, subtotal_paise)
    values (v_no, v_customer, v_name, v_phone, p_delivery_date, nullif(trim(coalesce(p_delivery_note, '')), ''),
            nullif(trim(coalesce(p_notes, '')), ''), v_sub)
    returning id into v_id;
  else
    select * into o from orders where id = p_order_id for update;
    if not found then raise exception 'Order not found.'; end if;
    if o.status in ('delivered', 'cancelled') then raise exception 'A % order cannot be changed.', o.status; end if;
    if order_net_advance(o.id) > v_sub then
      raise exception 'The advance taken (₹%) is more than the new order total. Refund the difference first.',
        to_char(order_net_advance(o.id) / 100.0, 'FM999999990.00');
    end if;
    delete from order_items where order_id = o.id;
    update orders set customer_id = v_customer, customer_name = v_name, customer_phone = v_phone,
                      delivery_date = p_delivery_date, delivery_note = nullif(trim(coalesce(p_delivery_note, '')), ''),
                      notes = nullif(trim(coalesce(p_notes, '')), ''), subtotal_paise = v_sub
    where id = o.id;
    v_id := o.id;
    v_no := o.order_no;
  end if;

  insert into order_items (order_id, product_id, product_name, unit, unit_price_paise, qty, line_total_paise)
  select v_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit,
         (l ->> 'price')::bigint, (l ->> 'qty')::numeric, (l ->> 'line')::bigint
  from jsonb_array_elements(v_lines) l;

  return jsonb_build_object('id', v_id, 'order_no', v_no, 'subtotal_paise', v_sub);
end $$;

-- ---------------------------------------------------------------------
-- Take an advance, or give (part of) it back.
-- ---------------------------------------------------------------------
create function add_order_payment(
  p_order_id     uuid,
  p_kind         text,           -- 'advance' or 'refund'
  p_amount_paise bigint,
  p_mode         text,           -- 'cash' or 'upi'
  p_note         text default null,
  p_client_ref   uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  o     orders;
  v_net bigint;
begin
  if not is_owner() then raise exception 'Only the owner can take or refund advances.' using errcode = '42501'; end if;
  if p_client_ref is not null and exists (select 1 from order_payments where client_ref = p_client_ref) then return; end if;
  if p_kind not in ('advance', 'refund') then raise exception 'Unknown payment type.'; end if;
  if p_mode is null or p_mode not in ('cash', 'upi') then raise exception 'Choose cash or UPI.'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'Enter an amount.'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'Note is too long.'; end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  v_net := order_net_advance(o.id);
  if p_kind = 'advance' then
    if o.status in ('delivered', 'cancelled') then raise exception 'This order is %.', o.status; end if;
    if v_net + p_amount_paise > o.subtotal_paise then
      raise exception 'Advance cannot be more than the order total. At most ₹% more can be taken.',
        to_char((o.subtotal_paise - v_net) / 100.0, 'FM999999990.00');
    end if;
  else
    if o.status = 'delivered' then raise exception 'This order is already billed. Use Returns on the bill instead.'; end if;
    if p_amount_paise > v_net then
      raise exception 'Only ₹% advance is held for this order.', to_char(v_net / 100.0, 'FM999999990.00');
    end if;
  end if;

  insert into order_payments (order_id, kind, mode, amount_paise, note, client_ref)
  values (o.id, p_kind::order_pay_kind, p_mode::money_mode, p_amount_paise, nullif(trim(coalesce(p_note, '')), ''), p_client_ref);

  v_net := order_net_advance(o.id);
  if o.status = 'pending' and v_net > 0 then
    update orders set status = 'advance_paid' where id = o.id;
  elsif o.status = 'advance_paid' and v_net = 0 then
    update orders set status = 'pending' where id = o.id;
  end if;
end $$;

-- Mark an order ready (packed) or not ready.
create function set_order_ready(p_order_id uuid, p_ready boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if not is_owner() then raise exception 'Only the owner can change an order.' using errcode = '42501'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'This order is %.', o.status; end if;
  update orders set status = case when p_ready then 'ready'::order_status
                                  when order_net_advance(o.id) > 0 then 'advance_paid'::order_status
                                  else 'pending'::order_status end
  where id = o.id;
end $$;

-- Cancel. If an advance is held, either refund it (choose cash/UPI) or keep it (p_refund_mode null).
create function cancel_order(p_order_id uuid, p_reason text, p_refund_mode text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  o     orders;
  v_net bigint;
begin
  if not is_owner() then raise exception 'Only the owner can cancel an order.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'This order is already %.', o.status; end if;
  v_net := order_net_advance(o.id);
  if v_net > 0 and p_refund_mode is not null then
    if p_refund_mode not in ('cash', 'upi') then raise exception 'Refund must be cash or UPI.'; end if;
    insert into order_payments (order_id, kind, mode, amount_paise, note)
    values (o.id, 'refund', p_refund_mode::money_mode, v_net, 'Refund on cancel');
  end if;
  update orders set status = 'cancelled',
                    cancel_reason = trim(p_reason) || case when v_net > 0 and p_refund_mode is null
                                                           then ' (advance kept)' else '' end
  where id = o.id;
end $$;

-- ---------------------------------------------------------------------
-- Deliver & bill: makes a normal bill at the order's prices.
-- The advance is applied automatically; p_payments covers only the balance.
-- Cashiers can do this for today's deliveries; the owner for any.
-- ---------------------------------------------------------------------
create function convert_order_to_bill(p_order_id uuid, p_payments jsonb, p_client_ref uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  o          orders;
  v_existing bills;
  i          order_items;
  v_gst      int;
  v_gross    bigint;
  v_tax      bigint;
  v_line     bigint;
  v_sub      bigint := 0;
  v_taxsum   bigint := 0;
  v_total    bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_adv      bigint;
  v_due      bigint;
  v_pay      jsonb;
  v_paysum   bigint := 0;
  v_today    date := ist_today();
  v_bill_id  uuid;
  v_bill_no  text;
  v_token    text;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can bill an order.' using errcode = '42501'; end if;
  if p_client_ref is not null then
    select * into v_existing from bills where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'bill_no', v_existing.bill_no,
                                'share_token', v_existing.share_token, 'duplicate', true);
    end if;
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status = 'delivered' then raise exception 'This order is already billed.'; end if;
  if o.status = 'cancelled' then raise exception 'This order was cancelled.'; end if;
  if not is_owner() and o.delivery_date <> v_today then
    raise exception 'Cashiers can only bill orders due today.';
  end if;

  select * into s from app_settings where id;
  for i in select * from order_items where order_id = o.id order by created_at, id loop
    select coalesce(gst_rate_bp, 0) into v_gst from products where id = i.product_id;
    v_gross := i.line_total_paise;
    if s.prices_include_gst then
      v_tax := round(v_gross * v_gst / (10000.0 + v_gst));
      v_line := v_gross;
    else
      v_tax := round(v_gross * v_gst / 10000.0);
      v_line := v_gross + v_tax;
    end if;
    v_sub := v_sub + v_gross;
    v_taxsum := v_taxsum + v_tax;
    v_total := v_total + v_line;
    v_lines := v_lines || jsonb_build_object('product_id', i.product_id, 'name', i.product_name, 'unit', i.unit,
      'price', i.unit_price_paise, 'qty', i.qty, 'gst', v_gst, 'tax', v_tax, 'line', v_line);
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'This order has no items.'; end if;

  v_adv := order_net_advance(o.id);
  if v_adv > v_total then
    raise exception 'The advance (₹%) is more than the bill (₹%). Refund ₹% from the order first.',
      to_char(v_adv / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00'),
      to_char((v_adv - v_total) / 100.0, 'FM999999990.00');
  end if;
  v_due := v_total - v_adv;

  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then raise exception 'Payment is missing.'; end if;
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if (v_pay ->> 'mode') is null or (v_pay ->> 'mode') not in ('cash', 'upi') then raise exception 'Payment must be cash or UPI.'; end if;
    if coalesce((v_pay ->> 'amount_paise')::bigint, 0) <= 0 then raise exception 'Payment amounts must be more than zero.'; end if;
    v_paysum := v_paysum + (v_pay ->> 'amount_paise')::bigint;
  end loop;
  if v_paysum <> v_due then
    raise exception 'Balance to collect is ₹%, but payments add up to ₹%.',
      to_char(v_due / 100.0, 'FM999999990.00'), to_char(v_paysum / 100.0, 'FM999999990.00');
  end if;

  v_bill_no := next_doc_no(s.bill_prefix, v_today, 6);
  insert into bills (bill_no, business_date, customer_id, customer_name, customer_phone, subtotal_paise,
                     discount_paise, tax_paise, total_paise, order_id, client_ref)
  values (v_bill_no, v_today, o.customer_id, o.customer_name, o.customer_phone, v_sub, 0, v_taxsum, v_total,
          o.id, p_client_ref)
  returning id, share_token into v_bill_id, v_token;

  insert into bill_items (bill_id, product_id, product_name, unit, unit_price_paise, qty, gst_rate_bp, tax_paise, line_total_paise)
  select v_bill_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit, (l ->> 'price')::bigint,
         (l ->> 'qty')::numeric, (l ->> 'gst')::int, (l ->> 'tax')::bigint, (l ->> 'line')::bigint
  from jsonb_array_elements(v_lines) l;

  if v_adv > 0 then
    insert into payments (bill_id, mode, amount_paise, business_date, reference)
    values (v_bill_id, 'advance', v_adv, v_today, o.order_no);
  end if;
  insert into payments (bill_id, mode, amount_paise, business_date)
  select v_bill_id, (p ->> 'mode')::pay_mode, (p ->> 'amount_paise')::bigint, v_today
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) p;

  update orders set status = 'delivered', bill_id = v_bill_id where id = o.id;

  return jsonb_build_object('id', v_bill_id, 'bill_no', v_bill_no, 'share_token', v_token,
                            'total_paise', v_total, 'advance_paise', v_adv, 'duplicate', false);
end $$;

-- A bill made from an order holds that order's advance, so it is not voided;
-- use Returns on it instead.
create or replace function void_bill(p_bill_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_coupon uuid;
begin
  if not is_owner() then raise exception 'Only the owner can void a bill.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  if exists (select 1 from returns where bill_id = p_bill_id) then
    raise exception 'This bill has returns. It cannot be voided.';
  end if;
  if exists (select 1 from bills where id = p_bill_id and order_id is not null) then
    raise exception 'This bill came from an order with an advance. Use Returns instead of cancelling it.';
  end if;
  update bills set status = 'void', void_reason = trim(p_reason), voided_by = auth.uid(), voided_at = now()
  where id = p_bill_id and status = 'active'
  returning coupon_id into v_coupon;
  if not found then raise exception 'Bill not found or already void.'; end if;
  if v_coupon is not null then
    update coupons set used_count = greatest(used_count - 1, 0) where id = v_coupon;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Orders with advance held and balance due. Caller's own access rules apply.
-- ---------------------------------------------------------------------
create view order_overview with (security_invoker = true) as
select o.id, o.order_no, o.customer_id, o.customer_name, o.customer_phone, o.delivery_date, o.delivery_note,
       o.status, o.subtotal_paise, o.notes, o.cancel_reason, o.bill_id, o.created_at,
       coalesce(p.net, 0)::bigint as advance_paise,
       case when o.status in ('delivered', 'cancelled') then 0
            else o.subtotal_paise - coalesce(p.net, 0) end::bigint as balance_paise,
       (select count(*) from order_items i where i.order_id = o.id)::int as item_count
from orders o
left join lateral (
  select sum(case when kind = 'advance' then amount_paise else -amount_paise end) as net
  from order_payments op where op.order_id = o.id
) p on true;

revoke all on order_overview from anon;
grant select on order_overview to authenticated;

-- ---------------------------------------------------------------------
-- Cash summary now includes order advances (counted on the day they are taken).
-- ---------------------------------------------------------------------
create or replace function cash_summary(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_owner boolean := is_owner();
  v_date  date;
  v_by    uuid;
  r       jsonb;
begin
  if not is_staff() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  v_date := case when v_owner then coalesce(p_date, ist_today()) else ist_today() end;
  v_by   := case when v_owner then null else auth.uid() end;

  select jsonb_build_object(
    'date', v_date,
    'bills', (select count(*) from bills where business_date = v_date and status = 'active'
              and (v_by is null or created_by = v_by)),
    'sales_paise', (select coalesce(sum(total_paise), 0) from bills where business_date = v_date
                    and status = 'active' and (v_by is null or created_by = v_by)),
    'discount_paise', (select coalesce(sum(discount_paise), 0) from bills where business_date = v_date
                       and status = 'active' and (v_by is null or created_by = v_by)),
    'cash_sales_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                         where p.business_date = v_date and b.status = 'active' and p.mode = 'cash'
                         and (v_by is null or p.created_by = v_by)),
    'upi_sales_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                        where p.business_date = v_date and b.status = 'active' and p.mode = 'upi'
                        and (v_by is null or p.created_by = v_by)),
    'cash_refunds_paise', (select coalesce(sum(amount_paise), 0) from returns where business_date = v_date
                           and refund_mode = 'cash' and (v_by is null or created_by = v_by)),
    'upi_refunds_paise', (select coalesce(sum(amount_paise), 0) from returns where business_date = v_date
                          and refund_mode = 'upi' and (v_by is null or created_by = v_by)),
    'cash_out_paise', (select coalesce(sum(amount_paise), 0) from cash_out where business_date = v_date
                       and not voided and (v_by is null or created_by = v_by)),
    'advance_cash_paise', (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
                           from order_payments where business_date = v_date and mode = 'cash'
                           and (v_by is null or created_by = v_by)),
    'advance_upi_paise', (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
                          from order_payments where business_date = v_date and mode = 'upi'
                          and (v_by is null or created_by = v_by))
  ) into r;

  return r || jsonb_build_object('net_cash_paise',
    (r ->> 'cash_sales_paise')::bigint - (r ->> 'cash_refunds_paise')::bigint
    - (r ->> 'cash_out_paise')::bigint + (r ->> 'advance_cash_paise')::bigint);
end $$;

revoke execute on function order_net_advance(uuid)                                   from public, anon, authenticated;
revoke execute on function save_order(uuid, text, text, date, text, text, jsonb)     from public, anon;
revoke execute on function add_order_payment(uuid, text, bigint, text, text, uuid)   from public, anon;
revoke execute on function set_order_ready(uuid, boolean)                            from public, anon;
revoke execute on function cancel_order(uuid, text, text)                            from public, anon;
revoke execute on function convert_order_to_bill(uuid, jsonb, uuid)                  from public, anon;
grant  execute on function save_order(uuid, text, text, date, text, text, jsonb)     to authenticated;
grant  execute on function add_order_payment(uuid, text, bigint, text, text, uuid)   to authenticated;
grant  execute on function set_order_ready(uuid, boolean)                            to authenticated;
grant  execute on function cancel_order(uuid, text, text)                            to authenticated;
grant  execute on function convert_order_to_bill(uuid, jsonb, uuid)                  to authenticated;


-- ===== 0007_reports.sql =====
-- =====================================================================
-- Mushroom Farm app — 0007 dashboard, report data, custom report time & email list
-- Run after 0006_orders.sql. (supabase/schedule/1-report-timer.sql then switches on the timer.)
-- =====================================================================

-- ---------- Report settings (owner edits these in the app) ----------
create function valid_email_list(p text[]) returns boolean
language sql immutable as $$
  select coalesce(cardinality(p), 0) <= 10
     and not exists (select 1 from unnest(coalesce(p, '{}')) e
                     where e !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' or length(e) > 120)
$$;

alter table app_settings
  add column report_enabled boolean not null default true,
  add column report_time    time    not null default '19:00'
    check (extract(minute from report_time)::int % 15 = 0 and extract(second from report_time) = 0),
  add column report_emails  text[]  not null default '{}' check (valid_email_list(report_emails));

update app_settings set report_emails = array[report_email] where report_email is not null and report_email <> '';

-- Where the timer sends its request. Only readable by the database itself (no policies).
create table app_secrets (
  id                   boolean primary key default true check (id),
  report_function_url  text,
  cron_secret          text
);
insert into app_secrets (id) values (true);
alter table app_secrets enable row level security;
revoke all on app_secrets from anon, authenticated;

-- ---------- Totals for a date range (IST business dates) ----------
-- SECURITY INVOKER: the caller's own access rules apply (owner sees all).
create function range_totals(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare r jsonb;
begin
  select jsonb_build_object(
    'bills',            (select count(*) from bills where business_date between p_from and p_to and status = 'active'),
    'void_bills',       (select count(*) from bills where business_date between p_from and p_to and status = 'void'),
    'sales_paise',      (select coalesce(sum(total_paise), 0) from bills where business_date between p_from and p_to and status = 'active'),
    'discount_paise',   (select coalesce(sum(discount_paise), 0) from bills where business_date between p_from and p_to and status = 'active'),
    'tax_paise',        (select coalesce(sum(tax_paise), 0) from bills where business_date between p_from and p_to and status = 'active'),
    'cash_sales_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                         where p.business_date between p_from and p_to and b.status = 'active' and p.mode = 'cash'),
    'upi_sales_paise',  (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                         where p.business_date between p_from and p_to and b.status = 'active' and p.mode = 'upi'),
    'advance_used_paise', (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
                         where p.business_date between p_from and p_to and b.status = 'active' and p.mode = 'advance'),
    'returns_paise',    (select coalesce(sum(amount_paise), 0) from returns where business_date between p_from and p_to),
    'cash_refunds_paise', (select coalesce(sum(amount_paise), 0) from returns where business_date between p_from and p_to and refund_mode = 'cash'),
    'upi_refunds_paise',  (select coalesce(sum(amount_paise), 0) from returns where business_date between p_from and p_to and refund_mode = 'upi'),
    'cash_out_paise',   (select coalesce(sum(amount_paise), 0) from cash_out where business_date between p_from and p_to and not voided),
    'advance_cash_paise', (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
                           from order_payments where business_date between p_from and p_to and mode = 'cash'),
    'advance_upi_paise',  (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
                           from order_payments where business_date between p_from and p_to and mode = 'upi'),
    'worker_paid_paise',  (select coalesce(-sum(amount_paise), 0) from worker_transactions
                           where txn_date between p_from and p_to and type in ('payment', 'advance'))
  ) into r;
  return r || jsonb_build_object(
    'net_cash_paise', (r ->> 'cash_sales_paise')::bigint - (r ->> 'cash_refunds_paise')::bigint
                      - (r ->> 'cash_out_paise')::bigint + (r ->> 'advance_cash_paise')::bigint,
    'net_sales_paise', (r ->> 'sales_paise')::bigint - (r ->> 'returns_paise')::bigint);
end $$;

-- ---------- Dashboard (owner) ----------
create function dashboard(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
begin
  if not is_owner() then raise exception 'Only the owner can see reports.' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'Choose a range of up to 400 days.'; end if;
  return jsonb_build_object(
    'totals', range_totals(p_from, p_to),
    'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d::date, 'sales_paise', coalesce(s.sales, 0),
                                                            'bills', coalesce(s.n, 0)) order by d), '[]'::jsonb)
               from generate_series(p_from, p_to, interval '1 day') d
               left join (select business_date, sum(total_paise) sales, count(*) n from bills
                          where business_date between p_from and p_to and status = 'active'
                          group by business_date) s on s.business_date = d::date),
    'top_products', (select coalesce(jsonb_agg(t order by t.amount_paise desc), '[]'::jsonb) from (
                       select i.product_name as name, i.unit, sum(i.qty) as qty, sum(i.line_total_paise) as amount_paise
                       from bill_items i join bills b on b.id = i.bill_id
                       where b.business_date between p_from and p_to and b.status = 'active'
                       group by i.product_name, i.unit order by sum(i.line_total_paise) desc limit 10) t)
  );
end $$;

-- ---------- Everything the Excel report needs, ready to turn into sheets ----------
-- Column names here become the column headings in Excel. Amounts are in rupees.
create function report_data(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  t   jsonb;
  rs  numeric := 100.0;
begin
  -- The owner (from the app) or the report Edge Function (service key) only.
  if not (is_owner() or current_user = 'service_role') then
    raise exception 'Only the owner can download reports.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'Choose a range of up to 400 days.'; end if;
  t := range_totals(p_from, p_to);
  return jsonb_build_object(
    'Summary', jsonb_build_array(
      jsonb_build_object('Item', 'Period', 'Value', to_char(p_from, 'DD Mon YYYY') || ' to ' || to_char(p_to, 'DD Mon YYYY')),
      jsonb_build_object('Item', 'Bills', 'Value', t -> 'bills'),
      jsonb_build_object('Item', 'Cancelled (void) bills', 'Value', t -> 'void_bills'),
      jsonb_build_object('Item', 'Sales ₹', 'Value', (t ->> 'sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Discounts ₹', 'Value', (t ->> 'discount_paise')::bigint / rs),
      jsonb_build_object('Item', 'GST in sales ₹', 'Value', (t ->> 'tax_paise')::bigint / rs),
      jsonb_build_object('Item', 'Returns / refunds ₹', 'Value', (t ->> 'returns_paise')::bigint / rs),
      jsonb_build_object('Item', 'Net sales ₹', 'Value', (t ->> 'net_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash sales ₹', 'Value', (t ->> 'cash_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'UPI sales ₹', 'Value', (t ->> 'upi_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Paid from order advances ₹', 'Value', (t ->> 'advance_used_paise')::bigint / rs),
      jsonb_build_object('Item', 'Order advances taken (cash) ₹', 'Value', (t ->> 'advance_cash_paise')::bigint / rs),
      jsonb_build_object('Item', 'Order advances taken (UPI) ₹', 'Value', (t ->> 'advance_upi_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash refunds ₹', 'Value', (t ->> 'cash_refunds_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash out ₹', 'Value', (t ->> 'cash_out_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash that should be in hand ₹', 'Value', (t ->> 'net_cash_paise')::bigint / rs),
      jsonb_build_object('Item', 'Paid to workers ₹', 'Value', (t ->> 'worker_paid_paise')::bigint / rs)
    ),
    'Bills', (select coalesce(jsonb_agg(jsonb_build_object(
        'Bill no', b.bill_no,
        'Date & time', to_char(b.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Customer', coalesce(b.customer_name, ''),
        'Mobile', coalesce(b.customer_phone, ''),
        'Subtotal ₹', b.subtotal_paise / rs,
        'Discount ₹', b.discount_paise / rs,
        'GST ₹', b.tax_paise / rs,
        'Total ₹', b.total_paise / rs,
        'Paid by', (select string_agg(initcap(p.mode::text) || ' ' || to_char(p.amount_paise / rs, 'FM9999999990.00'), ', ')
                    from payments p where p.bill_id = b.id),
        'Coupon', coalesce((select code from coupons c where c.id = b.coupon_id), ''),
        'Order', coalesce((select order_no from orders o where o.id = b.order_id), ''),
        'Status', case when b.status = 'void' then 'VOID: ' || coalesce(b.void_reason, '') else 'OK' end,
        'Made by', coalesce((select full_name from profiles pr where pr.id = b.created_by), '')
      ) order by b.created_at), '[]'::jsonb)
      from bills b where b.business_date between p_from and p_to),
    'Items sold', (select coalesce(jsonb_agg(jsonb_build_object(
        'Product', x.product_name, 'Unit', x.unit, 'Quantity', x.qty, 'Amount ₹', x.amount / rs,
        'Returned qty', x.ret_qty, 'Returned ₹', x.ret_amount / rs) order by x.amount desc), '[]'::jsonb)
      from (select i.product_name, i.unit::text as unit, sum(i.qty) qty, sum(i.line_total_paise) amount,
                   coalesce(sum(r.q), 0) ret_qty, coalesce(sum(r.a), 0) ret_amount
            from bill_items i join bills b on b.id = i.bill_id
            left join lateral (select sum(ri.qty) q, sum(ri.amount_paise) a from return_items ri
                               join returns rt on rt.id = ri.return_id
                               where ri.bill_item_id = i.id and rt.business_date between p_from and p_to) r on true
            where b.business_date between p_from and p_to and b.status = 'active'
            group by i.product_name, i.unit) x),
    'Payments by mode', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date', to_char(d, 'DD-MM-YYYY'), 'Cash ₹', y.cash / rs, 'UPI ₹', y.upi / rs,
        'From advance ₹', y.adv / rs, 'Total ₹', (y.cash + y.upi + y.adv) / rs) order by d), '[]'::jsonb)
      from (select p.business_date d,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'cash'), 0) cash,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'upi'), 0) upi,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'advance'), 0) adv
            from payments p join bills b on b.id = p.bill_id
            where p.business_date between p_from and p_to and b.status = 'active'
            group by p.business_date) y),
    'Returns', (select coalesce(jsonb_agg(jsonb_build_object(
        'Return no', r.return_no,
        'Date & time', to_char(r.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Bill no', b.bill_no,
        'Items', (select string_agg(i.product_name || ' × ' || ri.qty::text, ', ')
                  from return_items ri join bill_items i on i.id = ri.bill_item_id where ri.return_id = r.id),
        'Refund ₹', r.amount_paise / rs, 'Refund by', initcap(r.refund_mode::text), 'Reason', coalesce(r.reason, '')
      ) order by r.created_at), '[]'::jsonb)
      from returns r join bills b on b.id = r.bill_id where r.business_date between p_from and p_to),
    'Cash out', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date & time', to_char(c.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Amount ₹', c.amount_paise / rs, 'Reason', c.reason, 'Taken by', c.taken_by,
        'Status', case when c.voided then 'CANCELLED: ' || coalesce(c.void_reason, '') else 'OK' end
      ) order by c.created_at), '[]'::jsonb)
      from cash_out c where c.business_date between p_from and p_to),
    'Coupons used', (select coalesce(jsonb_agg(jsonb_build_object(
        'Coupon', z.code, 'Bills', z.n, 'Discount given ₹', z.disc / rs) order by z.disc desc), '[]'::jsonb)
      from (select c.code, count(*) n, sum(b.discount_paise) disc from bills b join coupons c on c.id = b.coupon_id
            where b.business_date between p_from and p_to and b.status = 'active' group by c.code) z),
    'Order advances', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date', to_char(op.business_date, 'DD-MM-YYYY'), 'Order no', o.order_no, 'Customer', o.customer_name,
        'Type', initcap(op.kind::text), 'Mode', initcap(op.mode::text), 'Amount ₹', op.amount_paise / rs
      ) order by op.created_at), '[]'::jsonb)
      from order_payments op join orders o on o.id = op.order_id where op.business_date between p_from and p_to)
  );
end $$;

-- ---------- The timer's check (runs every 15 minutes, see supabase/schedule/1-report-timer.sql) ----------
-- Sends today's report once, at or after the owner's chosen time, to the email list.
create function report_tick() returns text
language plpgsql security definer set search_path = public as $$
declare
  s       app_settings;
  sec     app_secrets;
  v_now   timestamp := now() at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_id    uuid;
begin
  select * into s from app_settings where id;
  if not s.report_enabled or cardinality(s.report_emails) = 0 then return 'off'; end if;
  if v_now::time < s.report_time then return 'not yet'; end if;
  if exists (select 1 from report_runs where kind = 'daily' and from_date = v_today
             and (status = 'done' or (status = 'running' and created_at > now() - interval '30 minutes'))) then
    return 'already sent';
  end if;
  if (select count(*) from report_runs where kind = 'daily' and from_date = v_today) >= 3 then
    return 'gave up after 3 tries';
  end if;
  select * into sec from app_secrets where id;
  if sec.report_function_url is null or sec.cron_secret is null then return 'not set up'; end if;

  insert into report_runs (kind, from_date, to_date, status) values ('daily', v_today, v_today, 'running')
  returning id into v_id;
  perform net.http_post(
    url := sec.report_function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', sec.cron_secret),
    body := jsonb_build_object('run_id', v_id, 'date', v_today),
    timeout_milliseconds := 60000);
  return 'sent';
end $$;

revoke execute on function report_tick()                 from public, anon, authenticated;
revoke execute on function range_totals(date, date)      from public, anon;
revoke execute on function dashboard(date, date)         from public, anon;
revoke execute on function report_data(date, date)       from public, anon;
grant  execute on function range_totals(date, date)      to authenticated;
grant  execute on function dashboard(date, date)         to authenticated;
grant  execute on function report_data(date, date)       to authenticated;


-- ===== 0008_backups.sql =====
-- =====================================================================
-- Mushroom Farm app — 0008 nightly backup
-- Run after 0007_reports.sql. Then run supabase/schedule/2-backup-timer.sql.
--
-- Every night the "report" Edge Function copies every table into one Excel
-- file, keeps the last 30 in Supabase Storage, and on Sundays emails it to
-- the report email list. (For a full off-site copy, see docs/DEPLOYMENT.md,
-- "GitHub backup".)
-- =====================================================================

create function backup_tick() returns text
language plpgsql security definer set search_path = public as $$
declare
  sec     app_secrets;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_id    uuid;
begin
  if exists (select 1 from report_runs where kind = 'backup' and from_date = v_today
             and (status = 'done' or (status = 'running' and created_at > now() - interval '30 minutes'))) then
    return 'already done';
  end if;
  if (select count(*) from report_runs where kind = 'backup' and from_date = v_today) >= 3 then
    return 'gave up after 3 tries';
  end if;
  select * into sec from app_secrets where id;
  if sec.report_function_url is null or sec.cron_secret is null then return 'not set up'; end if;

  insert into report_runs (kind, from_date, to_date, status) values ('backup', v_today, v_today, 'running')
  returning id into v_id;
  perform net.http_post(
    url := sec.report_function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', sec.cron_secret),
    body := jsonb_build_object('run_id', v_id, 'date', v_today, 'kind', 'backup'),
    timeout_milliseconds := 120000);
  return 'sent';
end $$;

revoke execute on function backup_tick() from public, anon, authenticated;


-- ===== 0009_grants.sql =====
-- =====================================================================
-- Mushroom Farm app — 0009 explicit access grants
-- Run after 0008_backups.sql.
--
-- Newer Supabase projects no longer give the app's roles automatic access to
-- new tables and functions. Without this file, every logged-in user is refused
-- (the app then says "account is disabled"). This file grants access explicitly.
-- It does NOT loosen security: Row Level Security on every table still
-- decides exactly what each user can see or change, as before.
-- =====================================================================

grant usage on schema public to anon, authenticated, service_role;

-- ---------- Tables and views ----------
-- Logged-in users may *ask*; the RLS policies decide what is allowed.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
-- The server functions (service key) need full access (they bypass RLS by design).
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
-- Still true after this file: visitors who are not logged in can read no table at all,
-- and nobody (not even the owner) can read the timer's secret.
revoke all on all tables in schema public from anon;
revoke all on app_secrets from authenticated;

-- ---------- Functions ----------
grant execute on all functions in schema public to authenticated, service_role;
-- Internal helpers stay closed to the app (they run only inside other functions or timers).
revoke execute on function next_doc_no(text, date, int)             from authenticated;
revoke execute on function price_bill(jsonb, text, text, boolean)   from authenticated;
revoke execute on function order_net_advance(uuid)                  from authenticated;
revoke execute on function bootstrap_owner(text, text)              from authenticated, service_role;
revoke execute on function report_tick()                            from authenticated;
revoke execute on function backup_tick()                            from authenticated;
revoke execute on function audit_row()                              from authenticated;
revoke execute on function forbid_change()                          from authenticated;
revoke execute on function guard_bill_update()                      from authenticated;
revoke execute on function guard_cash_out_update()                  from authenticated;
revoke execute on function set_updated_at()                         from authenticated;
-- Visitors who are not logged in may only open a shared bill link.
revoke execute on all functions in schema public from anon, public;
grant execute on function get_public_bill(text) to anon;

-- ---------- Future additions behave the same way ----------
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant execute on functions to authenticated, service_role;


-- ===== 0010_sell_by_amount.sql =====
-- =====================================================================
-- Mushroom Farm app — 0010 sell weighed items by amount ("₹100 worth")
-- Run after 0009_grants.sql.
--
-- A bill line for a kg product may now give "amount_paise" instead of "qty".
-- The customer pays exactly that amount; the weight to hand over is worked
-- out from the database price (rounded to the gram) and printed on the bill.
-- Packets and pieces still need a whole-number quantity.
-- Everything else (coupons, GST, returns) works exactly as before.
-- (CREATE OR REPLACE keeps the function's existing permissions.)
-- =====================================================================

create or replace function price_bill(p_items jsonb, p_coupon_code text, p_customer_phone text, p_lock boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_amt      bigint;
  v_gross    bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_line     jsonb;
  v_sub      bigint := 0;
  v_code     text := upper(nullif(trim(coalesce(p_coupon_code, '')), ''));
  v_coupon   coupons;
  v_phone    text;
  v_customer uuid;
  v_elig     boolean;
  v_eligible bigint := 0;
  v_disc     bigint := 0;
  v_left     bigint;
  v_share    bigint;
  v_last     int := -1;
  v_net      bigint;
  v_tax      bigint;
  v_taxsum   bigint := 0;
  v_total    bigint := 0;
  i          int;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one bill.'; end if;
  select * into s from app_settings where id;

  -- Customer mobile (optional)
  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
  end if;

  -- Coupon (optional)
  if v_code is not null then
    if p_lock then
      select * into v_coupon from coupons where code = v_code for update;
    else
      select * into v_coupon from coupons where code = v_code;
    end if;
    if not found then raise exception 'Coupon "%" not found.', v_code; end if;
    if not v_coupon.active then raise exception 'Coupon "%" is switched off.', v_code; end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
      raise exception 'Coupon "%" has not started yet.', v_code;
    end if;
    if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
      raise exception 'Coupon "%" has expired.', v_code;
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'Coupon "%" has been fully used.', v_code;
    end if;
    if v_coupon.customer_id is not null and v_coupon.customer_id is distinct from v_customer then
      raise exception 'Coupon "%" is for one customer only. Enter that customer''s mobile number.', v_code;
    end if;
  end if;

  -- 1. Price each line from the database.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    if v_prod.archived_at is not null then raise exception '"%" is no longer sold.', v_prod.name; end if;

    if v_item ? 'amount_paise' then
      -- NEW: "₹100 worth" of a weighed product.
      if v_prod.unit <> 'kg' then
        raise exception '"%" is sold per %, so enter how many, not an amount.', v_prod.name, v_prod.unit;
      end if;
      begin
        v_amt := (v_item ->> 'amount_paise')::bigint;
      exception when others then
        raise exception 'Wrong amount for "%".', v_prod.name;
      end;
      if v_amt is null or v_amt <= 0 or v_amt > 100000000 then raise exception 'Wrong amount for "%".', v_prod.name; end if;
      if v_prod.price_paise <= 0 then raise exception '"%" has no price set.', v_prod.name; end if;
      v_qty := round(v_amt::numeric / v_prod.price_paise, 3);
      if v_qty <= 0 then raise exception 'That amount is too small for "%" (less than 1 gram).', v_prod.name; end if;
      if v_qty > 10000 then raise exception 'Wrong amount for "%".', v_prod.name; end if;
      v_gross := v_amt;                     -- the customer pays exactly what they asked for
    else
      begin
        v_qty := (v_item ->> 'qty')::numeric;
      exception when others then
        raise exception 'Wrong quantity for "%".', v_prod.name;
      end;
      if v_qty is null or v_qty <= 0 or v_qty > 10000 or v_qty <> round(v_qty, 3) then
        raise exception 'Wrong quantity for "%".', v_prod.name;
      end if;
      if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then
        raise exception '"%" must be a whole number.', v_prod.name;
      end if;
      v_gross := round(v_prod.price_paise * v_qty);
    end if;

    v_elig := v_code is not null and (v_coupon.applies_to = 'all' or exists (
                select 1 from coupon_products cp where cp.coupon_id = v_coupon.id and cp.product_id = v_prod.id));
    v_sub := v_sub + v_gross;
    if v_elig then
      v_eligible := v_eligible + v_gross;
      v_last := jsonb_array_length(v_lines);
    end if;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit, 'price', v_prod.price_paise,
      'qty', v_qty, 'gst', v_prod.gst_rate_bp, 'gross', v_gross, 'eligible', v_elig);
  end loop;

  -- 2. Coupon discount, shared across the eligible lines.
  if v_code is not null then
    if v_eligible = 0 then raise exception 'Coupon "%" does not apply to these products.', v_code; end if;
    if v_sub < v_coupon.min_bill_paise then
      raise exception 'Coupon "%" needs a bill of at least ₹%.', v_code,
        to_char(v_coupon.min_bill_paise / 100.0, 'FM999999990.00');
    end if;
    v_disc := case when v_coupon.kind = 'percent'
                   then round(v_eligible * v_coupon.value / 10000.0)
                   else least(v_coupon.value, v_eligible) end;
  end if;

  v_left := v_disc;
  for i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_line := v_lines -> i;
    v_gross := (v_line ->> 'gross')::bigint;
    if (v_line ->> 'eligible')::boolean then
      v_share := case when i = v_last then v_left else (v_gross * v_disc) / v_eligible end;
      v_left := v_left - v_share;
    else
      v_share := 0;
    end if;
    v_net := v_gross - v_share;
    if s.prices_include_gst then
      v_tax := round(v_net * (v_line ->> 'gst')::int / (10000.0 + (v_line ->> 'gst')::int));
    else
      v_tax := round(v_net * (v_line ->> 'gst')::int / 10000.0);
      v_net := v_net + v_tax;
    end if;
    v_taxsum := v_taxsum + v_tax;
    v_total := v_total + v_net;
    v_out := v_out || (v_line || jsonb_build_object('discount', v_share, 'tax', v_tax, 'line', v_net));
  end loop;

  return jsonb_build_object(
    'lines', v_out, 'subtotal_paise', v_sub, 'discount_paise', v_disc, 'tax_paise', v_taxsum,
    'total_paise', v_total, 'coupon_id', v_coupon.id, 'coupon_code', v_code,
    'customer_phone', v_phone, 'customer_id', v_customer);
end $$;


-- ===== 0011_bargain_colors.sql =====
-- =====================================================================
-- Mushroom Farm app — 0011 bargain price, product colours and sections
-- Run after 0010_sell_by_amount.sql.
--
-- 1. Bargain: a bill line may carry "price_paise" = the rate agreed with the
--    customer for this bill only (e.g. ₹160/kg instead of ₹180/kg). The
--    product's own price never changes. Each bill line remembers the normal
--    price in list_price_paise when the rate was different, so the owner can
--    always see which bills were bargained and by how much.
--    The owner can stop cashiers from bargaining (Settings → "Cashiers can
--    bargain"); the owner can always bargain.
-- 2. Products get a colour and a section (e.g. "Fresh", "Dry", "Spawn") so the
--    bill screen can group and colour the buttons.
-- (CREATE OR REPLACE keeps the function's existing permissions.)
-- =====================================================================

-- ---------- products: colour + section ---------------------------------------
alter table products
  add column color   text not null default 'gray'
    check (color in ('gray','green','lime','amber','orange','red','pink','purple','blue','teal','brown')),
  add column section text
    check (section is null or length(trim(section)) between 1 and 40);

-- ---------- app_settings: may cashiers bargain? --------------------------------
alter table app_settings add column allow_bargain boolean not null default true;

-- ---------- bill_items: the normal price, when it was bargained --------------
alter table bill_items add column list_price_paise bigint check (list_price_paise is null or list_price_paise >= 0);

create function note_list_price() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_list bigint;
begin
  select price_paise into v_list from products where id = new.product_id;
  new.list_price_paise := case when v_list is distinct from new.unit_price_paise then v_list end;
  return new;
end $$;
revoke execute on function note_list_price() from public, anon, authenticated;

create trigger bill_items_list_price before insert on bill_items
  for each row execute function note_list_price();

-- ---------- price_bill: accepts a bargain rate per line -----------------------
create or replace function price_bill(p_items jsonb, p_coupon_code text, p_customer_phone text, p_lock boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_amt      bigint;
  v_price    bigint;
  v_gross    bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_line     jsonb;
  v_sub      bigint := 0;
  v_code     text := upper(nullif(trim(coalesce(p_coupon_code, '')), ''));
  v_coupon   coupons;
  v_phone    text;
  v_customer uuid;
  v_elig     boolean;
  v_eligible bigint := 0;
  v_disc     bigint := 0;
  v_left     bigint;
  v_share    bigint;
  v_last     int := -1;
  v_net      bigint;
  v_tax      bigint;
  v_taxsum   bigint := 0;
  v_total    bigint := 0;
  i          int;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one bill.'; end if;
  select * into s from app_settings where id;

  -- Customer mobile (optional)
  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
  end if;

  -- Coupon (optional)
  if v_code is not null then
    if p_lock then
      select * into v_coupon from coupons where code = v_code for update;
    else
      select * into v_coupon from coupons where code = v_code;
    end if;
    if not found then raise exception 'Coupon "%" not found.', v_code; end if;
    if not v_coupon.active then raise exception 'Coupon "%" is switched off.', v_code; end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then
      raise exception 'Coupon "%" has not started yet.', v_code;
    end if;
    if v_coupon.expires_at is not null and v_coupon.expires_at < now() then
      raise exception 'Coupon "%" has expired.', v_code;
    end if;
    if v_coupon.usage_limit is not null and v_coupon.used_count >= v_coupon.usage_limit then
      raise exception 'Coupon "%" has been fully used.', v_code;
    end if;
    if v_coupon.customer_id is not null and v_coupon.customer_id is distinct from v_customer then
      raise exception 'Coupon "%" is for one customer only. Enter that customer''s mobile number.', v_code;
    end if;
  end if;

  -- 1. Price each line from the database.
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    if v_prod.archived_at is not null then raise exception '"%" is no longer sold.', v_prod.name; end if;

    -- NEW: bargain. The cashier may agree a different rate for THIS bill only.
    -- The product's normal price is not changed; bill_items keeps both rates.
    v_price := v_prod.price_paise;
    if v_item ? 'price_paise' then
      begin
        v_price := (v_item ->> 'price_paise')::bigint;
      exception when others then
        raise exception 'Wrong bargain price for "%".', v_prod.name;
      end;
      if v_price is null or v_price <= 0 or v_price > 10000000 then
        raise exception 'Wrong bargain price for "%".', v_prod.name;
      end if;
      if v_price <> v_prod.price_paise and not s.allow_bargain and not is_owner() then
        raise exception 'Bargain prices are switched off by the owner.';
      end if;
    end if;

    if v_item ? 'amount_paise' then
      -- NEW: "₹100 worth" of a weighed product.
      if v_prod.unit <> 'kg' then
        raise exception '"%" is sold per %, so enter how many, not an amount.', v_prod.name, v_prod.unit;
      end if;
      begin
        v_amt := (v_item ->> 'amount_paise')::bigint;
      exception when others then
        raise exception 'Wrong amount for "%".', v_prod.name;
      end;
      if v_amt is null or v_amt <= 0 or v_amt > 100000000 then raise exception 'Wrong amount for "%".', v_prod.name; end if;
      if v_price <= 0 then raise exception '"%" has no price set.', v_prod.name; end if;
      v_qty := round(v_amt::numeric / v_price, 3);
      if v_qty <= 0 then raise exception 'That amount is too small for "%" (less than 1 gram).', v_prod.name; end if;
      if v_qty > 10000 then raise exception 'Wrong amount for "%".', v_prod.name; end if;
      v_gross := v_amt;                     -- the customer pays exactly what they asked for
    else
      begin
        v_qty := (v_item ->> 'qty')::numeric;
      exception when others then
        raise exception 'Wrong quantity for "%".', v_prod.name;
      end;
      if v_qty is null or v_qty <= 0 or v_qty > 10000 or v_qty <> round(v_qty, 3) then
        raise exception 'Wrong quantity for "%".', v_prod.name;
      end if;
      if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then
        raise exception '"%" must be a whole number.', v_prod.name;
      end if;
      v_gross := round(v_price * v_qty);
    end if;

    v_elig := v_code is not null and (v_coupon.applies_to = 'all' or exists (
                select 1 from coupon_products cp where cp.coupon_id = v_coupon.id and cp.product_id = v_prod.id));
    v_sub := v_sub + v_gross;
    if v_elig then
      v_eligible := v_eligible + v_gross;
      v_last := jsonb_array_length(v_lines);
    end if;
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit, 'price', v_price,
      'qty', v_qty, 'gst', v_prod.gst_rate_bp, 'gross', v_gross, 'eligible', v_elig);
  end loop;

  -- 2. Coupon discount, shared across the eligible lines.
  if v_code is not null then
    if v_eligible = 0 then raise exception 'Coupon "%" does not apply to these products.', v_code; end if;
    if v_sub < v_coupon.min_bill_paise then
      raise exception 'Coupon "%" needs a bill of at least ₹%.', v_code,
        to_char(v_coupon.min_bill_paise / 100.0, 'FM999999990.00');
    end if;
    v_disc := case when v_coupon.kind = 'percent'
                   then round(v_eligible * v_coupon.value / 10000.0)
                   else least(v_coupon.value, v_eligible) end;
  end if;

  v_left := v_disc;
  for i in 0 .. jsonb_array_length(v_lines) - 1 loop
    v_line := v_lines -> i;
    v_gross := (v_line ->> 'gross')::bigint;
    if (v_line ->> 'eligible')::boolean then
      v_share := case when i = v_last then v_left else (v_gross * v_disc) / v_eligible end;
      v_left := v_left - v_share;
    else
      v_share := 0;
    end if;
    v_net := v_gross - v_share;
    if s.prices_include_gst then
      v_tax := round(v_net * (v_line ->> 'gst')::int / (10000.0 + (v_line ->> 'gst')::int));
    else
      v_tax := round(v_net * (v_line ->> 'gst')::int / 10000.0);
      v_net := v_net + v_tax;
    end if;
    v_taxsum := v_taxsum + v_tax;
    v_total := v_total + v_net;
    v_out := v_out || (v_line || jsonb_build_object('discount', v_share, 'tax', v_tax, 'line', v_net));
  end loop;

  return jsonb_build_object(
    'lines', v_out, 'subtotal_paise', v_sub, 'discount_paise', v_disc, 'tax_paise', v_taxsum,
    'total_paise', v_total, 'coupon_id', v_coupon.id, 'coupon_code', v_code,
    'customer_phone', v_phone, 'customer_id', v_customer);
end $$;


-- ===== 0012_edit_bills_orders.sql =====
-- =====================================================================
-- Mushroom Farm app — 0012 change a bill after saving; orders for cashiers
-- Run after 0011_bargain_colors.sql.
--
-- 1. Change a saved bill: add or fix the customer name / mobile, and fix
--    how it was paid (e.g. UPI was chosen but the customer paid cash, or a
--    different cash + UPI split). Nothing is deleted: the payment fix is saved
--    as correction lines (−₹135 UPI, +₹135 cash) with the reason, so every
--    total and the cash in hand stay right and the history stays visible.
--    The owner can change any bill; a cashier only their own bills from today.
-- 2. Orders: cashiers can now take and change orders, take advances (cash,
--    UPI or both), give money back, mark ready, cancel, and deliver early or
--    late. A payment taken in the wrong mode can be switched (cash ⇄ UPI).
-- 3. Excel report: new "Cash" sheet (cash from bills and from orders, day by
--    day, like the Cash screen), "Order payments", "Orders" and "Bill changes".
-- =====================================================================

-- ---------- payments: allow correction lines (never edited, only added) ---------
alter table payments drop constraint payments_amount_paise_check;
alter table payments add constraint payments_amount_check
  check (amount_paise <> 0 and (amount_paise > 0 or mode <> 'advance'));

-- ---------- bills: customer fields may change, only through edit_bill() ---------
create or replace function guard_bill_update() returns trigger
language plpgsql as $$
declare allowed text[] := array['status','void_reason','voided_by','voided_at','updated_at'];
begin
  if current_setting('app.bill_edit', true) = 'on' then
    allowed := allowed || array['customer_name','customer_phone','customer_id'];
  end if;
  if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
    raise exception 'A bill cannot be edited. Void it and create a new bill.' using errcode = 'P0001';
  end if;
  if old.status = 'void' then
    raise exception 'This bill is already void.' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Net amount paid per mode, for showing ("Cash ₹100 · UPI ₹35").
create function bill_pay_text(p_bill_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(string_agg(initcap(x.mode::text) || ' ₹' || to_char(x.amt / 100.0, 'FM9999999990.00'), ' · ' order by x.first), '—')
  from (select mode, sum(amount_paise) amt, min(created_at) first from payments
        where bill_id = p_bill_id group by mode having sum(amount_paise) <> 0) x
$$;

-- ---------------------------------------------------------------------
-- Change a saved bill. p_payments null = leave the payment as it is.
-- p_payments: [{"mode": "cash", "amount_paise": 10000}, {"mode": "upi", "amount_paise": 3500}]
-- ---------------------------------------------------------------------
create function edit_bill(
  p_bill_id        uuid,
  p_customer_name  text,
  p_customer_phone text,
  p_payments       jsonb,
  p_reason         text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b          bills;
  v_name     text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_reason   text := nullif(trim(coalesce(p_reason, '')), '');
  v_phone    text;
  v_customer uuid;
  v_coupon   coupons;
  v_pay      jsonb;
  v_mode     text;
  v_amt      bigint;
  v_new_cash bigint := 0;
  v_new_upi  bigint := 0;
  v_old_cash bigint;
  v_old_upi  bigint;
  v_adv      bigint;
  v_before   text;
  v_changed  boolean := false;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can change a bill.' using errcode = '42501'; end if;
  select * into b from bills where id = p_bill_id for update;
  if not found then raise exception 'Bill not found.'; end if;
  if not is_owner() and (b.created_by is distinct from auth.uid() or b.business_date <> ist_today()) then
    raise exception 'Cashiers can change only their own bills from today. Ask the owner.' using errcode = '42501';
  end if;
  if b.status = 'void' then raise exception 'This bill is cancelled (void). It cannot be changed.'; end if;
  if v_name is not null and length(v_name) > 100 then raise exception 'Customer name is too long.'; end if;
  if length(coalesce(v_reason, '')) > 200 then raise exception 'Reason is too long.'; end if;

  v_before := bill_pay_text(b.id) || coalesce(' · ' || b.customer_name, '') || coalesce(' · ' || b.customer_phone, '');

  -- Customer
  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
  end if;
  if v_name is distinct from b.customer_name or v_phone is distinct from b.customer_phone then
    if b.coupon_id is not null then
      select * into v_coupon from coupons where id = b.coupon_id;
      if v_coupon.customer_id is not null and v_customer is distinct from v_coupon.customer_id then
        raise exception 'This bill used a coupon meant for one customer, so its mobile number cannot be changed.';
      end if;
    end if;
    if v_phone is not null and v_customer is null then
      insert into customers (name, phone) values (v_name, v_phone) returning id into v_customer;
    elsif v_customer is not null and v_name is not null then
      update customers set name = v_name where id = v_customer and name is null;
    end if;
    perform set_config('app.bill_edit', 'on', true);
    update bills set customer_name = v_name, customer_phone = v_phone, customer_id = v_customer where id = b.id;
    perform set_config('app.bill_edit', 'off', true);
    v_changed := true;
  end if;

  -- Payment
  if p_payments is not null then
    if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then
      raise exception 'Choose how the bill was paid.';
    end if;
    for v_pay in select * from jsonb_array_elements(p_payments) loop
      v_mode := v_pay ->> 'mode';
      begin
        v_amt := (v_pay ->> 'amount_paise')::bigint;
      exception when others then
        raise exception 'Wrong payment amount.';
      end;
      if v_mode is null or v_mode not in ('cash', 'upi') then raise exception 'Payment must be cash or UPI.'; end if;
      if v_amt is null or v_amt <= 0 then raise exception 'Payment amounts must be more than zero.'; end if;
      if v_mode = 'cash' then v_new_cash := v_new_cash + v_amt; else v_new_upi := v_new_upi + v_amt; end if;
    end loop;
    select coalesce(sum(amount_paise) filter (where mode = 'cash'), 0),
           coalesce(sum(amount_paise) filter (where mode = 'upi'), 0),
           coalesce(sum(amount_paise) filter (where mode = 'advance'), 0)
      into v_old_cash, v_old_upi, v_adv
      from payments where bill_id = b.id;
    if v_new_cash + v_new_upi <> b.total_paise - v_adv then
      raise exception 'Payments (₹%) must add up to ₹%.',
        to_char((v_new_cash + v_new_upi) / 100.0, 'FM999999990.00'),
        to_char((b.total_paise - v_adv) / 100.0, 'FM999999990.00');
    end if;
    if v_new_cash <> v_old_cash or v_new_upi <> v_old_upi then
      if v_reason is null or length(v_reason) < 3 then raise exception 'Please write why the payment is being changed.'; end if;
      -- Correction lines on the bill's own day and cashier, so that day's cash and UPI totals become right.
      insert into payments (bill_id, mode, amount_paise, business_date, reference, created_by)
      select b.id, m::pay_mode, d, b.business_date, 'Changed: ' || v_reason, b.created_by
      from (values ('cash', v_new_cash - v_old_cash), ('upi', v_new_upi - v_old_upi)) x(m, d)
      where d <> 0;
      v_changed := true;
    end if;
  end if;

  if v_changed then
    insert into audit_log (table_name, row_id, action, actor, old_data, new_data)
    values ('bills', b.id::text, 'BILL_EDIT', auth.uid(),
            jsonb_build_object('summary', v_before),
            jsonb_build_object('summary', bill_pay_text(b.id) || coalesce(' · ' || v_name, '') || coalesce(' · ' || v_phone, ''),
                               'reason', coalesce(v_reason, '')));
  end if;
  return jsonb_build_object('changed', v_changed, 'paid', bill_pay_text(b.id));
end $$;

-- ---------- Share link / receipt: show the net paid per mode -------------------
create or replace function get_public_bill(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'bill_no', b.bill_no,
    'created_at', b.created_at,
    'customer_name', b.customer_name,
    'subtotal_paise', b.subtotal_paise,
    'discount_paise', b.discount_paise,
    'tax_paise', b.tax_paise,
    'total_paise', b.total_paise,
    'status', b.status,
    'coupon_code', (select c.code from coupons c where c.id = b.coupon_id),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'name', i.product_name, 'unit', i.unit, 'qty', i.qty,
                'price_paise', i.unit_price_paise, 'gst_rate_bp', i.gst_rate_bp,
                'tax_paise', i.tax_paise, 'line_total_paise', i.line_total_paise)
                order by i.created_at, i.id), '[]'::jsonb)
              from bill_items i where i.bill_id = b.id),
    'payments', (select coalesce(jsonb_agg(jsonb_build_object('mode', x.mode, 'amount_paise', x.amt)
                order by x.first), '[]'::jsonb)
              from (select p.mode, sum(p.amount_paise) amt, min(p.created_at) first from payments p
                    where p.bill_id = b.id group by p.mode having sum(p.amount_paise) <> 0) x),
    'returns', (select coalesce(jsonb_agg(jsonb_build_object('return_no', r.return_no, 'created_at', r.created_at,
                  'amount_paise', r.amount_paise, 'refund_mode', r.refund_mode) order by r.created_at), '[]'::jsonb)
              from returns r where r.bill_id = b.id),
    'farm', (select jsonb_build_object('name', farm_name, 'address', address, 'phone', phone,
                    'gstin', gstin, 'prices_include_gst', prices_include_gst, 'footer', bill_footer)
             from app_settings where id)
  )
  from bills b
  where length(p_token) = 32 and b.share_token = p_token
$$;

-- ---------- Orders: cashiers see every open order --------------------------------
drop policy orders_read on orders;
create policy orders_read on orders for select to authenticated
  using ((select is_owner())
         or ((select my_role()) = 'cashier'
             and (status in ('pending', 'advance_paid', 'ready')
                  or delivery_date = ist_today()
                  or (updated_at at time zone 'Asia/Kolkata')::date = ist_today()))
         or (customer_id is not null and customer_id = (select my_customer_id())));

-- A payment taken in the wrong mode is switched with two new lines; this links them to it.
alter table order_payments add column corrects_id uuid references order_payments (id);

-- ---------------------------------------------------------------------
-- Take money for an order (or give some back), in cash, UPI or both.
-- p_payments: [{"mode": "cash", "amount_paise": 20000}, {"mode": "upi", "amount_paise": 30000}]
-- ---------------------------------------------------------------------
create function take_order_payment(
  p_order_id   uuid,
  p_kind       text,            -- 'advance' (money received) or 'refund' (money given back)
  p_payments   jsonb,
  p_note       text default null,
  p_client_ref uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o      orders;
  v_pay  jsonb;
  v_mode text;
  v_amt  bigint;
  v_sum  bigint := 0;
  v_net  bigint;
  v_ref  uuid := p_client_ref;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can take order payments.' using errcode = '42501'; end if;
  if p_client_ref is not null and exists (select 1 from order_payments where client_ref = p_client_ref) then
    return jsonb_build_object('duplicate', true, 'paid_paise', order_net_advance(p_order_id));
  end if;
  if p_kind not in ('advance', 'refund') then raise exception 'Unknown payment type.'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'Note is too long.'; end if;
  if jsonb_typeof(p_payments) is distinct from 'array' or jsonb_array_length(p_payments) = 0
     or jsonb_array_length(p_payments) > 2 then
    raise exception 'Enter the amount.';
  end if;
  for v_pay in select * from jsonb_array_elements(p_payments) loop
    v_mode := v_pay ->> 'mode';
    begin
      v_amt := (v_pay ->> 'amount_paise')::bigint;
    exception when others then
      raise exception 'Wrong amount.';
    end;
    if v_mode is null or v_mode not in ('cash', 'upi') then raise exception 'Choose cash or UPI.'; end if;
    if v_amt is null or v_amt <= 0 then raise exception 'Enter an amount.'; end if;
    v_sum := v_sum + v_amt;
  end loop;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  v_net := order_net_advance(o.id);
  if p_kind = 'advance' then
    if o.status in ('delivered', 'cancelled') then raise exception 'This order is %.', o.status; end if;
    if v_net + v_sum > o.subtotal_paise then
      raise exception 'That is more than the order total. At most ₹% more can be taken.',
        to_char((o.subtotal_paise - v_net) / 100.0, 'FM999999990.00');
    end if;
  else
    if o.status = 'delivered' then raise exception 'This order is already billed. Use Returns on the bill instead.'; end if;
    if v_sum > v_net then
      raise exception 'Only ₹% has been paid for this order.', to_char(v_net / 100.0, 'FM999999990.00');
    end if;
  end if;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    insert into order_payments (order_id, kind, mode, amount_paise, note, client_ref)
    values (o.id, p_kind::order_pay_kind, (v_pay ->> 'mode')::money_mode, (v_pay ->> 'amount_paise')::bigint,
            nullif(trim(coalesce(p_note, '')), ''), v_ref);
    v_ref := null;   -- the id goes on the first line only
  end loop;

  v_net := order_net_advance(o.id);
  if o.status = 'pending' and v_net > 0 then
    update orders set status = 'advance_paid' where id = o.id;
  elsif o.status = 'advance_paid' and v_net = 0 then
    update orders set status = 'pending' where id = o.id;
  end if;
  return jsonb_build_object('duplicate', false, 'paid_paise', v_net);
end $$;

-- The older one-mode call now does the same thing (and is open to cashiers).
create or replace function add_order_payment(
  p_order_id     uuid,
  p_kind         text,
  p_amount_paise bigint,
  p_mode         text,
  p_note         text default null,
  p_client_ref   uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform take_order_payment(p_order_id, p_kind,
    jsonb_build_array(jsonb_build_object('mode', p_mode, 'amount_paise', p_amount_paise)), p_note, p_client_ref);
end $$;

-- ---------------------------------------------------------------------
-- An order payment was taken as cash but was really UPI (or the other way).
-- Adds two lines (out of the old mode, into the new one) on the same day.
-- ---------------------------------------------------------------------
create function switch_order_payment_mode(p_payment_id uuid, p_reason text, p_client_ref uuid default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  op      order_payments;
  v_new   money_mode;
  v_undo  order_pay_kind;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can change order payments.' using errcode = '42501'; end if;
  if p_client_ref is not null and exists (select 1 from order_payments where client_ref = p_client_ref) then return; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  if length(p_reason) > 200 then raise exception 'Reason is too long.'; end if;
  select * into op from order_payments where id = p_payment_id;
  if not found then raise exception 'Payment not found.'; end if;
  perform 1 from orders where id = op.order_id for update;
  if op.corrects_id is not null then raise exception 'This line is itself a correction. Change the original payment instead.'; end if;
  if exists (select 1 from order_payments where corrects_id = op.id) then
    raise exception 'This payment was already switched.';
  end if;
  if not is_owner() and op.business_date <> ist_today() then
    raise exception 'Cashiers can switch only today''s payments. Ask the owner.' using errcode = '42501';
  end if;
  v_new  := case when op.mode = 'cash' then 'upi'::money_mode else 'cash'::money_mode end;
  v_undo := case when op.kind = 'advance' then 'refund'::order_pay_kind else 'advance'::order_pay_kind end;
  insert into order_payments (order_id, kind, mode, amount_paise, business_date, note, created_by, corrects_id, client_ref)
  values (op.order_id, v_undo, op.mode, op.amount_paise, op.business_date,
          'Switched to ' || upper(v_new::text) || ': ' || trim(p_reason), op.created_by, op.id, p_client_ref),
         (op.order_id, op.kind, v_new, op.amount_paise, op.business_date,
          'Switched from ' || upper(op.mode::text) || ': ' || trim(p_reason), op.created_by, op.id, null);
end $$;

-- ---------- Orders: open to cashiers, delay / early delivery ----------------------
create or replace function save_order(
  p_order_id       uuid,
  p_customer_name  text,
  p_customer_phone text,
  p_delivery_date  date,
  p_delivery_note  text,
  p_notes          text,
  p_items          jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o          orders;
  v_name     text := nullif(trim(coalesce(p_customer_name, '')), '');
  v_phone    text;
  v_customer uuid;
  v_item     jsonb;
  v_prod     products;
  v_qty      numeric;
  v_price    bigint;
  v_lines    jsonb := '[]'::jsonb;
  v_sub      bigint := 0;
  v_id       uuid;
  v_no       text;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can take orders.' using errcode = '42501'; end if;
  if v_name is null or length(v_name) > 100 then raise exception 'Enter the customer name.'; end if;
  if p_delivery_date is null then raise exception 'Choose a delivery date.'; end if;
  if length(coalesce(p_delivery_note, '')) > 200 or length(coalesce(p_notes, '')) > 500 then
    raise exception 'Notes are too long.';
  end if;

  if nullif(trim(coalesce(p_customer_phone, '')), '') is not null then
    v_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
    if length(v_phone) = 10 then v_phone := '91' || v_phone; end if;
    if v_phone !~ '^91[6-9][0-9]{9}$' then raise exception 'Customer mobile number is not valid.'; end if;
    select id into v_customer from customers where phone = v_phone;
    if v_customer is null then
      insert into customers (name, phone) values (v_name, v_phone) returning id into v_customer;
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one product.';
  end if;
  if jsonb_array_length(p_items) > 100 then raise exception 'Too many lines on one order.'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from products where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found.'; end if;
    begin
      v_qty := (v_item ->> 'qty')::numeric;
      v_price := coalesce((v_item ->> 'price_paise')::bigint, v_prod.price_paise);
    exception when others then
      raise exception 'Wrong quantity or price for "%".', v_prod.name;
    end;
    if v_qty is null or v_qty <= 0 or v_qty > 100000 or v_qty <> round(v_qty, 3) then
      raise exception 'Wrong quantity for "%".', v_prod.name;
    end if;
    if v_prod.unit <> 'kg' and v_qty <> trunc(v_qty) then raise exception '"%" must be a whole number.', v_prod.name; end if;
    if v_price < 0 or v_price > 100000000 then raise exception 'Wrong price for "%".', v_prod.name; end if;
    -- NEW: a special price needs the owner, or "Cashiers can bargain" switched on.
    if v_price <> v_prod.price_paise and not is_owner()
       and not coalesce((select allow_bargain from app_settings where id), true) then
      raise exception 'Special prices are switched off by the owner ("%").', v_prod.name;
    end if;
    v_sub := v_sub + round(v_price * v_qty);
    v_lines := v_lines || jsonb_build_object('product_id', v_prod.id, 'name', v_prod.name, 'unit', v_prod.unit,
                                             'price', v_price, 'qty', v_qty, 'line', round(v_price * v_qty));
  end loop;

  if p_order_id is null then
    if p_delivery_date < ist_today() then raise exception 'Delivery date cannot be in the past.'; end if;
    v_no := next_doc_no('OR', ist_today(), 4);
    insert into orders (order_no, customer_id, customer_name, customer_phone, delivery_date, delivery_note, notes, subtotal_paise)
    values (v_no, v_customer, v_name, v_phone, p_delivery_date, nullif(trim(coalesce(p_delivery_note, '')), ''),
            nullif(trim(coalesce(p_notes, '')), ''), v_sub)
    returning id into v_id;
  else
    select * into o from orders where id = p_order_id for update;
    if not found then raise exception 'Order not found.'; end if;
    if o.status in ('delivered', 'cancelled') then raise exception 'A % order cannot be changed.', o.status; end if;
    -- NEW: the date may move later (delay) or earlier, but not into the past.
    if p_delivery_date <> o.delivery_date and p_delivery_date < ist_today() then
      raise exception 'Delivery date cannot be in the past.';
    end if;
    if order_net_advance(o.id) > v_sub then
      raise exception 'The advance taken (₹%) is more than the new order total. Refund the difference first.',
        to_char(order_net_advance(o.id) / 100.0, 'FM999999990.00');
    end if;
    delete from order_items where order_id = o.id;
    update orders set customer_id = v_customer, customer_name = v_name, customer_phone = v_phone,
                      delivery_date = p_delivery_date, delivery_note = nullif(trim(coalesce(p_delivery_note, '')), ''),
                      notes = nullif(trim(coalesce(p_notes, '')), ''), subtotal_paise = v_sub
    where id = o.id;
    v_id := o.id;
    v_no := o.order_no;
  end if;

  insert into order_items (order_id, product_id, product_name, unit, unit_price_paise, qty, line_total_paise)
  select v_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit,
         (l ->> 'price')::bigint, (l ->> 'qty')::numeric, (l ->> 'line')::bigint
  from jsonb_array_elements(v_lines) l;

  return jsonb_build_object('id', v_id, 'order_no', v_no, 'subtotal_paise', v_sub);
end $$;

create or replace function set_order_ready(p_order_id uuid, p_ready boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o orders;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can change an order.' using errcode = '42501'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'This order is %.', o.status; end if;
  update orders set status = case when p_ready then 'ready'::order_status
                                  when order_net_advance(o.id) > 0 then 'advance_paid'::order_status
                                  else 'pending'::order_status end
  where id = o.id;
end $$;

create or replace function cancel_order(p_order_id uuid, p_reason text, p_refund_mode text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  o     orders;
  v_net bigint;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can cancel an order.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Please write a reason.'; end if;
  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status in ('delivered', 'cancelled') then raise exception 'This order is already %.', o.status; end if;
  v_net := order_net_advance(o.id);
  if v_net > 0 and p_refund_mode is not null then
    if p_refund_mode not in ('cash', 'upi') then raise exception 'Refund must be cash or UPI.'; end if;
    insert into order_payments (order_id, kind, mode, amount_paise, note)
    values (o.id, 'refund', p_refund_mode::money_mode, v_net, 'Refund on cancel');
  end if;
  update orders set status = 'cancelled',
                    cancel_reason = trim(p_reason) || case when v_net > 0 and p_refund_mode is null
                                                           then ' (advance kept)' else '' end
  where id = o.id;
end $$;

create or replace function convert_order_to_bill(p_order_id uuid, p_payments jsonb, p_client_ref uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          app_settings;
  o          orders;
  v_existing bills;
  i          order_items;
  v_gst      int;
  v_gross    bigint;
  v_tax      bigint;
  v_line     bigint;
  v_sub      bigint := 0;
  v_taxsum   bigint := 0;
  v_total    bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_adv      bigint;
  v_due      bigint;
  v_pay      jsonb;
  v_paysum   bigint := 0;
  v_today    date := ist_today();
  v_bill_id  uuid;
  v_bill_no  text;
  v_token    text;
begin
  if not is_staff() then raise exception 'Only the owner or a cashier can bill an order.' using errcode = '42501'; end if;
  if p_client_ref is not null then
    select * into v_existing from bills where client_ref = p_client_ref;
    if found then
      return jsonb_build_object('id', v_existing.id, 'bill_no', v_existing.bill_no,
                                'share_token', v_existing.share_token, 'duplicate', true);
    end if;
  end if;

  select * into o from orders where id = p_order_id for update;
  if not found then raise exception 'Order not found.'; end if;
  if o.status = 'delivered' then raise exception 'This order is already billed.'; end if;
  if o.status = 'cancelled' then raise exception 'This order was cancelled.'; end if;
  -- NEW: early or late delivery is fine; the bill is dated the day it is delivered.

  select * into s from app_settings where id;
  for i in select * from order_items where order_id = o.id order by created_at, id loop
    select coalesce(gst_rate_bp, 0) into v_gst from products where id = i.product_id;
    v_gross := i.line_total_paise;
    if s.prices_include_gst then
      v_tax := round(v_gross * v_gst / (10000.0 + v_gst));
      v_line := v_gross;
    else
      v_tax := round(v_gross * v_gst / 10000.0);
      v_line := v_gross + v_tax;
    end if;
    v_sub := v_sub + v_gross;
    v_taxsum := v_taxsum + v_tax;
    v_total := v_total + v_line;
    v_lines := v_lines || jsonb_build_object('product_id', i.product_id, 'name', i.product_name, 'unit', i.unit,
      'price', i.unit_price_paise, 'qty', i.qty, 'gst', v_gst, 'tax', v_tax, 'line', v_line);
  end loop;
  if jsonb_array_length(v_lines) = 0 then raise exception 'This order has no items.'; end if;

  v_adv := order_net_advance(o.id);
  if v_adv > v_total then
    raise exception 'The advance (₹%) is more than the bill (₹%). Refund ₹% from the order first.',
      to_char(v_adv / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00'),
      to_char((v_adv - v_total) / 100.0, 'FM999999990.00');
  end if;
  v_due := v_total - v_adv;

  if jsonb_typeof(coalesce(p_payments, '[]'::jsonb)) <> 'array' then raise exception 'Payment is missing.'; end if;
  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if (v_pay ->> 'mode') is null or (v_pay ->> 'mode') not in ('cash', 'upi') then raise exception 'Payment must be cash or UPI.'; end if;
    if coalesce((v_pay ->> 'amount_paise')::bigint, 0) <= 0 then raise exception 'Payment amounts must be more than zero.'; end if;
    v_paysum := v_paysum + (v_pay ->> 'amount_paise')::bigint;
  end loop;
  if v_paysum <> v_due then
    raise exception 'Balance to collect is ₹%, but payments add up to ₹%.',
      to_char(v_due / 100.0, 'FM999999990.00'), to_char(v_paysum / 100.0, 'FM999999990.00');
  end if;

  v_bill_no := next_doc_no(s.bill_prefix, v_today, 6);
  insert into bills (bill_no, business_date, customer_id, customer_name, customer_phone, subtotal_paise,
                     discount_paise, tax_paise, total_paise, order_id, client_ref)
  values (v_bill_no, v_today, o.customer_id, o.customer_name, o.customer_phone, v_sub, 0, v_taxsum, v_total,
          o.id, p_client_ref)
  returning id, share_token into v_bill_id, v_token;

  insert into bill_items (bill_id, product_id, product_name, unit, unit_price_paise, qty, gst_rate_bp, tax_paise, line_total_paise)
  select v_bill_id, (l ->> 'product_id')::uuid, l ->> 'name', (l ->> 'unit')::product_unit, (l ->> 'price')::bigint,
         (l ->> 'qty')::numeric, (l ->> 'gst')::int, (l ->> 'tax')::bigint, (l ->> 'line')::bigint
  from jsonb_array_elements(v_lines) l;

  if v_adv > 0 then
    insert into payments (bill_id, mode, amount_paise, business_date, reference)
    values (v_bill_id, 'advance', v_adv, v_today, o.order_no);
  end if;
  insert into payments (bill_id, mode, amount_paise, business_date)
  select v_bill_id, (p ->> 'mode')::pay_mode, (p ->> 'amount_paise')::bigint, v_today
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) p;

  update orders set status = 'delivered', bill_id = v_bill_id where id = o.id;

  return jsonb_build_object('id', v_bill_id, 'bill_no', v_bill_no, 'share_token', v_token,
                            'total_paise', v_total, 'advance_paise', v_adv, 'duplicate', false);
end $$;

-- ---------- Excel report: Cash sheet, order payments, orders, bill changes --------
create or replace function report_data(p_from date, p_to date) returns jsonb
language plpgsql stable as $$
declare
  t   jsonb;
  rs  numeric := 100.0;
begin
  -- The owner (from the app) or the report Edge Function (service key) only.
  if not (is_owner() or current_user = 'service_role') then
    raise exception 'Only the owner can download reports.' using errcode = '42501';
  end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'Choose a range of up to 400 days.'; end if;
  t := range_totals(p_from, p_to);
  return jsonb_build_object(
    'Summary', jsonb_build_array(
      jsonb_build_object('Item', 'Period', 'Value', to_char(p_from, 'DD Mon YYYY') || ' to ' || to_char(p_to, 'DD Mon YYYY')),
      jsonb_build_object('Item', 'Bills', 'Value', t -> 'bills'),
      jsonb_build_object('Item', 'Cancelled (void) bills', 'Value', t -> 'void_bills'),
      jsonb_build_object('Item', 'Sales ₹', 'Value', (t ->> 'sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Discounts ₹', 'Value', (t ->> 'discount_paise')::bigint / rs),
      jsonb_build_object('Item', 'GST in sales ₹', 'Value', (t ->> 'tax_paise')::bigint / rs),
      jsonb_build_object('Item', 'Returns / refunds ₹', 'Value', (t ->> 'returns_paise')::bigint / rs),
      jsonb_build_object('Item', 'Net sales ₹', 'Value', (t ->> 'net_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash sales ₹', 'Value', (t ->> 'cash_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'UPI sales ₹', 'Value', (t ->> 'upi_sales_paise')::bigint / rs),
      jsonb_build_object('Item', 'Paid from order advances ₹', 'Value', (t ->> 'advance_used_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash received for orders ₹', 'Value', (t ->> 'advance_cash_paise')::bigint / rs),
      jsonb_build_object('Item', 'UPI received for orders ₹', 'Value', (t ->> 'advance_upi_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash refunds ₹', 'Value', (t ->> 'cash_refunds_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash out ₹', 'Value', (t ->> 'cash_out_paise')::bigint / rs),
      jsonb_build_object('Item', 'Cash that should be in hand ₹', 'Value', (t ->> 'net_cash_paise')::bigint / rs),
      jsonb_build_object('Item', 'Paid to workers ₹', 'Value', (t ->> 'worker_paid_paise')::bigint / rs)
    ),
    'Bills', (select coalesce(jsonb_agg(jsonb_build_object(
        'Bill no', b.bill_no,
        'Date & time', to_char(b.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Customer', coalesce(b.customer_name, ''),
        'Mobile', coalesce(b.customer_phone, ''),
        'Subtotal ₹', b.subtotal_paise / rs,
        'Discount ₹', b.discount_paise / rs,
        'GST ₹', b.tax_paise / rs,
        'Total ₹', b.total_paise / rs,
        'Paid by', (select string_agg(initcap(x.mode::text) || ' ' || to_char(x.amt / rs, 'FM9999999990.00'), ', ' order by x.first)
                    from (select p.mode, sum(p.amount_paise) amt, min(p.created_at) first from payments p
                          where p.bill_id = b.id group by p.mode having sum(p.amount_paise) <> 0) x),
        'Payment changed', coalesce((select string_agg(distinct substr(p.reference, 10), '; ') from payments p
                    where p.bill_id = b.id and p.reference like 'Changed: %'), ''),
        'Coupon', coalesce((select code from coupons c where c.id = b.coupon_id), ''),
        'Order', coalesce((select order_no from orders o where o.id = b.order_id), ''),
        'Status', case when b.status = 'void' then 'VOID: ' || coalesce(b.void_reason, '') else 'OK' end,
        'Made by', coalesce((select full_name from profiles pr where pr.id = b.created_by), '')
      ) order by b.created_at), '[]'::jsonb)
      from bills b where b.business_date between p_from and p_to),
    'Items sold', (select coalesce(jsonb_agg(jsonb_build_object(
        'Product', x.product_name, 'Unit', x.unit, 'Quantity', x.qty, 'Amount ₹', x.amount / rs,
        'Returned qty', x.ret_qty, 'Returned ₹', x.ret_amount / rs) order by x.amount desc), '[]'::jsonb)
      from (select i.product_name, i.unit::text as unit, sum(i.qty) qty, sum(i.line_total_paise) amount,
                   coalesce(sum(r.q), 0) ret_qty, coalesce(sum(r.a), 0) ret_amount
            from bill_items i join bills b on b.id = i.bill_id
            left join lateral (select sum(ri.qty) q, sum(ri.amount_paise) a from return_items ri
                               join returns rt on rt.id = ri.return_id
                               where ri.bill_item_id = i.id and rt.business_date between p_from and p_to) r on true
            where b.business_date between p_from and p_to and b.status = 'active'
            group by i.product_name, i.unit) x),
    'Payments by mode', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date', to_char(d, 'DD-MM-YYYY'), 'Cash ₹', y.cash / rs, 'UPI ₹', y.upi / rs,
        'From advance ₹', y.adv / rs, 'Total ₹', (y.cash + y.upi + y.adv) / rs) order by d), '[]'::jsonb)
      from (select p.business_date d,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'cash'), 0) cash,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'upi'), 0) upi,
                   coalesce(sum(p.amount_paise) filter (where p.mode = 'advance'), 0) adv
            from payments p join bills b on b.id = p.bill_id
            where p.business_date between p_from and p_to and b.status = 'active'
            group by p.business_date) y),
    'Returns', (select coalesce(jsonb_agg(jsonb_build_object(
        'Return no', r.return_no,
        'Date & time', to_char(r.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Bill no', b.bill_no,
        'Items', (select string_agg(i.product_name || ' × ' || ri.qty::text, ', ')
                  from return_items ri join bill_items i on i.id = ri.bill_item_id where ri.return_id = r.id),
        'Refund ₹', r.amount_paise / rs, 'Refund by', initcap(r.refund_mode::text), 'Reason', coalesce(r.reason, '')
      ) order by r.created_at), '[]'::jsonb)
      from returns r join bills b on b.id = r.bill_id where r.business_date between p_from and p_to),
    'Cash out', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date & time', to_char(c.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Amount ₹', c.amount_paise / rs, 'Reason', c.reason, 'Taken by', c.taken_by,
        'Status', case when c.voided then 'CANCELLED: ' || coalesce(c.void_reason, '') else 'OK' end
      ) order by c.created_at), '[]'::jsonb)
      from cash_out c where c.business_date between p_from and p_to),
    'Coupons used', (select coalesce(jsonb_agg(jsonb_build_object(
        'Coupon', z.code, 'Bills', z.n, 'Discount given ₹', z.disc / rs) order by z.disc desc), '[]'::jsonb)
      from (select c.code, count(*) n, sum(b.discount_paise) disc from bills b join coupons c on c.id = b.coupon_id
            where b.business_date between p_from and p_to and b.status = 'active' group by c.code) z),
    'Cash', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date', to_char(d, 'DD-MM-YYYY'),
        'Cash from bills ₹', c.bill_cash / rs,
        'Cash from orders ₹', c.order_cash / rs,
        'Cash refunds ₹', -c.refund_cash / rs,
        'Cash out ₹', -c.cash_out / rs,
        'Cash in hand ₹', (c.bill_cash + c.order_cash - c.refund_cash - c.cash_out) / rs,
        'UPI from bills ₹', c.bill_upi / rs,
        'UPI from orders ₹', c.order_upi / rs,
        'UPI refunds ₹', -c.refund_upi / rs
      ) order by d), '[]'::jsonb)
      from generate_series(p_from, p_to, interval '1 day') d
      cross join lateral (select
        (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
          where p.business_date = d::date and b.status = 'active' and p.mode = 'cash') bill_cash,
        (select coalesce(sum(p.amount_paise), 0) from payments p join bills b on b.id = p.bill_id
          where p.business_date = d::date and b.status = 'active' and p.mode = 'upi') bill_upi,
        (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
          from order_payments where business_date = d::date and mode = 'cash') order_cash,
        (select coalesce(sum(case when kind = 'advance' then amount_paise else -amount_paise end), 0)
          from order_payments where business_date = d::date and mode = 'upi') order_upi,
        (select coalesce(sum(amount_paise), 0) from returns where business_date = d::date and refund_mode = 'cash') refund_cash,
        (select coalesce(sum(amount_paise), 0) from returns where business_date = d::date and refund_mode = 'upi') refund_upi,
        (select coalesce(sum(amount_paise), 0) from cash_out where business_date = d::date and not voided) cash_out) c
      where c.bill_cash <> 0 or c.bill_upi <> 0 or c.order_cash <> 0 or c.order_upi <> 0
         or c.refund_cash <> 0 or c.refund_upi <> 0 or c.cash_out <> 0),
    'Order payments', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date & time', to_char(op.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'For day', to_char(op.business_date, 'DD-MM-YYYY'),
        'Order no', o.order_no, 'Customer', o.customer_name,
        'Type', case when op.kind = 'advance' then 'Received' else 'Given back' end,
        'Mode', upper(op.mode::text),
        'Amount ₹', (case when op.kind = 'advance' then 1 else -1 end) * op.amount_paise / rs,
        'Note', coalesce(op.note, ''),
        'By', coalesce((select full_name from profiles pr where pr.id = op.created_by), '')
      ) order by op.created_at), '[]'::jsonb)
      from order_payments op join orders o on o.id = op.order_id where op.business_date between p_from and p_to),
    'Orders', (select coalesce(jsonb_agg(jsonb_build_object(
        'Order no', v.order_no,
        'Taken on', to_char(v.created_at at time zone 'Asia/Kolkata', 'DD-MM-YYYY'),
        'Delivery date', to_char(v.delivery_date, 'DD-MM-YYYY'),
        'Customer', v.customer_name, 'Mobile', coalesce(v.customer_phone, ''),
        'Status', initcap(replace(v.status::text, '_', ' ')),
        'Order total ₹', v.subtotal_paise / rs,
        'Paid so far ₹', v.advance_paise / rs,
        'Balance ₹', v.balance_paise / rs,
        'Bill', coalesce((select bill_no from bills b where b.id = v.bill_id), '')
      ) order by v.delivery_date, v.order_no), '[]'::jsonb)
      from order_overview v
      where (v.created_at at time zone 'Asia/Kolkata')::date between p_from and p_to
         or v.delivery_date between p_from and p_to
         or exists (select 1 from order_payments op where op.order_id = v.id and op.business_date between p_from and p_to)),
    'Bill changes', (select coalesce(jsonb_agg(jsonb_build_object(
        'Date & time', to_char(a.at at time zone 'Asia/Kolkata', 'DD-MM-YYYY HH24:MI'),
        'Bill no', coalesce(b.bill_no, ''),
        'Before', coalesce(a.old_data ->> 'summary', ''),
        'After', coalesce(a.new_data ->> 'summary', ''),
        'Reason', coalesce(a.new_data ->> 'reason', ''),
        'Changed by', coalesce((select full_name from profiles pr where pr.id = a.actor), '')
      ) order by a.at), '[]'::jsonb)
      from audit_log a left join bills b on b.id::text = a.row_id
      where a.action = 'BILL_EDIT' and (a.at at time zone 'Asia/Kolkata')::date between p_from and p_to)
  );
end $$;

-- ---------- Permissions ----------------------------------------------------------
revoke execute on function bill_pay_text(uuid)                                       from public, anon;
revoke execute on function edit_bill(uuid, text, text, jsonb, text)                  from public, anon;
revoke execute on function take_order_payment(uuid, text, jsonb, text, uuid)         from public, anon;
revoke execute on function switch_order_payment_mode(uuid, text, uuid)               from public, anon;
grant  execute on function bill_pay_text(uuid)                                       to authenticated, service_role;
grant  execute on function edit_bill(uuid, text, text, jsonb, text)                  to authenticated;
grant  execute on function take_order_payment(uuid, text, jsonb, text, uuid)         to authenticated;
grant  execute on function switch_order_payment_mode(uuid, text, uuid)               to authenticated;
