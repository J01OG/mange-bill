# Contributing

Thanks for helping! This app is used by people who are not programmers, so **simple, reliable and well-explained**
matters more than clever.

## Before you start
- For anything bigger than a small fix, open an issue first to describe the problem or idea.
- Keep it free to run. New features must work on the free plans of Supabase, Netlify and Brevo.

## Setting up
```bash
npm install
npm run demo        # the app with made-up data, no Supabase needed
npm run test:db     # must say "0 failed"
```

## Rules that keep the app safe
1. **Money logic lives in the database.** Bills, payments, returns, wages and orders are written only through the
   checked SQL functions in `supabase/migrations/`. The app never sends a price or total that the server trusts.
2. **Never delete or edit financial rows.** Use void/reversal patterns, as the existing tables do.
3. **Every table has Row Level Security.** Add policies, and add tests in `scripts/test-db.mjs` proving who can and cannot see or change it.
4. **Database changes go in a new numbered file** in `supabase/migrations/`. Never edit a file that has already been released.
   Then run `npm run sql:combine` to refresh `supabase/ALL-IN-ONE.sql`.
5. **New tables must be added to `BACKUP_TABLES`** in `supabase/functions/report/index.ts`. A test fails otherwise.
6. **Store money as whole paise** (integers) and dates as the IST `business_date`.
7. **Demo mode:** if you add a database call, teach `src/dev/mockSupabase.ts` about it so `npm run demo` keeps working.
8. **Write for the farm owner.** Screen text and guides should use plain words and short steps.

## Checks before a pull request
```bash
npm run test:db                      # new-style Supabase (strict)
SUPABASE_STYLE=old npm run test:db   # old-style Supabase
npm run test:report                  # Excel builder
npm run build
```
If you changed a screen, describe how you tested it at phone size, and add a screenshot if you can.

## Text files
Save files as UTF-8 **without** a BOM. On Windows, avoid PowerShell `Get-Content`/`Set-Content` for editing,
because they can garble symbols like ₹ and —. Use an editor such as VS Code.
