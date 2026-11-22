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
