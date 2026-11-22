# Phase 6: dashboard and the daily Excel report (your time, your email list)

Do [Phase 5](PHASE-5-ORDERS.md) first. This phase has the most setup steps (about 25 minutes), because it connects an email service.
To see the dashboard with made-up data, run `npm run demo` and log in as 90000 00001 → Home → Reports.

## What you get
- **Home → Reports**: sales for Today / Yesterday / This week / This month / Last month / any dates.
  Shows net sales, number of bills, cash in hand, discounts, returns, cash out, order advances, money paid to workers, a Cash-vs-UPI bar, sales per day, and top products.
- **⬇ Download Excel** for any period, and **✉ Email this now** to the list.
- **Daily report by email**: switch it on/off, choose **any time** (15-minute steps) and **up to 10 email addresses**. Change them any time in the app.
- The Excel file has these sheets: Summary, Bills, Items sold, Payments by mode, Returns, Cash out, Coupons used, Order advances.
  Each daily file is also kept in Supabase, and can be downloaded again from **Sent reports**.

## Why Brevo (and not Resend)
On its free plan, Resend can only email **your own** address unless you own a website domain. To send to a **list** for free, we use **Brevo**:
300 emails a day, any recipients, and you only need to confirm one sender address (for example your Gmail).
If you later buy a domain, you can switch to Resend by changing two secrets (see the end).

---

## Step 1 — Update the database
Supabase → **SQL Editor** → **New query** → paste all of `supabase/migrations/0007_reports.sql` → **Run**.

## Step 2 — Get a free Brevo account
1. Go to **https://www.brevo.com** → Sign up free.
2. Top-right menu → **Senders, Domains & Dedicated IPs** → **Senders** → **Add a sender**.
   Use the email you want reports to come **from** (e.g. your Gmail). Brevo emails you a link. Click it to confirm.
3. Top-right menu → **SMTP & API** → **API Keys** tab → **Generate a new API key** → name it `farm` → **copy the key** (it starts with `xkeysib-`). Keep it safe.

## Step 3 — Add the "report" function
1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name: `report`. Delete the sample code, paste everything from `supabase/functions/report/index.ts` → **Deploy**.
3. Open the function → settings → turn **OFF** "Enforce JWT verification" → Save. (It checks who is calling by itself.)

## Step 4 — Switch on the timer
1. Open `supabase/schedule/1-report-timer.sql` in Notepad. Replace `YOUR-PROJECT-ID` with your project id
   (the part before `.supabase.co` in your Project URL, e.g. `abcdxyz`).
2. Supabase → **SQL Editor** → **New query** → paste it → **Run**.
3. The result shows one long value under "Copy this into CRON_SECRET". **Copy it.**

## Step 5 — Add the secrets
Supabase → **Edge Functions** → **Secrets** (sometimes under *Manage secrets*) → add each name and value:

| Name | Value |
|---|---|
| `CRON_SECRET` | the long value from Step 4 |
| `EMAIL_PROVIDER` | `brevo` |
| `EMAIL_API_KEY` | your Brevo key from Step 2 |
| `EMAIL_FROM` | the sender email you confirmed in Brevo |
| `EMAIL_FROM_NAME` | your farm name, e.g. `Green Valley Farm` |

## Step 6 — Update the app online
```powershell
npm run build
```
Netlify → your site → **Deploys** → drag the new **dist** folder onto the box.

## Step 7 — Choose your time and email list
In the app: **Home → Reports** → scroll down to **Daily report by email**:
- Tick **Send the day's Excel report every day**.
- **Send at**: pick the time (e.g. 7:00 pm).
- **Send to**: type an address → **Add** (repeat for up to 10) → **Save**.

Then press **✉ Email this now** at the top. Everyone on the list should get an email with the Excel file within a minute.
**Check the spam folder** the first time and mark it "Not spam".

---

## Test Phase 6 (tick each one)
- [ ] Reports → Today: the numbers match the Cash tab and the Bills tab.
- [ ] This month: the "Sales by day" bars appear. Tap a bar to see that day's sales.
- [ ] **⬇ Download Excel** opens a file with 8 sheets, and the Bills sheet lists today's bills.
- [ ] Add two email addresses → Save → **✉ Email this now** → both receive it.
- [ ] Set **Send at** to about 20 minutes from now → Save. Within 15 minutes after that time, the email arrives by itself and **Sent reports** shows "Daily · Emailed".
- [ ] Set the time back to your normal time.
- [ ] Untick "Send every day" → Save. No daily email arrives.
- [ ] As a cashier, Reports does not appear.

## If the email does not arrive
| What you see | What to do |
|---|---|
| "Email is not set up" | Step 5 is missing `EMAIL_API_KEY` or `EMAIL_FROM`. |
| "Email service (brevo) refused: 401" | The API key is wrong. Make a new one in Brevo and update the secret. |
| "… refused: 400 … sender" | `EMAIL_FROM` is not a confirmed Brevo sender (Step 2.2). |
| Sent reports shows nothing at the time | Check Step 4 ran without errors. Supabase → **Integrations → Cron** should show `farm-report-tick` running every 15 min. |
| "Daily · Failed: …" | Read the message. Fix it. It retries automatically (up to 3 times a day). |
| Nothing in the inbox | Look in Spam / Promotions. |

## Switching to Resend later (only if you own a domain)
Verify your domain in Resend, then change the secrets: `EMAIL_PROVIDER` = `resend`, `EMAIL_API_KEY` = your Resend key,
`EMAIL_FROM` = an address on your domain (e.g. `reports@yourfarm.in`). Nothing else changes.

## Free-tier check
The timer does a tiny database check every 15 minutes, and the function runs about once a day. Both are far below the free limits.
Brevo free: 300 emails/day. Ten people daily uses 10.
