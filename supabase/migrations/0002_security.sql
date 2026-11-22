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
