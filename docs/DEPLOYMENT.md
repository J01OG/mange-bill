# Complete deployment guide (Supabase + Netlify, all free)

This is the **one guide for a fresh setup**, written for a non-programmer. It takes about 1½ hours in total.
(The phase guides in this folder explain each part in more detail, and have test checklists.)

**Already set up Phases 1–6?** Skip to [Updating an existing install](#updating-an-existing-install).

What you need: a Windows computer, a Google/email account, this project folder.

| # | What | Time |
|---|---|---|
| A | Install Node.js | 5 min |
| B | Supabase project + database | 15 min |
| C | Owner login | 5 min |
| D | Email service (Brevo) | 10 min |
| E | Two server functions | 10 min |
| F | Timers (daily report + nightly backup) | 5 min |
| G | Connect and publish the app (Netlify) | 15 min |
| H | Install on phones, first settings | 15 min |
| I | *(Optional)* Off-site backup on GitHub | 15 min |

---

## A. Install Node.js
1. **https://nodejs.org** → download **LTS** → install with the default options.
2. Open **PowerShell** in this project folder: in File Explorer, open the folder, click the address bar, type `powershell`, press Enter.
3. Run once:
   ```powershell
   npm install
   ```

## B. Supabase project and database
1. **https://supabase.com** → sign up → **New project**.
   Name `mushroom-farm` · **Generate** a database password and **write it down** · Region **South Asia (Mumbai)** · Free plan.
2. Wait about 2 minutes for it to be ready.
3. **SQL Editor** → **New query** → open `supabase/ALL-IN-ONE.sql` in Notepad → copy everything → paste → **Run**. You should see *Success*.
4. *(Optional, for trying things out)* New query → paste `supabase/seed.sql` → Run. This adds sample products and workers that you can edit later.
5. **Authentication → Sign In / Providers**: turn **OFF** "Allow new users to sign up". Under Email, turn **OFF** "Confirm email". **Save**.

## C. Owner login
1. **Authentication → Users → Add user → Create new user**
   Email: `91` + your mobile + `@farm.local` (e.g. `919876543210@farm.local`) · your password · tick **Auto Confirm User**.
2. **SQL Editor** → New query → run (with **your** number and name):
   ```sql
   select bootstrap_owner('9876543210', 'Your Name');
   ```

## D. Email service (Brevo, free)
1. **https://www.brevo.com** → sign up free.
2. Menu → **Senders, Domains & Dedicated IPs → Senders → Add a sender** → use your Gmail (or any email) → click the confirmation link Brevo sends you.
3. Menu → **SMTP & API → API Keys → Generate a new API key** → copy it (it starts with `xkeysib-`).

## E. Two server functions
For each of these: **Edge Functions → Deploy a new function → Via Editor** → type the name → delete the sample code → paste the whole file → **Deploy**.
Then open the function's settings → turn **OFF** "Enforce JWT verification" → Save. (Both functions check who is calling by themselves.)

| Name | File to paste |
|---|---|
| `admin-users` | `supabase/functions/admin-users/index.ts` |
| `report` | `supabase/functions/report/index.ts` |

## F. Timers
1. Open `supabase/schedule/1-report-timer.sql` in Notepad and replace `YOUR-PROJECT-ID` with your project id (the part before `.supabase.co` in your Project URL).
   SQL Editor → paste → **Run**. **Copy the long value** it shows.
2. SQL Editor → paste `supabase/schedule/2-backup-timer.sql` (nothing to edit) → **Run**.
3. **Edge Functions → Secrets** → add:

| Name | Value |
|---|---|
| `CRON_SECRET` | the long value from step 1 |
| `EMAIL_PROVIDER` | `brevo` |
| `EMAIL_API_KEY` | your Brevo key |
| `EMAIL_FROM` | the sender email you confirmed in Brevo |
| `EMAIL_FROM_NAME` | your farm name |

## G. Connect and publish the app
1. Supabase → **Project Settings → API Keys** (or **API**): copy the **Project URL** and the **anon public / publishable** key.
   ⚠️ Never use the *service_role* / *secret* key in the app.
2. In the project folder, copy `.env.example` to a new file named `.env`, and paste the two values after the `=` signs.
3. Try it on this computer:
   ```powershell
   npm run dev
   ```
   Open http://localhost:5173 and log in with your mobile number and password. Press Ctrl+C in PowerShell to stop.
4. Build the app:
   ```powershell
   npm run build
   ```
5. **https://app.netlify.com/drop** → sign up → drag the **dist** folder onto the page. Then **Site configuration → Change site name** (e.g. `greenvalley-farm` gives `https://greenvalley-farm.netlify.app`).

> **Updating the app later:** run `npm run build` again → Netlify → your site → **Deploys** → drag the new `dist` folder.
> Phones show a blue **"A new version of the app is ready → Update"** bar. Nothing reloads by itself while someone is billing.

**Optional: automatic publishing from GitHub.** If the project is in a GitHub repository: Netlify → **Add new site → Import from Git** → pick the repo.
Build command `npm run build`, publish directory `dist`. Under **Environment variables**, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
Every change pushed to GitHub is then published automatically.

## H. Phones and first settings
1. On each phone, open your Netlify link in **Chrome** → tap **Install** on the Home screen card (or ⋮ → *Add to Home screen*).
   On iPhone: Safari → Share → *Add to Home Screen*.
2. In the app (as owner):
   - **Farm settings**: farm name, address, phone, UPI ID, bill message. Leave GSTIN empty for now.
   - **Products**: your real products and prices.
   - **Users**: add your cashier(s). **Workforce**: add workers, and give them logins if you want them to see their pay.
   - **Reports → Daily report by email**: pick the time and add the email addresses → **Save** → **✉ Email this now** to test. Check the spam folder once.
3. Printer: see [PHASE-2-BILLING.md](PHASE-2-BILLING.md#step-4--set-up-printing) (RawBT for Bluetooth printers on Android, or a Windows driver for USB).

## I. (Optional) Off-site backup on GitHub — recommended
The app already saves a full Excel backup every night (in Supabase, last 30 days) and emails one every Sunday.
For a **complete, restorable** copy kept **outside** Supabase:
1. Make a free account at **https://github.com** → **New repository** → name `mushroom-farm` → **Private** → create.
2. Upload this project folder to it (the repository page shows how; *uploading files* in the browser works). **Do not upload `.env`.**
3. Supabase → **Connect** (top of the project page) → **Session pooler** → copy the connection string, and replace `[YOUR-PASSWORD]` with your database password from B.1.
4. GitHub → your repo → **Settings → Secrets and variables → Actions → New repository secret** → name `SUPABASE_DB_URL`, value = that string.
5. GitHub → **Actions** → *Nightly database backup* → **Run workflow** to test it. A green tick means it worked. Each run keeps a downloadable backup for 30 days.

---

## Updating an existing install
If you already set up Phases 1–6, do only this:
1. SQL Editor → run `supabase/migrations/0008_backups.sql`, then `supabase/migrations/0009_grants.sql`
   (newer Supabase projects need 0009, otherwise every login says "could not load your account").
2. SQL Editor → run `supabase/schedule/2-backup-timer.sql`.
   (Phase 6 called the report timer file `0008_schedule.sql`. It is now named `supabase/schedule/1-report-timer.sql`, with the same content, and you do **not** need to run it again.)
3. Edge Functions → **report** → replace all its code with the new `supabase/functions/report/index.ts` → Deploy.
4. `npm run build` → drag `dist` to Netlify.
5. **On each phone, close the app fully once** (swipe it away from recent apps) and open it again. This one-time step moves phones to the new "Update" bar. After that, updates always show the bar.

## If something goes wrong
- Login problems, "not connected": see [PHASE-1-SETUP.md → If something goes wrong](PHASE-1-SETUP.md#if-something-goes-wrong).
- Email or report problems: see [PHASE-6-REPORTS.md → If the email does not arrive](PHASE-6-REPORTS.md#if-the-email-does-not-arrive).
- Day-to-day upkeep: [MAINTENANCE.md](MAINTENANCE.md).
