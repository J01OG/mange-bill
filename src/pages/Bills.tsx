import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Card, Field, Input, Spinner } from '../components/ui';
import { friendlyError, istToday } from '../lib/data';
import { formatPaise } from '../lib/money';
import { MODE_LABEL } from '../lib/receipt';
import { supabase } from '../lib/supabase';

interface Row {
  id: string;
  bill_no: string;
  created_at: string;
  customer_name: string | null;
  total_paise: number;
  status: 'active' | 'void';
  payments: { mode: 'cash' | 'upi' | 'advance'; amount_paise: number }[];
}

export function Bills() {
  const { profile } = useAuth();
  const isOwner = profile?.role === 'owner';
  const [date, setDate] = useState(istToday());
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    supabase
      .from('bills')
      .select('id, bill_no, created_at, customer_name, total_paise, status, payments(mode, amount_paise)')
      .eq('business_date', date)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(friendlyError(error));
        else setRows(data as Row[]);
      });
  }, [date]);

  const active = (rows ?? []).filter((r) => r.status === 'active');
  const sum = (mode: string) =>
    active
      .flatMap((r) => r.payments)
      .filter((p) => p.mode === mode)
      .reduce((s, p) => s + p.amount_paise, 0);
  const total = active.reduce((s, r) => s + r.total_paise, 0);

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">{isOwner ? 'Bills' : 'My bills today'}</h2>
      {isOwner && (
        <Field label="Date">
          <Input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || istToday())} />
        </Field>
      )}
      {error && <Alert>{error}</Alert>}

      <div className="grid grid-cols-3 gap-2">
        <Card className="text-center">
          <div className="text-xs text-gray-500">Cash</div>
          <div className="text-lg font-bold">{formatPaise(sum('cash'))}</div>
        </Card>
        <Card className="text-center">
          <div className="text-xs text-gray-500">UPI</div>
          <div className="text-lg font-bold">{formatPaise(sum('upi'))}</div>
        </Card>
        <Card className="text-center">
          <div className="text-xs text-gray-500">Total ({active.length})</div>
          <div className="text-lg font-bold">{formatPaise(total)}</div>
        </Card>
      </div>
      <p className="text-xs text-gray-500">
        Cancelled bills are not counted. For cash in hand after refunds and cash-outs, open the Cash tab.
      </p>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-center text-gray-500">No bills on this day.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={`/bills/${r.id}`}>
                <Card className={`flex items-center justify-between ${r.status === 'void' ? 'opacity-60' : ''}`}>
                  <div>
                    <div className="font-semibold">{r.bill_no}</div>
                    <div className="text-sm text-gray-600">
                      {new Date(r.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
                      {r.customer_name ? ` · ${r.customer_name}` : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-bold ${r.status === 'void' ? 'line-through' : ''}`}>{formatPaise(r.total_paise)}</div>
                    <div className="text-xs text-gray-600">
                      {r.status === 'void'
                        ? 'VOID'
                        : paidModes(r.payments)
                            .map((m) => MODE_LABEL[m])
                            .join(' + ')}
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Modes that were really paid, once each (a changed payment adds correction lines). */
function paidModes(pays: { mode: 'cash' | 'upi' | 'advance'; amount_paise: number }[]) {
  const net = new Map<'cash' | 'upi' | 'advance', number>();
  pays.forEach((p) => net.set(p.mode, (net.get(p.mode) ?? 0) + p.amount_paise));
  return [...net].filter(([, a]) => a !== 0).map(([m]) => m);
}
