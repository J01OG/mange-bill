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
