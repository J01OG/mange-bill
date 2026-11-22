// Joins supabase/migrations/*.sql (in order) into supabase/ALL-IN-ONE.sql for a fresh
// install, then proves the joined file installs cleanly in a throw-away Postgres.
// Usage: npm run sql:combine
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dir = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = files.map((f) => `-- ===== ${f} =====\n${readFileSync(new URL(f, dir), 'utf8')}`);
const header = `-- Mushroom Farm app — ALL database setup in one file (fresh install only).
-- Made by "npm run sql:combine" from supabase/migrations/${files[0]} … ${files.at(-1)}.
-- Paste into Supabase → SQL Editor → Run, ONCE, on a new project.
-- If you already ran some of the numbered files, run only the missing ones instead.\n\n`;
const all = header + parts.join('\n\n');
writeFileSync(new URL('../supabase/ALL-IN-ONE.sql', import.meta.url), all);

const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;`);
// Like a new Supabase project: no automatic grants, so 0009_grants.sql must do the work.
await db.exec(all);
const n = (await db.query(`select count(*)::int n from information_schema.tables where table_schema = 'public'`)).rows[0].n;
console.log(`wrote supabase/ALL-IN-ONE.sql from ${files.length} files; installs cleanly (${n} tables and views)`);
