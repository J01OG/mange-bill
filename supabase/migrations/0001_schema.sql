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
