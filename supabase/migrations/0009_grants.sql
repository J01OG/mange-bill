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
