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
