# Mushroom Farm app

**A free, open-source billing and farm-management app for small farms and farm shops in India.**
Billing at the counter, workers' attendance and pay, bulk orders, daily Excel reports by email and nightly backups,
all from a phone, with no monthly fees and no server to look after.

Built for a mushroom farm, but it suits any small shop that sells by **kg, packet or piece**.

> Mobile-first installable web app (PWA) · React + Vite + TypeScript + Tailwind · Supabase · Netlify · Brevo.
> Everything runs on the **free plans** of these services.

## Try it in 2 minutes (no account needed)
```bash
git clone <this repository's address>
cd <the folder it creates>
npm install
npm run demo
```
Open http://localhost:5173 and log in as **90000 00001** (owner), **90000 00002** (cashier) or **90000 00003** (worker), with any password.
Demo mode uses made-up data inside your browser. Nothing is saved, and nothing is sent anywhere.

## What it does
- **Billing**: tap-to-bill in seconds; kg/packet/piece; sell weighed items **by weight or by amount** ("₹100 worth");
  cash/UPI/split with a scan-to-pay UPI QR; coupons; GST line (nil by default); gapless bill numbers per financial year;
  print on 58 mm/80 mm/A4; WhatsApp bill link; returns/refunds; cash-out; void with reason.
- **Workforce**: one-screen attendance, automatic day wages, monthly salary with leave counts and owner-decided deductions,
  pay/advance/bonus/deduct, undo that never deletes, and each worker sees only their own pay.
- **Orders**: bulk/future orders at special prices, advances, month/week/day delivery calendar, deliver-and-bill with the advance applied.
- **Reports**: owner dashboard, Excel download for any dates, daily Excel email at **your chosen time** to **your email list**.
- **Safety**: every rule is enforced in the database (Row Level Security), financial records are never hard-deleted, there is an audit log,
  a nightly full backup (30 kept, plus a weekly email), and an optional off-site backup.
- **Roles**: owner, cashier and worker, each seeing only what they should.

## Set it up for your own farm
Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. It's written for non-programmers and takes about 1½ hours, all on free plans.
Then share **[docs/OWNER-GUIDE.md](docs/OWNER-GUIDE.md)** with your staff, and keep **[docs/MAINTENANCE.md](docs/MAINTENANCE.md)** handy.
Know the limits before you start: [free-plan capacity and what the app doesn't do](docs/MAINTENANCE.md#free-plan-limits-what-we-use).

Each farm runs **its own copy**: its own Supabase database and its own website. No farm's data is shared with anyone else, including the authors.

The phase guides explain each part in depth and contain test checklists:
[1 Login & users](docs/PHASE-1-SETUP.md) · [2 Billing & printing](docs/PHASE-2-BILLING.md) · [3 Returns, cash, coupons](docs/PHASE-3-RETURNS-CASH-COUPONS.md) ·
[4 Workforce](docs/PHASE-4-WORKFORCE.md) · [5 Orders & calendar](docs/PHASE-5-ORDERS.md) · [6 Reports & email](docs/PHASE-6-REPORTS.md).

## Folder map
| Path | What it is |
|---|---|
| `src/` | The app screens (React). `src/dev/` is demo mode only and is not in the real build |
| `supabase/ALL-IN-ONE.sql` | The whole database in one file (fresh install) |
| `supabase/migrations/` | The same, as numbered steps (for updating an existing install) |
| `supabase/schedule/` | Timers for the daily report and nightly backup |
| `supabase/functions/` | Server functions: `admin-users` (accounts) and `report` (Excel, email, backup) |
| `supabase/seed.sql` | Optional sample data |
| `scripts/` | Tests and helper scripts |
| `.github/workflows/db-backup.yml` | Optional nightly off-site backup (runs only in **private** repositories) |
| `docs/` | All guides |

## Commands
```bash
npm install          # once
npm run demo         # try it with made-up data, no setup
npm run dev          # run against your own Supabase project (needs .env, see .env.example)
npm run build        # make the "dist" folder to upload to Netlify
npm run test:db      # database + security rules (200+ checks, no internet needed)
npm run test:report  # Excel report/backup builder (run test:db first; downloads Deno once)
npm run sql:combine  # rebuild supabase/ALL-IN-ONE.sql after adding a migration
```
`npm run test:db` runs every check against a strict new-style Supabase setup. Run it with `SUPABASE_STYLE=old` to check older projects too.

## How the code is built
- Money is stored as whole **paise** (₹12.50 = 1250). Times are stored in UTC and shown in IST; `business_date` is the IST day.
- Financial rows are never deleted. Bills and cash-outs are voided and ledger rows are reversed; the database itself blocks deletes and edits.
- Every money action goes through a checked database function. Prices and totals are always worked out on the server, never trusted from the phone.
- Every table has Row Level Security, and the public key reads nothing without a login. Secrets live only in Supabase.

## Contributing
Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Found a security problem? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## Disclaimer
This app helps run a small shop. It is **not** an accounting or tax-filing system, and its GST handling is basic.
Check bills, taxes and pay calculations with your accountant. It is provided "as is", without warranty. See [LICENSE](LICENSE).

## Licence
[MIT](LICENSE). Free to use, change and share, including commercially.
