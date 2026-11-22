import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Field, Input, Spinner } from '../components/ui';
import { friendlyError, istToday } from '../lib/data';
import { supabase } from '../lib/supabase';
import { ATT, rateText, type AttStatus, type Worker } from '../lib/workforce';

const ORDER: AttStatus[] = ['present', 'half_day', 'absent', 'leave'];

/** Mark everyone for one day in a few taps, then save once. */
export function Attendance() {
  const [date, setDate] = useState(istToday());
  const [workers, setWorkers] = useState<Worker[] | null>(null);
  const [saved, setSaved] = useState<Record<string, AttStatus>>({});
  const [marks, setMarks] = useState<Record<string, AttStatus>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [w, a] = await Promise.all([
      supabase.from('workers').select('*').eq('active', true).order('name'),
      supabase.from('attendance').select('worker_id, status').eq('att_date', date),
    ]);
    if (w.error) return setMsg({ kind: 'error', text: friendlyError(w.error) });
    const m: Record<string, AttStatus> = {};
    for (const r of (a.data ?? []) as { worker_id: string; status: AttStatus }[]) m[r.worker_id] = r.status;
    setWorkers(w.data as Worker[]);
    setSaved(m);
    setMarks(m);
  }, [date]);

  useEffect(() => {
    setWorkers(null);
    load();
  }, [load]);

  const changes = useMemo(
    () => Object.entries(marks).filter(([id, s]) => saved[id] !== s).map(([worker_id, status]) => ({ worker_id, status })),
    [marks, saved],
  );
  const unmarked = (workers ?? []).filter((w) => !marks[w.id]).length;

  function allPresent() {
    const m = { ...marks };
    for (const w of workers ?? []) if (!m[w.id]) m[w.id] = 'present';
    setMarks(m);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc('mark_attendance', { p_date: date, p_entries: changes });
    setBusy(false);
    if (error) return setMsg({ kind: 'error', text: friendlyError(error) });
    setMsg({ kind: 'success', text: `Attendance saved for ${changes.length} worker(s). Day wages updated.` });
    load();
  }

  return (
    <div className="space-y-4 pb-24" style={{ paddingBottom: 'calc(6rem + var(--badge-gap))' }}>
      <h2 className="text-xl font-bold">Attendance</h2>
      <Field label="Date">
        <Input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || istToday())} />
      </Field>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      {!workers ? (
        <Spinner />
      ) : workers.length === 0 ? (
        <p className="text-gray-500">No active workers. Add them under Workforce.</p>
      ) : (
        <>
          {unmarked > 0 && (
            <Button variant="secondary" className="w-full" onClick={allPresent}>
              Mark the other {unmarked} as Present
            </Button>
          )}
          <ul className="divide-y rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            {workers.map((w) => (
              <li key={w.id} className="p-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{w.name}</span>
                  <span className="text-xs text-gray-500">{rateText(w)}</span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {ORDER.map((s) => {
                    const on = marks[w.id] === s;
                    return (
                      <button
                        key={s}
                        aria-pressed={on}
                        aria-label={`${w.name}: ${ATT[s].label}`}
                        onClick={() => setMarks({ ...marks, [w.id]: s })}
                        className={`min-h-12 rounded-xl text-base font-bold ring-1 ${on ? ATT[s].on : 'bg-white text-gray-700 ring-gray-300'}`}
                      >
                        {ATT[s].short}
                        <span className="block text-[10px] font-medium">{ATT[s].label}</span>
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="above-badge-bar fixed inset-x-0 z-20 border-t border-gray-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto max-w-3xl">
          <Button className="min-h-14 w-full text-lg" disabled={busy || changes.length === 0} onClick={save}>
            {busy ? 'Saving…' : changes.length ? `Save attendance (${changes.length})` : 'No changes to save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
