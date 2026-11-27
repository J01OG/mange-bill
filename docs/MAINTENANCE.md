# Maintenance checklist

The app is built to need very little looking after. Here is everything worth doing, and when.

## Every day (1 minute)
- [ ] Count the till against **Cash → Should be in hand** (remember to add the change money you started with).
- [ ] Glance at the daily report email. If it didn't arrive, open **Reports → Sent reports** and read the reason.

## Every week (5 minutes)
- [ ] **Sunday backup email** arrived? Keep it (make a Gmail label "Farm backups").
- [ ] **Farm settings → Backups**: "Last backup" should be today or yesterday.
- [ ] *(If you set up GitHub)* GitHub → Actions → *Nightly database backup*: the latest run has a green tick.

## Every month (10 minutes)
- [ ] **Users**: disable anyone who has left (Users → tap → Disable user). Mark workers who left as not working (Workforce → Edit).
- [ ] **Close the month** for monthly-paid workers (Workforce → worker → Month → Add salary).
- [ ] Supabase dashboard → **Reports / Usage**: database size and storage size. Compare with the limits below.
- [ ] Try a **restore drill** once in a while: open a backup Excel file and check that yesterday's bills are in it.

## Every year
- [ ] **1 April**: bill, return and order numbers restart automatically for the new financial year (e.g. `MF/27-28/000001`). Nothing to do.
- [ ] Download a full backup (Farm settings → Backups) and keep it with your accounts.
- [ ] Brevo, Netlify and Supabase may email you about their terms. Free plans can change, so read those emails.

---

## Free-plan limits (what we use)
| Service | Free limit | This farm's expected use | Watch out for |
|---|---|---|---|
| Supabase database | 500 MB | about 80–120 MB a year | after about 3–4 years, ask for help to archive old years |
| Supabase file storage | 1 GB | about 30 backups + daily reports, well under 200 MB | old backups are cleaned automatically (keeps 30) |
| Supabase data transfer | 5 GB / month | well under | — |
| Supabase pause | pauses after **7 days with no use** | daily billing and the 15-minute timer keep it awake | if the farm closes for a long time, open the Supabase dashboard and click **Restore project** |
| Netlify | free credits | small app | — |
| Brevo email | 300 / day | 1 daily report × your list (≤10) + 1 weekly backup | — |
| GitHub Actions | free for private repos within monthly minutes | about 2 minutes a night | — |

## Common jobs
| Job | How |
|---|---|
| Someone forgot their password | Owner: **Users** → tap them → set a new password. |
| Owner forgot their password | Supabase → Authentication → Users → owner → change password. |
| New cashier | **Users → + Add user** (role Cashier), or for an existing worker: Workforce → worker → *Allow billing*. |
| Change bill footer, UPI ID, GSTIN | **Farm settings**. GST rates per product: **Products**. |
| Change report time or emails | **Reports** → bottom card → Save. |
| Publish an app update | `npm run build` → drag `dist` to Netlify → Deploys. Phones then show the "Update" bar. |
| Check the safety rules still work after any change | `npm run test:db` (all lines must say `ok`). |

## If the worst happens
- **A phone is lost**: Users → disable that login. Their bills stay safe.
- **Supabase project paused**: open the Supabase dashboard → **Restore project**. Data is kept.
- **Supabase project deleted or broken**: create a new project, run `supabase/ALL-IN-ONE.sql`, then restore data from the GitHub backup
  (`farm-public.sql` and `farm-logins.sql`). This needs someone comfortable with databases. The Excel backups keep every record readable even without a restore.

## For whoever maintains the code
- Tests: `npm run test:db` (security rules and money logic, 250+ checks) and `npm run test:report` (Excel builder).
- Database changes: add a new numbered file in `supabase/migrations/`, never edit old ones. Then run `npm run sql:combine` to refresh `ALL-IN-ONE.sql`.
- New tables must be added to `BACKUP_TABLES` in `supabase/functions/report/index.ts`. A test fails if one is missing.
- Demo mode (`npm run demo`) uses `src/dev/mockSupabase.ts`. It is not part of the real build.
- On Windows, edit text files with an editor (VS Code, Notepad) rather than PowerShell `Get-Content`/`Set-Content`, which can garble ₹ and other symbols.
