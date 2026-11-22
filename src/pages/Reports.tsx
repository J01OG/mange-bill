import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { formatQty, friendlyError, istToday, type Unit } from '../lib/data';
import { formatIST, formatPaise } from '../lib/money';
import { addDays, fmtDay, longDay, parseDay, weekStart } from '../lib/orders';
import { DEMO, supabase } from '../lib/supabase';

interface Totals {
  bills: number;
  sales_paise: number;
  net_sales_paise: number;
  discount_paise: number;
  returns_paise: number;
  cash_sales_paise: number;
  upi_sales_paise: number;
  advance_used_paise: number;
  cash_out_paise: number;
  net_cash_paise: number;
  advance_cash_paise: number;
  advance_upi_paise: number;
  worker_paid_paise: number;
}
interface Dash {
  totals: Totals;
  by_day: { day: string; sales_paise: number; bills: number }[];
  top_products: { name: string; unit: Unit; qty: number; amount_paise: number }[];
}
interface Run {
  id: string;
  kind: 'daily' | 'manual' | 'backup';
  from_date: string;
  to_date: string;
  status: 'running' | 'done' | 'failed';
  storage_path: string | null;
  emailed_at: string | null;
  error: string | null;
  created_at: string;
}

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastmonth' | 'custom';
function presetRange(p: Preset): [string, string] {
  const t = istToday();
  const d = parseDay(t);
  switch (p) {
    case 'yesterday':
      return [addDays(t, -1), addDays(t, -1)];
    case 'week':
      return [weekStart(t), t];
    case 'month':
      return [fmtDay(new Date(d.getFullYear(), d.getMonth(), 1)), t];
    case 'lastmonth':
      return [fmtDay(new Date(d.getFullYear(), d.getMonth() - 1, 1)), fmtDay(new Date(d.getFullYear(), d.getMonth(), 0))];
    default:
      return [t, t];
  }
}

const CASH = '#15803d'; // brand green  } checked with the palette validator:
const UPI = '#2563eb'; //  blue         } colour-blind safe, 3:1 contrast on white

export function Reports() {
  const [preset, setPreset] = useState<Preset>('today');
  const [[from, to], setRange] = useState(presetRange('today'));
  const [dash, setDash] = useState<Dash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState<'download' | 'email' | null>(null);

  useEffect(() => {
    setDash(null);
    supabase.rpc('dashboard', { p_from: from, p_to: to }).then(({ data, error }) => {
      if (error) setError(friendlyError(error));
      else {
        setError(null);
        setDash(data as Dash);
      }
    });
  }, [from, to]);

  function choose(p: Preset) {
    setPreset(p);
    if (p !== 'custom') setRange(presetRange(p));
  }

  async function download() {
    if (DEMO) return setMsg({ kind: 'error', text: 'Excel download needs the real Supabase setup (not available in demo).' });
    setBusy('download');
    setMsg(null);
    const { data, error } = await supabase.functions.invoke('report', { body: { action: 'download', from, to } });
    setBusy(null);
    if (error || !(data instanceof Blob)) return setMsg({ kind: 'error', text: 'Could not make the Excel file. Is the "report" function deployed?' });
    const url = URL.createObjectURL(data);
    const a = document.createElement('a');
    a.href = url;
    a.download = from === to ? `farm-report-${from}.xlsx` : `farm-report-${from}-to-${to}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function emailNow() {
    if (DEMO) return setMsg({ kind: 'error', text: 'Email needs the real Supabase setup (not available in demo).' });
    setBusy('email');
    setMsg(null);
    const { data, error } = await supabase.functions.invoke('report', { body: { action: 'email', from, to } });
    setBusy(null);
    if (error) {
      let text = 'Could not send the email.';
      try {
        text = (await (error as { context: Response }).context.json()).error ?? text;
      } catch {
        /* keep default */
      }
      return setMsg({ kind: 'error', text });
    }
    setMsg({ kind: 'success', text: `Report emailed to ${(data as { sent_to: string[] }).sent_to.join(', ')}.` });
  }

  const t = dash?.totals;
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Reports</h2>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['week', 'This week'],
            ['month', 'This month'],
            ['lastmonth', 'Last month'],
            ['custom', 'Pick dates'],
          ] as [Preset, string][]
        ).map(([p, label]) => (
          <button
            key={p}
            onClick={() => choose(p)}
            className={`min-h-10 rounded-full px-3 text-sm font-semibold ring-1 ${
              preset === p ? 'bg-brand-800 text-white ring-brand-800' : 'bg-white text-gray-700 ring-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setRange([e.target.value, to])} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} min={from} max={istToday()} onChange={(e) => e.target.value && setRange([from, e.target.value])} />
          </Field>
        </div>
      )}
      <p className="text-sm text-gray-600">{from === to ? longDay(from) : `${longDay(from)} – ${longDay(to)}`}</p>

      {error && <Alert>{error}</Alert>}
      {!t ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Net sales" value={formatPaise(t.net_sales_paise)} big />
            <Stat label="Bills" value={String(t.bills)} sub={t.bills ? `avg ${formatPaise(Math.round(t.sales_paise / t.bills))}` : undefined} />
            <Stat label="Cash in hand (should be)" value={formatPaise(t.net_cash_paise)} />
            <Stat label="Discounts" value={formatPaise(t.discount_paise)} />
            <Stat label="Returns" value={formatPaise(t.returns_paise)} />
            <Stat label="Cash out" value={formatPaise(t.cash_out_paise)} />
            <Stat label="Order advances" value={formatPaise(t.advance_cash_paise + t.advance_upi_paise)} />
            <Stat label="Paid to workers" value={formatPaise(t.worker_paid_paise)} />
          </div>

          <PaySplit cash={t.cash_sales_paise} upi={t.upi_sales_paise} />
          {dash!.by_day.length > 1 && <DayBars days={dash!.by_day} />}

          <Card>
            <h3 className="mb-2 font-semibold">Top products</h3>
            {dash!.top_products.length === 0 ? (
              <p className="text-sm text-gray-500">No sales in this period.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 font-medium">Product</th>
                    <th className="py-1 text-right font-medium">Qty</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {dash!.top_products.map((p) => (
                    <tr key={p.name} className="border-t">
                      <td className="py-2">{p.name}</td>
                      <td className="py-2 text-right">{formatQty(Number(p.qty), p.unit)}</td>
                      <td className="py-2 text-right font-semibold">{formatPaise(p.amount_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={download} disabled={!!busy}>
          {busy === 'download' ? 'Making file…' : '⬇ Download Excel'}
        </Button>
        <Button variant="secondary" onClick={emailNow} disabled={!!busy}>
          {busy === 'email' ? 'Sending…' : '✉ Email this now'}
        </Button>
      </div>

      <DailyReportSettings />
      <History />
    </div>
  );
}

function Stat({ label, value, sub, big }: { label: string; value: string; sub?: string; big?: boolean }) {
  return (
    <Card className={big ? 'col-span-2 sm:col-span-1' : ''}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`font-bold ${big ? 'text-2xl' : 'text-lg'}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </Card>
  );
}

/** Cash vs UPI as one split bar, with a legend and direct labels (never colour alone). */
function PaySplit({ cash, upi }: { cash: number; upi: number }) {
  const total = cash + upi;
  const pc = total ? Math.round((cash / total) * 100) : 0;
  return (
    <Card>
      <h3 className="mb-2 font-semibold">Cash vs UPI</h3>
      {total === 0 ? (
        <p className="text-sm text-gray-500">No payments in this period.</p>
      ) : (
        <>
          <div className="flex h-4 gap-[2px] overflow-hidden rounded" role="img" aria-label={`Cash ${pc}%, UPI ${100 - pc}%`}>
            {cash > 0 && <div style={{ width: `${pc}%`, background: CASH }} title={`Cash ${formatPaise(cash)}`} />}
            {upi > 0 && <div style={{ width: `${100 - pc}%`, background: UPI }} title={`UPI ${formatPaise(upi)}`} />}
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: CASH }} /> Cash {formatPaise(cash)} ({pc}%)
            </span>
            <span className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: UPI }} /> UPI {formatPaise(upi)} ({100 - pc}%)
            </span>
          </div>
        </>
      )}
    </Card>
  );
}

/** Sales per day. One series, so no legend; tap a bar to see its value. */
function DayBars({ days }: { days: { day: string; sales_paise: number; bills: number }[] }) {
  const [pick, setPick] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.sales_paise), 1);
  const shown = pick !== null ? days[pick] : null;
  return (
    <Card>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">Sales by day</h3>
        <span className="text-sm text-gray-600">
          {shown ? `${longDay(shown.day)}: ${formatPaise(shown.sales_paise)} · ${shown.bills} bills` : `Best day ${formatPaise(max)}`}
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex h-36 items-end gap-[2px] border-b border-gray-300" style={{ minWidth: days.length * 10 }}>
          {days.map((d, i) => (
            <button
              key={d.day}
              onClick={() => setPick(i === pick ? null : i)}
              onMouseEnter={() => setPick(i)}
              aria-label={`${longDay(d.day)}: ${formatPaise(d.sales_paise)}`}
              className="flex h-full flex-1 items-end"
            >
              <span
                className="block w-full rounded-t"
                style={{
                  height: `${Math.max((d.sales_paise / max) * 100, d.sales_paise ? 2 : 0)}%`,
                  background: CASH,
                  opacity: pick === null || pick === i ? 1 : 0.45,
                }}
              />
            </button>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-xs text-gray-500">
          <span>{longDay(days[0].day)}</span>
          <span>{longDay(days[days.length - 1].day)}</span>
        </div>
      </div>
    </Card>
  );
}

const TIMES = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
  const label = new Date(2000, 0, 1, h, m).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return { value, label };
});

/** Owner chooses when the daily report goes out and who gets it. */
function DailyReportSettings() {
  const [enabled, setEnabled] = useState(true);
  const [time, setTime] = useState('19:00:00');
  const [emails, setEmails] = useState<string[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('report_enabled, report_time, report_emails')
      .single()
      .then(({ data }) => {
        if (data) {
          setEnabled(data.report_enabled ?? true);
          setTime((data.report_time ?? '19:00:00').slice(0, 8).padEnd(8, ':00'));
          setEmails(data.report_emails ?? []);
        }
        setLoaded(true);
      });
  }, []);

  function addEmail() {
    const e = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return setMsg({ kind: 'error', text: 'That email address does not look right.' });
    if (emails.includes(e)) return setMsg({ kind: 'error', text: 'Already in the list.' });
    if (emails.length >= 10) return setMsg({ kind: 'error', text: 'Up to 10 addresses.' });
    setEmails([...emails, e]);
    setNewEmail('');
    setDirty(true);
    setMsg(null);
  }

  async function save() {
    const { error } = await supabase
      .from('app_settings')
      .update({ report_enabled: enabled, report_time: time, report_emails: emails })
      .eq('id', true);
    if (error) setMsg({ kind: 'error', text: friendlyError(error) });
    else {
      setDirty(false);
      setMsg({ kind: 'success', text: 'Saved.' });
    }
  }

  if (!loaded) return null;
  const label = TIMES.find((x) => x.value === time)?.label ?? time;
  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">📧 Daily report by email</h3>
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="h-6 w-6 accent-brand-700"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setDirty(true);
          }}
        />
        Send the day's Excel report every day
      </label>
      <Field label="Send at (India time)">
        <Select
          value={time}
          disabled={!enabled}
          onChange={(e) => {
            setTime(e.target.value);
            setDirty(true);
          }}
        >
          {TIMES.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </Select>
      </Field>

      <div>
        <div className="mb-1 text-sm font-medium text-gray-700">Send to</div>
        {emails.length === 0 && <p className="text-sm text-gray-500">No addresses yet. Add at least one.</p>}
        <ul className="space-y-1">
          {emails.map((e) => (
            <li key={e} className="flex min-h-11 items-center justify-between rounded-xl bg-gray-50 px-3">
              <span className="truncate">{e}</span>
              <button
                aria-label={`Remove ${e}`}
                className="h-10 w-10 text-xl text-gray-500"
                onClick={() => {
                  setEmails(emails.filter((x) => x !== e));
                  setDirty(true);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Input
            type="email"
            placeholder="name@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addEmail()}
          />
          <Button variant="secondary" onClick={addEmail} disabled={!newEmail.trim()}>
            Add
          </Button>
        </div>
      </div>

      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Button className="w-full" disabled={!dirty} onClick={save}>
        Save
      </Button>
      <p className="text-xs text-gray-500">
        {enabled && emails.length
          ? `Goes out daily within 15 minutes after ${label} to ${emails.length} address(es). If you set a time that has already passed today, today's report goes out within 15 minutes.`
          : 'Daily email is off.'}
      </p>
    </Card>
  );
}

function History() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from('report_runs').select('*').order('created_at', { ascending: false }).limit(15);
    setRuns((data as Run[]) ?? []);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function open(path: string) {
    const { data, error } = await supabase.storage.from('reports').createSignedUrl(path, 120);
    if (error || !data) return setErr('Could not open the file.');
    window.location.href = data.signedUrl;
  }

  if (!runs) return null;
  return (
    <Card>
      <h3 className="mb-2 font-semibold">Sent reports</h3>
      {err && <Alert>{err}</Alert>}
      {runs.length === 0 ? (
        <p className="text-sm text-gray-500">None yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {runs.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="font-medium">
                  {r.kind === 'daily' ? 'Daily' : 'Sent by you'} · {r.from_date === r.to_date ? longDay(r.from_date) : `${longDay(r.from_date)} – ${longDay(r.to_date)}`}
                </div>
                <div className={`truncate text-xs ${r.status === 'failed' ? 'text-red-700' : 'text-gray-500'}`}>
                  {r.status === 'done' ? `Emailed ${r.emailed_at ? formatIST(r.emailed_at) : ''}` : r.status === 'running' ? 'Sending…' : `Failed: ${r.error ?? ''}`}
                </div>
              </div>
              {r.storage_path && (
                <button className="min-h-10 shrink-0 px-2 font-semibold text-brand-800" onClick={() => open(r.storage_path!)}>
                  ⬇ Excel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
