# Security

This app handles shop takings and workers' pay, so security reports are taken seriously.

## Reporting a problem
Please **do not open a public issue** for a security problem.
Use GitHub's private reporting instead: the repository's **Security** tab → **Report a vulnerability**.
Include what you found, how to reproduce it, and what someone could do with it.

## Scope
In scope: the code in this repository, especially the database security rules (`supabase/migrations/`),
the server functions (`supabase/functions/`) and the login flow.

Out of scope: a particular farm's own deployment (each farm runs its own copy), and the Supabase,
Netlify and Brevo services themselves (report those to the provider).

## If you run your own copy
- Never put the Supabase **service_role / secret** key in the app or in `.env`. Only the public **anon** key goes there.
- Never commit your `.env` file. It is listed in `.gitignore`.
- Keep the off-site database backup in a **private** repository. The included workflow refuses to run in a public one.
- Turn off public sign-up in Supabase (Authentication → Sign In / Providers), as the setup guide says.
