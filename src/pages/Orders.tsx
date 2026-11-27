import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, buttonClass, Card, Spinner } from '../components/ui';
import { friendlyError, istToday } from '../lib/data';
import { formatPaise } from '../lib/money';
import { addDays, fmtDay, isOpen, longDay, parseDay, STATUS, weekStart, type OrderRow } from '../lib/orders';
import { supabase } from '../lib/supabase';

type View = 'month' | 'week' | 'day';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function range(view: View, anchor: string): [string, string] {
  if (view === 'day') return [anchor, anchor];
  if (view === 'week') {
    const s = weekStart(anchor);
    return [s, addDays(s, 6)];
  }
  const d = parseDay(anchor);
  const first = fmtDay(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = fmtDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  return [weekStart(first), addDays(weekStart(last), 6)]; // full weeks for the grid
}

export function Orders() {
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(istToday());
  const [showClosed, setShowClosed] = useState(false);
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [late, setLate] = useState<OrderRow[]>([]);
  const [from, to] = range(view, anchor);

  useEffect(() => {
    setRows(null);
    supabase
      .from('order_overview')
      .select('*')
      .gte('delivery_date', from)
      .lte('delivery_date', to)
      .order('delivery_date')
      .order('created_at')
      .then(({ data, error }) => {
        if (error) setError(friendlyError(error));
        else setRows(data as OrderRow[]);
      });
  }, [from, to]);

  // Open orders whose delivery day has passed: deliver them, or move the date.
  useEffect(() => {
    supabase
      .from('order_overview')
      .select('*')
      .lt('delivery_date', istToday())
      .in('status', ['pending', 'advance_paid', 'ready'])
      .order('delivery_date')
      .then(({ data }) => setLate((data ?? []) as OrderRow[]));
  }, []);

  const shown = useMemo(() => (rows ?? []).filter((r) => showClosed || r.status !== 'cancelled'), [rows, showClosed]);
  const byDay = useMemo(() => {
    const m: Record<string, OrderRow[]> = {};
    for (const r of shown) (m[r.delivery_date] ??= []).push(r);
    return m;
  }, [shown]);

  const step = (n: number) => {
    if (view === 'day') setAnchor(addDays(anchor, n));
    else if (view === 'week') setAnchor(addDays(anchor, 7 * n));
    else {
      const d = parseDay(anchor);
      setAnchor(fmtDay(new Date(d.getFullYear(), d.getMonth() + n, 1)));
    }
  };
  const title =
    view === 'month'
      ? parseDay(anchor).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${longDay(from)} – ${longDay(to)}`
        : longDay(anchor);

  const openRows = shown.filter((r) => isOpen(r.status) && (view !== 'month' || r.delivery_date.slice(0, 7) === anchor.slice(0, 7)));
  const due = openRows.reduce((s, r) => s + r.balance_paise, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Orders</h2>
        {
          <Link to="/orders/new" className={buttonClass('primary')}>
            + New order
          </Link>
        }
      </div>
      {error && <Alert>{error}</Alert>}
      {late.length > 0 && (
        <section className="space-y-2 rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-300">
          <h3 className="font-semibold text-amber-900">⚠️ Date passed, not delivered yet ({late.length})</h3>
          <p className="text-sm text-amber-900">Open one to deliver it now, or Edit it to move the date.</p>
          <OrderList rows={late} />
        </section>
      )}

      {
        <>
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-gray-100 p-1">
            {(['month', 'week', 'day'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`min-h-11 rounded-lg text-sm font-semibold capitalize ${view === v ? 'bg-white shadow' : 'text-gray-600'}`}
              >
                {v}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <button aria-label="Previous" className="h-11 w-11 rounded-xl bg-white text-xl ring-1 ring-gray-200" onClick={() => step(-1)}>
              ‹
            </button>
            <button className="min-h-11 px-2 text-center font-semibold" onClick={() => setAnchor(istToday())} title="Go to today">
              {title}
            </button>
            <button aria-label="Next" className="h-11 w-11 rounded-xl bg-white text-xl ring-1 ring-gray-200" onClick={() => step(1)}>
              ›
            </button>
          </div>
        </>
      }

      <Card className="flex items-center justify-between">
        <span className="text-sm text-gray-600">{openRows.length} open order(s) · balance to collect</span>
        <span className="text-lg font-bold">{formatPaise(due)}</span>
      </Card>

      {!rows ? (
        <Spinner />
      ) : view === 'month' ? (
        <MonthGrid
          from={from}
          to={to}
          anchor={anchor}
          byDay={byDay}
          onPick={(d) => {
            setAnchor(d);
            setView('day');
          }}
        />
      ) : view === 'week' ? (
        <div className="space-y-3">
          {Array.from({ length: 7 }, (_, i) => addDays(from, i)).map((d) => (
            <section key={d}>
              <h3 className={`mb-1 text-sm font-semibold ${d === istToday() ? 'text-brand-800' : 'text-gray-700'}`}>
                {longDay(d)} {d === istToday() && '· today'}
              </h3>
              {(byDay[d] ?? []).length === 0 ? <p className="text-sm text-gray-400">No deliveries</p> : <OrderList rows={byDay[d]} />}
            </section>
          ))}
        </div>
      ) : (byDay[anchor] ?? []).length === 0 ? (
        <p className="text-center text-gray-500">No deliveries on this day.</p>
      ) : (
        <OrderList rows={byDay[anchor]} />
      )}

      {
        <label className="flex min-h-11 items-center gap-3 text-sm text-gray-700">
          <input
            type="checkbox"
            className="h-5 w-5 accent-brand-700"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Show cancelled orders
        </label>
      }
    </div>
  );
}

function MonthGrid({
  from,
  to,
  anchor,
  byDay,
  onPick,
}: {
  from: string;
  to: string;
  anchor: string;
  byDay: Record<string, OrderRow[]>;
  onPick: (d: string) => void;
}) {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const month = anchor.slice(0, 7);
  const today = istToday();

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-xs font-semibold text-gray-500">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const list = byDay[d] ?? [];
          const open = list.filter((r) => isOpen(r.status));
          const due = open.reduce((s, r) => s + r.balance_paise, 0);
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              aria-label={`${longDay(d)}: ${list.length} order(s)`}
              className={`flex min-h-16 flex-col items-center rounded-lg p-1 text-xs ring-1 ${
                d.slice(0, 7) === month ? 'bg-white ring-gray-200' : 'bg-gray-50 text-gray-400 ring-gray-100'
              } ${d === today ? 'ring-2 ring-brand-700' : ''}`}
            >
              <span className="font-semibold">{Number(d.slice(8))}</span>
              {list.length > 0 && (
                <span
                  className={`mt-1 rounded-full px-1.5 font-bold ${open.length ? 'bg-brand-700 text-white' : 'bg-gray-200 text-gray-700'}`}
                >
                  {list.length}
                </span>
              )}
              {due > 0 && <span className="mt-0.5 text-[10px] leading-tight text-gray-600">₹{Math.round(due / 100)}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-gray-500">Number = orders that day. ₹ = balance still to collect. Tap a day to see its orders.</p>
    </div>
  );
}

function OrderList({ rows }: { rows: OrderRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id}>
          <Link to={`/orders/${r.id}`}>
            <Card className={`space-y-1 ${r.status === 'cancelled' ? 'opacity-60' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{r.customer_name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
              </div>
              <div className="flex justify-between text-sm text-gray-600">
                <span>
                  {r.order_no} · {r.item_count} item(s){r.delivery_note ? ` · ${r.delivery_note}` : ''}
                </span>
                {isOpen(r.status) && <span className="font-semibold text-gray-900">Due {formatPaise(r.balance_paise)}</span>}
              </div>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
