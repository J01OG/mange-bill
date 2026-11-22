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
