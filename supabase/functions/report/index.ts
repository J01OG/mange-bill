// Supabase Edge Function: report
// Builds the Excel report (SheetJS) and emails it to the owner's email list.
//
//  * Timer (every 15 min, see supabase/schedule/1-report-timer.sql): header x-cron-secret,
//    body { run_id, date }. Saves the file to Storage and emails it.
//  * Owner from the app: body { action: "download" | "email", from, to }.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   CRON_SECRET      the value printed by 1-report-timer.sql
//   EMAIL_PROVIDER   "brevo" (default, sends to any address) or "resend" (needs your own domain)
//   EMAIL_API_KEY    the provider's API key
//   EMAIL_FROM       sender address you confirmed with the provider
//   EMAIL_FROM_NAME  optional, e.g. "Green Valley Farm"
//
// Deploy: Edge Functions → Deploy a new function → Via Editor → name "report" → paste → Deploy.
// Then turn OFF "Enforce JWT verification" for it (it checks callers itself).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
// SheetJS from npm (Supabase's editor blocks other download sites). This version has
// known issues only when READING untrusted Excel files; this function only WRITES them.
import * as XLSX from 'npm:xlsx@0.18.5';

type Row = Record<string, unknown>;
type ReportData = Record<string, Row[]>;

export const SHEETS = ['Summary', 'Bills', 'Items sold', 'Payments by mode', 'Returns', 'Cash out', 'Coupons used', 'Order advances'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** One sheet per section, with sensible column widths. Returns the .xlsx file bytes. */
export function buildWorkbook(data: ReportData): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const name of SHEETS) {
    const rows = data[name] ?? [];
    let ws;
    if (rows.length) {
      ws = XLSX.utils.json_to_sheet(rows);
      const keys = Object.keys(rows[0]);
      ws['!cols'] = keys.map((k) => ({
        wch: Math.min(45, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)) + 2),
      }));
    } else {
      ws = XLSX.utils.aoa_to_sheet([['Nothing in this period']]);
    }
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** Short HTML summary for the email body. */
export function emailHtml(farm: string, period: string, data: ReportData): string {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = (data.Summary ?? [])
    .map((r) => `<tr><td style="padding:4px 12px 4px 0">${esc(r.Item)}</td><td style="padding:4px 0;text-align:right"><b>${esc(r.Value)}</b></td></tr>`)
    .join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px">
    <h2 style="margin:0 0 4px">${esc(farm)}</h2><p style="margin:0 0 12px;color:#555">Report for ${esc(period)}</p>
    <table>${rows}</table>
    <p style="color:#555">The full report is attached as an Excel file.</p></div>`;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sendEmail(to: string[], subject: string, html: string, filename: string, bytes: Uint8Array) {
  const provider = (Deno.env.get('EMAIL_PROVIDER') ?? 'brevo').toLowerCase();
  const key = Deno.env.get('EMAIL_API_KEY');
  const from = Deno.env.get('EMAIL_FROM');
  const fromName = Deno.env.get('EMAIL_FROM_NAME') ?? 'Farm reports';
  if (!key || !from) throw new Error('Email is not set up: add EMAIL_API_KEY and EMAIL_FROM in Edge Function secrets.');
  const content = toBase64(bytes);

  const res =
    provider === 'resend'
      ? await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: `${fromName} <${from}>`, to, subject, html, attachments: [{ filename, content }] }),
        })
      : await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            sender: { name: fromName, email: from },
            to: to.map((email) => ({ email })),
            subject,
            htmlContent: html,
            attachment: [{ name: filename, content }],
          }),
        });
  if (!res.ok) throw new Error(`Email service (${provider}) refused: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

const isDate = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const nice = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

async function makeReport(admin: SupabaseClient, from: string, to: string) {
  const [{ data, error }, { data: s }] = await Promise.all([
    admin.rpc('report_data', { p_from: from, p_to: to }),
    admin.from('app_settings').select('farm_name, report_emails').single(),
  ]);
  if (error) throw new Error(error.message);
  const period = from === to ? nice(from) : `${nice(from)} to ${nice(to)}`;
  const filename = from === to ? `farm-report-${from}.xlsx` : `farm-report-${from}-to-${to}.xlsx`;
  return {
    bytes: buildWorkbook(data as ReportData),
    html: emailHtml(s?.farm_name ?? 'Farm', period, data as ReportData),
    subject: `${s?.farm_name ?? 'Farm'}: report for ${period}`,
    filename,
    emails: (s?.report_emails ?? []) as string[],
  };
}

// ---------------------------------------------------------------------------
// Full backup: every table, one sheet each. Nothing is left out except the
// timer's own secret. Values that are lists/objects are stored as JSON text.
// ---------------------------------------------------------------------------
export const BACKUP_TABLES: [table: string, order: string[]][] = [
  ['app_settings', ['id']],
  ['profiles', ['created_at', 'id']],
  ['products', ['created_at', 'id']],
  ['customers', ['created_at', 'id']],
  ['coupons', ['created_at', 'id']],
  ['coupon_products', ['coupon_id', 'product_id']],
  ['bills', ['created_at', 'id']],
  ['bill_items', ['created_at', 'id']],
  ['payments', ['created_at', 'id']],
  ['returns', ['created_at', 'id']],
  ['return_items', ['created_at', 'id']],
  ['cash_out', ['created_at', 'id']],
  ['workers', ['created_at', 'id']],
  ['attendance', ['created_at', 'id']],
  ['worker_transactions', ['created_at', 'id']],
  ['orders', ['created_at', 'id']],
  ['order_items', ['created_at', 'id']],
  ['order_payments', ['created_at', 'id']],
  ['doc_counters', ['key']],
  ['report_runs', ['created_at', 'id']],
  ['audit_log', ['id']],
];
const KEEP_BACKUPS = 30;

export function backupWorkbook(tables: Record<string, Row[]>, takenAt: string): Uint8Array {
  const wb = XLSX.utils.book_new();
  const info = [
    { Item: 'Backup taken (UTC)', Value: takenAt },
    ...BACKUP_TABLES.map(([t]) => ({ Item: `Rows in ${t}`, Value: (tables[t] ?? []).length })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(info), 'About this backup');
  for (const [t] of BACKUP_TABLES) {
    const rows = (tables[t] ?? []).map((r) =>
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v])),
    );
    const ws = rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['(empty)']]);
    XLSX.utils.book_append_sheet(wb, ws, t.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', compression: true }));
}

async function readAll(admin: SupabaseClient, table: string, order: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from(table).select('*');
    for (const col of order) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
    out.push(...((data ?? []) as Row[]));
    if (!data || data.length < 1000) return out;
  }
}

async function makeBackup(admin: SupabaseClient) {
  const tables: Record<string, Row[]> = {};
  for (const [t, order] of BACKUP_TABLES) tables[t] = await readAll(admin, t, order);
  return backupWorkbook(tables, new Date().toISOString());
}

/** Keeps the newest KEEP_BACKUPS files in Storage → backups/. */
async function pruneBackups(admin: SupabaseClient) {
  const { data } = await admin.storage.from('reports').list('backups', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  const old = (data ?? []).slice(KEEP_BACKUPS).map((f) => `backups/${f.name}`);
  if (old.length) await admin.storage.from('reports').remove(old);
}

async function nightlyBackup(admin: SupabaseClient, runId: string, date: string): Promise<Response> {
  try {
    const bytes = await makeBackup(admin);
    const path = `backups/backup-${date}.xlsx`;
    const up = await admin.storage.from('reports').upload(path, bytes, {
      upsert: true,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    if (up.error) throw new Error(`Saving the backup failed: ${up.error.message}`);
    await admin.from('report_runs').update({ storage_path: path }).eq('id', runId);
    await pruneBackups(admin);

    // Sundays (India time): also email it, so a copy lives outside Supabase.
    const sunday = new Date(`${date}T12:00:00+05:30`).getUTCDay() === 0;
    const { data: s } = await admin.from('app_settings').select('farm_name, report_emails').single();
    const emails = (s?.report_emails ?? []) as string[];
    let emailed: string | null = null;
    if (sunday && emails.length && bytes.length < 8_000_000) {
      await sendEmail(
        emails,
        `${s?.farm_name ?? 'Farm'}: weekly backup ${nice(date)}`,
        `<p>Attached is a full backup of the farm app (every table, one sheet each), taken ${nice(date)}.</p>
         <p>Keep this email. Daily backups for the last ${KEEP_BACKUPS} days are also in the app under Farm settings → Backups.</p>`,
        `farm-backup-${date}.xlsx`,
        bytes,
      );
      emailed = new Date().toISOString();
    }
    await admin.from('report_runs').update({ status: 'done', emailed_at: emailed, error: null }).eq('id', runId);
    return json(200, { ok: true, bytes: bytes.length });
  } catch (e) {
    await admin.from('report_runs').update({ status: 'failed', error: String((e as Error).message).slice(0, 500) }).eq('id', runId);
    return json(500, { error: (e as Error).message });
  }
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const body = await req.json().catch(() => ({}));

  // ---- 1. The daily timer --------------------------------------------------
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret !== null) {
    if (!Deno.env.get('CRON_SECRET') || cronSecret !== Deno.env.get('CRON_SECRET')) return json(401, { error: 'Bad secret' });
    if (!isDate(body.date) || typeof body.run_id !== 'string') return json(400, { error: 'Bad request' });
    if (body.kind === 'backup') return nightlyBackup(admin, body.run_id, body.date);
    try {
      const r = await makeReport(admin, body.date, body.date);
      const path = `daily/${r.filename}`;
      const up = await admin.storage.from('reports').upload(path, r.bytes, {
        upsert: true,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      if (up.error) throw new Error(`Saving the file failed: ${up.error.message}`);
      await admin.from('report_runs').update({ storage_path: path }).eq('id', body.run_id);
      await sendEmail(r.emails, r.subject, r.html, r.filename, r.bytes);
      await admin.from('report_runs').update({ status: 'done', emailed_at: new Date().toISOString(), error: null }).eq('id', body.run_id);
      return json(200, { ok: true });
    } catch (e) {
      await admin.from('report_runs').update({ status: 'failed', error: String((e as Error).message).slice(0, 500) }).eq('id', body.run_id);
      return json(500, { error: (e as Error).message });
    }
  }

  // ---- 2. The owner, from the app -----------------------------------------
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller } = await admin.auth.getUser(jwt);
  if (!caller?.user) return json(401, { error: 'Please log in again.' });
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', caller.user.id).single();
  if (!me || me.role !== 'owner' || !me.active) return json(403, { error: 'Only the owner can get reports.' });

  const { action, from, to } = body;

  // Owner's "Download full backup now" button.
  if (action === 'backup') {
    try {
      const bytes = await makeBackup(admin);
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(bytes, {
        headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="farm-backup-${stamp}.xlsx"` },
      });
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  if (!isDate(from) || !isDate(to) || to < from) return json(400, { error: 'Choose a valid date range.' });

  try {
    const r = await makeReport(admin, from, to);
    if (action === 'download') {
      return new Response(r.bytes, {
        headers: {
          ...cors,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${r.filename}"`,
        },
      });
    }
    if (action === 'email') {
      if (r.emails.length === 0) return json(400, { error: 'Add at least one email address first.' });
      const { data: run } = await admin
        .from('report_runs')
        .insert({ kind: 'manual', from_date: from, to_date: to, status: 'running', triggered_by: caller.user.id })
        .select('id')
        .single();
      try {
        await sendEmail(r.emails, r.subject, r.html, r.filename, r.bytes);
        await admin.from('report_runs').update({ status: 'done', emailed_at: new Date().toISOString() }).eq('id', run!.id);
      } catch (e) {
        await admin.from('report_runs').update({ status: 'failed', error: String((e as Error).message).slice(0, 500) }).eq('id', run!.id);
        throw e;
      }
      return json(200, { ok: true, sent_to: r.emails });
    }
    return json(400, { error: 'Unknown action.' });
  } catch (e) {
    console.error(e);
    return json(500, { error: (e as Error).message });
  }
}

// REPORT_TEST is set only by the local test (report_test.ts), so the server is not started there.
if (!Deno.env.get('REPORT_TEST')) Deno.serve(handle);
