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
