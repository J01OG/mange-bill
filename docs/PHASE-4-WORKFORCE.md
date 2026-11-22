# Phase 4: workforce (attendance, wages, worker ledger)

Do [Phase 3](PHASE-3-RETURNS-CASH-COUPONS.md) first. Setup takes about 5 minutes.
To try it with made-up data first, run `npm run demo` and log in as 90000 00001 (owner) or 90000 00003 (worker).

## Step 1 — Update the database

Supabase → **SQL Editor** → **New query** → paste everything from `supabase/migrations/0005_workforce.sql` → **Run**.

## Step 2 — Update the app online

```powershell
npm run build
```

Netlify → your site → **Deploys** → drag the new **dist** folder onto the box.

---

## How it works

### Workers (Home → Workforce)
- **+ Add worker**: name, mobile (optional), **per day** or **per month**, the pay rate, and a **class/category** of your choice (e.g. Harvest, Packing, Senior).
- When someone leaves, untick **Still working here**. Their history is kept under **Left / inactive**.
- Changing the pay rate only affects attendance marked **after** the change. Old wages stay as they were.

### Attendance (Home → Attendance)
- Pick the date (today by default). Tap **P** (present), **½** (half day), **A** (absent) or **L** (leave) for each worker.
- **Mark the other N as Present** fills everyone you haven't tapped yet, so you only tap the exceptions.
- Tap **Save attendance**. You can go back to any past day and change a mark.
- **Daily-wage workers** earn automatically: present = full day rate, half day = half, absent/leave = nothing.
  If you change a mark later, the old wage is cancelled and the new one added. Both lines stay in the history.

### Monthly workers
- Attendance is recorded, but no money moves day by day.
- Open the worker → **Month**. You see the Present / Half day / **Absent** / **Leave** counts.
- **Close month**: the salary is filled in. Enter any **deduction you decide** (based on the leave count and their class), add a note, then **Add salary**.
- To redo a month, undo its salary entry in History, then close the month again.

### Paying workers (open a worker)
| Button | Use it when | Effect on "Due to worker" |
|---|---|---|
| **Pay** | You pay wages already earned, any amount, any date | goes down |
| **Advance** | You give money before it is earned | goes down (can go below zero = "Advance taken") |
| **Bonus** | Extra reward | goes up |
| **Deduct** | Damage, leave, etc. | goes down |

- **History** lists every entry with the balance after it: the full record of earned, paid, advances, bonuses and deductions.
- Made a mistake? Tap **Undo this entry** and give a reason. An opposite entry is added. Nothing is ever deleted.
  (A day wage is changed by changing that day's attendance.)
- Paid in cash **from the shop till**? Also add a **Cash out** on the Cash tab so the till still matches.

### Worker logins
- Open the worker → **App login** → set a password → **Create login** (the worker needs a mobile number).
  They log in with their mobile and see **only their own** attendance, wages, payments and balance. They cannot change anything.
- **Allow billing (make cashier)** turns a worker into a cashier who can also make bills. They still see their own pay under Home → My attendance & pay.

---

## Test Phase 4 (tick each one)

**As the owner**
- [ ] Add a daily worker at ₹500/day and a monthly worker at ₹15,000/month.
- [ ] Attendance for today → **Mark all present** → set one daily worker to **½** → Save.
      Workforce shows ₹500 and ₹250 due. The monthly worker shows "All settled".
- [ ] Change the half-day worker to **Absent** → Save → their balance goes to ₹0, and History shows the wage and its reversal.
- [ ] Yesterday's date → mark present → their balance increases by one more day.
- [ ] Open the daily worker → **Pay** ₹300 by cash. The balance drops by ₹300.
- [ ] **Advance** ₹1,000. The balance shows "Advance taken".
- [ ] **Undo** the ₹300 payment. The balance goes back up, and both lines show in History.
- [ ] Mark the monthly worker **L** for one day → open them → Month shows Leave 1 → deduction ₹500 → **Add salary**. The balance is ₹14,500.
- [ ] Try to close the same month again. It says "already closed".
- [ ] Give the daily worker a login → log in as them on another phone. They see only their own page.
- [ ] **Allow billing** for them → log in again. They now have New bill / Bills / Cash.

**Safety**
- [ ] As a cashier, open `/workers` in the address bar. You are sent back to Home.
- [ ] As a worker, there is no Pay / Edit / Undo anywhere.
