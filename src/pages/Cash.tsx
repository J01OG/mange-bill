import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input, Sheet, Spinner } from '../components/ui';
import { friendlyError, istToday, newRef } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { supabase } from '../lib/supabase';

interface Summary {
  date: string;
  bills: number;
  sales_paise: number;
  discount_paise: number;
  cash_sales_paise: number;
  upi_sales_paise: number;
  cash_refunds_paise: number;
  upi_refunds_paise: number;
  cash_out_paise: number;
  advance_cash_paise?: number;
  advance_upi_paise?: number;
  net_cash_paise: number;
}
interface CashOutRow {
  id: string;
  created_at: string;
  amount_paise: number;
  reason: string;
  taken_by: string;
  voided: boolean;
  void_reason: string | null;
}

function Line({ label, value, minus, strong }: { label: string; value: number; minus?: boolean; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? 'border-t pt-2 text-xl font-bold' : ''}`}>
      <span>{label}</span>
      <span className={minus && value > 0 ? 'text-red-700' : ''}>
        {minus && value > 0 ? '−' : ''}
        {formatPaise(value)}
      </span>
    </div>
  );
}

export function Cash() {
  const { profile } = useAuth();
  const isOwner = profile?.role === 'owner';
  const [date, setDate] = useState(istToday());
  const [s, setS] = useState<Summary | null>(null);
  const [outs, setOuts] = useState<CashOutRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<CashOutRow | null>(null);

  const load = useCallback(async () => {
    const [sum, list] = await Promise.all([
      supabase.rpc('cash_summary', { p_date: date }),
      supabase.from('cash_out').select('*').eq('business_date', date).order('created_at', { ascending: false }),
    ]);
    if (sum.error) return setError(friendlyError(sum.error));
    setError(null);
    setS(sum.data as Summary);
    setOuts((list.data as CashOutRow[]) ?? []);
  }, [date]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">{isOwner ? 'Cash' : 'My cash today'}</h2>
        <Button onClick={() => setAdding(true)}>− Cash out</Button>
      </div>
      {isOwner && (
        <Field label="Date">
          <Input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || istToday())} />
        </Field>
      )}
      {error && <Alert>{error}</Alert>}

      {!s ? (
        <Spinner />
      ) : (
        <>
          <Card>
            <h3 className="mb-1 font-semibold">💵 Cash in the till</h3>
            <Line label="Cash sales" value={s.cash_sales_paise} />
            {!!s.advance_cash_paise && <Line label="Order advances (net)" value={s.advance_cash_paise} />}
            <Line label="Cash refunds" value={s.cash_refunds_paise} minus />
            <Line label="Cash out" value={s.cash_out_paise} minus />
            <Line label="Should be in hand" value={s.net_cash_paise} strong />
            <p className="mt-1 text-xs text-gray-500">
              {isOwner ? 'All cashiers.' : 'Only your own bills and entries today.'} Starting change money is not included.
            </p>
          </Card>
          <Card>
            <h3 className="mb-1 font-semibold">📱 UPI</h3>
            <Line label="UPI sales" value={s.upi_sales_paise} />
            {!!s.advance_upi_paise && <Line label="Order advances (net)" value={s.advance_upi_paise} />}
            <Line label="UPI refunds" value={s.upi_refunds_paise} minus />
          </Card>
          <Card>
            <Line label={`Sales (${s.bills} bills)`} value={s.sales_paise} />
            <Line label="Discounts given" value={s.discount_paise} />
          </Card>
        </>
      )}

      <h3 className="font-semibold">Cash out entries</h3>
      {outs.length === 0 ? (
        <p className="text-gray-500">None {date === istToday() ? 'today' : 'on this day'}.</p>
      ) : (
        <ul className="space-y-2">
          {outs.map((o) => (
            <li key={o.id}>
              <Card className={o.voided ? 'opacity-60' : ''}>
                <div className="flex justify-between">
                  <span className="font-semibold">{o.reason}</span>
                  <span className={`font-bold ${o.voided ? 'line-through' : ''}`}>{formatPaise(o.amount_paise)}</span>
                </div>
                <div className="text-sm text-gray-600">
                  Taken by {o.taken_by} ·{' '}
                  {new Date(o.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}
                  {o.voided && ` · CANCELLED: ${o.void_reason}`}
                </div>
                {isOwner && !o.voided && (
                  <button className="mt-1 min-h-10 text-sm text-red-700" onClick={() => setVoiding(o)}>
                    Cancel this entry
                  </button>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <CashOutSheet
          defaultTakenBy={profile?.full_name ?? ''}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            setDate(istToday());
            load();
          }}
        />
      )}
      {voiding && (
        <VoidCashOut
          row={voiding}
          onClose={() => setVoiding(null)}
          onDone={() => {
            setVoiding(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CashOutSheet({ defaultTakenBy, onClose, onDone }: { defaultTakenBy: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [takenBy, setTakenBy] = useState(defaultTakenBy);
  const [ref] = useState(newRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const paise = rupeesToPaise(amount);
    if (!paise) return setError('Enter the amount, like 500');
    setBusy(true);
    const { error } = await supabase.rpc('record_cash_out', {
      p_amount_paise: paise,
      p_reason: reason,
      p_taken_by: takenBy,
      p_client_ref: ref,
    });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone();
  }

  return (
    <Sheet title="Cash out (money taken from the till)" onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Amount (₹)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Diesel, tea, owner took home" />
        </Field>
        <Field label="Taken by">
          <Input value={takenBy} onChange={(e) => setTakenBy(e.target.value)} maxLength={100} />
        </Field>
        <Button className="w-full" disabled={busy || !amount || !reason.trim() || !takenBy.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save cash out'}
        </Button>
      </div>
    </Sheet>
  );
}

function VoidCashOut({ row, onClose, onDone }: { row: CashOutRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function run() {
    const { error } = await supabase.rpc('void_cash_out', { p_id: row.id, p_reason: reason });
    if (error) setError(friendlyError(error));
    else onDone();
  }
  return (
    <Sheet title={`Cancel cash out of ${formatPaise(row.amount_paise)}?`} onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Entered twice" />
        </Field>
        <Button variant="danger" className="w-full" disabled={reason.trim().length < 3} onClick={run}>
          Yes, cancel it
        </Button>
      </div>
    </Sheet>
  );
}
