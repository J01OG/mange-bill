import { useEffect, useState } from 'react';
import { Alert, Button, Card } from './ui';
import { longDay } from '../lib/orders';
import { DEMO, supabase } from '../lib/supabase';

interface Run {
  id: string;
  from_date: string;
  status: 'running' | 'done' | 'failed';
  storage_path: string | null;
  emailed_at: string | null;
  error: string | null;
}

/** Owner: nightly backups kept in Supabase (last 30), plus "download a backup now". */
export function Backups() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('report_runs')
      .select('id, from_date, status, storage_path, emailed_at, error')
      .eq('kind', 'backup')
      .order('created_at', { ascending: false })
      .limit(10)
      .then(({ data }) => setRuns((data as Run[]) ?? []));
  }, []);

  async function downloadNow() {
    if (DEMO) return setMsg('Backups need the real Supabase setup (not available in demo).');
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.functions.invoke('report', { body: { action: 'backup' } });
    setBusy(false);
    if (error || !(data instanceof Blob)) return setMsg('Could not make the backup. Is the "report" function deployed?');
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `farm-backup-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function open(path: string) {
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 120);
    if (error || !data) return setMsg('Could not open that backup (it may be older than 30 days).');
    window.location.href = data.signedUrl;
  }

  const last = runs?.find((r) => r.status === 'done');
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">🛟 Backups</h3>
      <p className="text-sm text-gray-600">
        Every night at 2 am the app saves a full copy of all records (one Excel sheet per table). The last 30 are kept here, and
        every Sunday's copy is also emailed to the report email list.
      </p>
      {runs && (
        <p className={`text-sm font-medium ${last ? 'text-brand-800' : 'text-amber-700'}`}>
          {last ? `Last backup: ${longDay(last.from_date)}` : 'No backup has run yet. See the setup guide, Phase 7.'}
        </p>
      )}
      {msg && <Alert>{msg}</Alert>}
      <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={downloadNow}>
        {busy ? 'Making backup…' : '⬇ Download a full backup now'}
      </Button>
      {runs && runs.length > 0 && (
        <ul className="divide-y text-sm">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span className={r.status === 'failed' ? 'text-red-700' : ''}>
                {longDay(r.from_date)} ·{' '}
                {r.status === 'done' ? (r.emailed_at ? 'saved & emailed' : 'saved') : r.status === 'running' ? 'running…' : `failed: ${r.error ?? ''}`}
              </span>
              {r.storage_path && r.status === 'done' && (
                <button
                  type="button"
                  aria-label={`Download backup of ${longDay(r.from_date)}`}
                  className="min-h-10 shrink-0 px-2 font-semibold text-brand-800"
                  onClick={() => open(r.storage_path!)}
                >
                  ⬇
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
