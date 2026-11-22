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
