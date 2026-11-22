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
