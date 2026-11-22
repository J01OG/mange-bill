import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input } from '../components/ui';
import { formatQty, friendlyError, newRef, type Unit } from '../lib/data';
import { formatIST, formatPaise } from '../lib/money';
import { MODE_LABEL } from '../lib/receipt';
import { supabase } from '../lib/supabase';

interface FoundItem {
  id: string;
  name: string;
  unit: Unit;
  qty: number;
  line_total_paise: number;
  returned_qty: number;
  returned_paise: number;
}
interface FoundBill {
  id: string;
  bill_no: string;
  created_at: string;
  status: 'active' | 'void';
  total_paise: number;
  customer_name: string | null;
  items: FoundItem[];
  returns: { return_no: string; created_at: string; amount_paise: number; refund_mode: 'cash' | 'upi'; reason: string | null }[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Same rule as create_return() in the database, to show the refund before saving. */
function refundFor(i: FoundItem, qty: number): number {
  const left = r3(i.qty - i.returned_qty);
  if (qty <= 0) return 0;
  return qty === left ? i.line_total_paise - i.returned_paise : Math.round((i.line_total_paise * qty) / i.qty);
}

export function Returns() {
  const [params] = useSearchParams();
  const [billNo, setBillNo] = useState(params.get('bill') ?? '');
  const [bill, setBill] = useState<FoundBill | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<'cash' | 'upi'>('cash');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [clientRef, setClientRef] = useState(newRef);

  async function find(e?: FormEvent, keepMessage = false) {
    e?.preventDefault();
    setError(null);
    if (!keepMessage) setDone(null);
    setBill(null);
    setQty({});
    if (!billNo.trim()) return;
    const { data, error } = await supabase.rpc('find_bill_for_return', { p_bill_no: billNo.trim() });
    if (error) return setError(friendlyError(error));
    if (!data) return setError('No bill found with that number.');
    setBill(data as FoundBill);
    setClientRef(newRef());
  }

  useEffect(() => {
    if (params.get('bill')) find();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refund = useMemo(
    () => (bill ? bill.items.reduce((s, i) => s + refundFor(i, qty[i.id] ?? 0), 0) : 0),
    [bill, qty],
  );

  function setItemQty(i: FoundItem, q: number) {
    const left = r3(i.qty - i.returned_qty);
    setQty((m) => ({ ...m, [i.id]: Math.min(Math.max(r3(q), 0), left) }));
    setClientRef(newRef());
  }

  async function save() {
    if (!bill) return;
    const items = Object.entries(qty)
      .filter(([, q]) => q > 0)
      .map(([bill_item_id, q]) => ({ bill_item_id, qty: q }));
    if (items.length === 0) return setError('Choose how many of which item is being returned.');
    setBusy(true);
    setError(null);
    const { data, error } = await supabase.rpc('create_return', {
      p_bill_id: bill.id,
      p_items: items,
      p_refund_mode: mode,
      p_reason: reason.trim() || null,
      p_client_ref: clientRef,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    const d = data as { return_no: string; amount_paise: number };
    setDone(`Return ${d.return_no} saved. Give back ${formatPaise(d.amount_paise)} by ${MODE_LABEL[mode]}.`);
    setReason('');
    find(undefined, true);
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">Returns / refunds</h2>
      {done && <Alert kind="success">{done}</Alert>}

      <form onSubmit={find} className="flex items-end gap-2">
        <div className="flex-1">
          <Field label="Bill number" hint="Full number, or just the last digits (e.g. 123)">
            <Input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="123" />
          </Field>
        </div>
        <Button type="submit" className="mb-5">
          Find
        </Button>
      </form>

      {error && <Alert>{error}</Alert>}

      {bill && (
        <>
          <Card>
            <div className="flex justify-between">
              <b>{bill.bill_no}</b>
              <b>{formatPaise(bill.total_paise)}</b>
            </div>
            <div className="text-sm text-gray-600">
              {formatIST(bill.created_at)}
              {bill.customer_name ? ` · ${bill.customer_name}` : ''}
            </div>
            {bill.returns.map((r) => (
              <div key={r.return_no} className="mt-1 text-sm text-gray-700">
                Already returned: {r.return_no} · {formatPaise(r.amount_paise)} ({MODE_LABEL[r.refund_mode]})
              </div>
            ))}
          </Card>

          {bill.status === 'void' ? (
            <Alert>This bill is void. Nothing can be returned.</Alert>
          ) : (
            <>
              <ul className="space-y-2">
                {bill.items.map((i) => {
                  const left = r3(i.qty - i.returned_qty);
                  const q = qty[i.id] ?? 0;
                  return (
                    <li key={i.id}>
                      <Card className={left === 0 ? 'opacity-60' : ''}>
                        <div className="font-semibold">{i.name}</div>
                        <div className="text-sm text-gray-600">
                          Bought {formatQty(i.qty, i.unit)} for {formatPaise(i.line_total_paise)}
                          {i.returned_qty > 0 && ` · returned ${formatQty(i.returned_qty, i.unit)}`}
                        </div>
                        {left > 0 ? (
                          <div className="mt-2 flex items-center justify-between gap-2">
                            {i.unit === 'kg' ? (
                              <Input
                                className="max-w-36"
                                inputMode="decimal"
                                placeholder={`max ${left} kg`}
                                value={q || ''}
                                onChange={(e) => setItemQty(i, Number(e.target.value.replace(/[^\d.]/g, '')) || 0)}
                              />
                            ) : (
                              <div className="flex items-center">
                                <button aria-label="One less" className="h-11 w-11 rounded-xl bg-gray-100 text-2xl" onClick={() => setItemQty(i, q - 1)}>
                                  −
                                </button>
                                <span className="w-14 text-center text-lg font-bold">
                                  {q}/{left}
                                </span>
                                <button aria-label="One more" className="h-11 w-11 rounded-xl bg-gray-100 text-2xl" onClick={() => setItemQty(i, q + 1)}>
                                  +
                                </button>
                              </div>
                            )}
                            <span className="font-semibold">{q > 0 ? formatPaise(refundFor(i, q)) : ''}</span>
                          </div>
                        ) : (
                          <div className="mt-1 text-sm font-medium text-gray-500">All returned</div>
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>

              <Card className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <Button variant={mode === 'cash' ? 'primary' : 'secondary'} onClick={() => setMode('cash')}>
                    💵 Cash refund
                  </Button>
                  <Button variant={mode === 'upi' ? 'primary' : 'secondary'} onClick={() => setMode('upi')}>
                    📱 UPI refund
                  </Button>
                </div>
                <Field label="Reason (optional)">
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Damaged packet" />
                </Field>
                <Button className="min-h-14 w-full text-lg" disabled={busy || refund <= 0} onClick={save}>
                  {busy ? 'Saving…' : `Save return · refund ${formatPaise(refund)}`}
                </Button>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
