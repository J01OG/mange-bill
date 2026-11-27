import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CashUpiInputs, cashUpiLines, cashUpiTotal, type CashUpi } from '../components/CashUpiInputs';
import { Alert, Button, buttonClass, Card, Field, Input, Sheet, Spinner } from '../components/ui';
import { UpiQr } from '../components/UpiQr';
import { formatQty, friendlyError, istToday, newRef, useProducts, useSettings } from '../lib/data';
import { formatIST, formatPaise, rupeesToPaise } from '../lib/money';
import { isOpen, longDay, STATUS, type OrderItem, type OrderPayment, type OrderRow } from '../lib/orders';
import { displayPhone } from '../lib/phone';
import { supabase } from '../lib/supabase';

export function OrderView() {
  const { id } = useParams();
  const [o, setO] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [pays, setPays] = useState<OrderPayment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'advance' | 'refund' | 'cancel' | 'deliver' | null>(null);
  const [switching, setSwitching] = useState<OrderPayment | null>(null);

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase.from('order_overview').select('*').eq('id', id!).maybeSingle(),
      supabase.from('order_items').select('*').eq('order_id', id!).order('created_at'),
      supabase.from('order_payments').select('*').eq('order_id', id!).order('created_at'),
    ]);
    if (a.error) return setError(friendlyError(a.error));
    if (!a.data) return setError('Order not found.');
    setO(a.data as OrderRow);
    setItems((b.data ?? []) as OrderItem[]);
    setPays((c.data ?? []) as OrderPayment[]);
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!o) return <Spinner />;
  const open = isOpen(o.status);
  const today = istToday();
  // Money per mode, with switched payments already moved to the right mode.
  const net = (mode: 'cash' | 'upi') =>
    pays.filter((p) => p.mode === mode).reduce((s, p) => s + (p.kind === 'advance' ? p.amount_paise : -p.amount_paise), 0);
  const shownPays = pays.filter((p) => !p.corrects_id);
  const switchedTo = (p: OrderPayment) => (pays.some((c) => c.corrects_id === p.id) ? (p.mode === 'cash' ? 'UPI' : 'Cash') : null);

  async function toggleReady() {
    const { error } = await supabase.rpc('set_order_ready', { p_order_id: o!.id, p_ready: o!.status !== 'ready' });
    if (error) setError(friendlyError(error));
    else load();
  }
  function done(m: string) {
    setSheet(null);
    setFlash(m);
    load();
  }

  return (
    <div className="space-y-4">
      {flash && <Alert kind="success">{flash}</Alert>}
      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm text-gray-500">{o.order_no}</div>
            <h2 className="text-xl font-bold">{o.customer_name}</h2>
            {o.customer_phone && (
              <a className="text-brand-800 underline" href={`tel:+${o.customer_phone}`}>
                {displayPhone(o.customer_phone)}
              </a>
            )}
          </div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${STATUS[o.status].cls}`}>{STATUS[o.status].label}</span>
        </div>
        <div className="mt-2 font-semibold">
          🚚 {longDay(o.delivery_date)}
          {o.delivery_note ? ` · ${o.delivery_note}` : ''}
        </div>
        {open && o.delivery_date !== today && (
          <p className="text-sm text-amber-800">
            {o.delivery_date < today ? 'Date has passed. Deliver now, or Edit to move the date.' : 'Delivering early is fine.'}
          </p>
        )}
        {o.notes && <p className="mt-1 text-sm text-gray-600">{o.notes}</p>}
        {o.cancel_reason && <p className="mt-1 text-sm text-red-700">Cancelled: {o.cancel_reason}</p>}
      </Card>

      <Card>
        <ul className="divide-y">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-2 py-2">
              <span>
                {i.product_name}
                <span className="block text-sm text-gray-600">
                  {formatQty(Number(i.qty), i.unit)} × {formatPaise(i.unit_price_paise)}
                </span>
              </span>
              <span className="font-semibold">{formatPaise(i.line_total_paise)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 space-y-1 border-t pt-2">
          <div className="flex justify-between font-semibold">
            <span>Order total</span>
            <span>{formatPaise(o.subtotal_paise)}</span>
          </div>
          <div className="flex justify-between text-blue-800">
            <span>Paid so far</span>
            <span>{formatPaise(o.advance_paise)}</span>
          </div>
          {o.advance_paise > 0 && (
            <div className="text-right text-xs text-gray-500">
              Cash {formatPaise(net('cash'))} · UPI {formatPaise(net('upi'))}
            </div>
          )}
          {open && (
            <div className="flex justify-between text-lg font-bold">
              <span>Balance due on delivery</span>
              <span>{formatPaise(o.balance_paise)}</span>
            </div>
          )}
        </div>
      </Card>

      {o.status === 'delivered' && o.bill_id && (
        <Link to={`/bills/${o.bill_id}`} className={buttonClass('secondary', 'w-full')}>
          🧾 Open the bill
        </Link>
      )}

      {open && (
        <Button className="min-h-14 w-full text-lg" onClick={() => setSheet('deliver')}>
          🚚 Deliver & make bill
        </Button>
      )}

      {open && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setSheet('advance')}>
            + Take payment
          </Button>
          <Button variant="secondary" onClick={toggleReady}>
            {o.status === 'ready' ? 'Mark not ready' : '📦 Mark ready'}
          </Button>
          <Link to={`/orders/${o.id}/edit`} className={buttonClass('secondary')}>
            ✏️ Edit order
          </Link>
          <Button variant="secondary" disabled={o.advance_paise <= 0} onClick={() => setSheet('refund')}>
            Give money back
          </Button>
          <Button variant="ghost" className="col-span-2 text-red-700" onClick={() => setSheet('cancel')}>
            Cancel this order
          </Button>
        </div>
      )}

      {shownPays.length > 0 && (
        <section>
          <h3 className="mb-2 font-semibold">Payments for this order</h3>
          <ul className="divide-y rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            {shownPays.map((p) => {
              const moved = switchedTo(p);
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 p-3 text-sm">
                  <span className="min-w-0">
                    {p.kind === 'advance' ? 'Received' : 'Given back'} ·{' '}
                    {moved ? (
                      <>
                        <s className="text-gray-400">{p.mode === 'cash' ? 'Cash' : 'UPI'}</s> <b>{moved}</b>
                      </>
                    ) : p.mode === 'cash' ? (
                      'Cash'
                    ) : (
                      'UPI'
                    )}
                    <span className="block text-xs text-gray-500">
                      {formatIST(p.created_at)}
                      {p.note ? ` · ${p.note}` : ''}
                      {moved ? ` · ${pays.find((c) => c.corrects_id === p.id)?.note ?? ''}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className={`font-semibold ${p.kind === 'refund' ? 'text-red-700' : ''}`}>
                      {p.kind === 'refund' ? '−' : '+'}
                      {formatPaise(p.amount_paise)}
                    </span>
                    {!moved && (
                      <button
                        className="min-h-10 rounded-lg bg-gray-100 px-2 text-xs font-semibold"
                        onClick={() => setSwitching(p)}
                        aria-label={`Change this payment to ${p.mode === 'cash' ? 'UPI' : 'cash'}`}
                      >
                        ⇄ {p.mode === 'cash' ? 'UPI' : 'Cash'}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {switching && (
        <SwitchSheet
          payment={switching}
          onClose={() => setSwitching(null)}
          onDone={(m) => {
            setSwitching(null);
            done(m);
          }}
        />
      )}
      {(sheet === 'advance' || sheet === 'refund') && <PaymentSheet order={o} kind={sheet} onClose={() => setSheet(null)} onDone={done} />}
      {sheet === 'cancel' && <CancelSheet order={o} onClose={() => setSheet(null)} onDone={done} />}
      {sheet === 'deliver' && <DeliverSheet order={o} items={items} onClose={() => setSheet(null)} />}
    </div>
  );
}

function PaymentSheet({
  order,
  kind,
  onClose,
  onDone,
}: {
  order: OrderRow;
  kind: 'advance' | 'refund';
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const max = kind === 'advance' ? order.subtotal_paise - order.advance_paise : order.advance_paise;
  const [pay, setPay] = useState<CashUpi>({ cash: '', upi: '' });
  const [note, setNote] = useState('');
  const [ref] = useState(newRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lines = cashUpiLines(pay);
  const total = cashUpiTotal(pay);

  async function save() {
    if (!lines || lines.length === 0) return setError('Enter the cash or UPI amount (or both).');
    if (total > max) return setError(`At most ${formatPaise(max)}.`);
    setBusy(true);
    const { error } = await supabase.rpc('take_order_payment', {
      p_order_id: order.id,
      p_kind: kind,
      p_payments: lines,
      p_note: note || null,
      p_client_ref: ref,
    });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone(`${kind === 'advance' ? 'Received' : 'Gave back'} ${formatPaise(total)}.`);
  }

  return (
    <Sheet title={kind === 'advance' ? 'Take payment' : 'Give money back'} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          {kind === 'advance'
            ? `Balance left: ${formatPaise(max)}. Take part now and the rest on any other day.`
            : `Paid so far: ${formatPaise(max)}`}
        </p>
        {error && <Alert>{error}</Alert>}
        <CashUpiInputs value={pay} onChange={setPay} />
        {kind === 'advance' && max > 0 && (
          <div className="flex flex-wrap gap-2 text-sm">
            <button
              type="button"
              className="min-h-10 rounded-xl bg-gray-100 px-3 font-semibold"
              onClick={() => setPay({ cash: String(max / 100), upi: '' })}
            >
              Full balance in cash
            </button>
            <button
              type="button"
              className="min-h-10 rounded-xl bg-gray-100 px-3 font-semibold"
              onClick={() => setPay({ cash: '', upi: String(max / 100) })}
            >
              Full balance by UPI
            </button>
          </div>
        )}
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <Button className="w-full" disabled={busy || total <= 0} onClick={save}>
          {busy ? 'Saving…' : `Save ${total > 0 ? formatPaise(total) : ''}`}
        </Button>
      </div>
    </Sheet>
  );
}

/** A payment was entered as cash but was really UPI (or the other way). */
function SwitchSheet({ payment, onClose, onDone }: { payment: OrderPayment; onClose: () => void; onDone: (m: string) => void }) {
  const to = payment.mode === 'cash' ? 'UPI' : 'cash';
  const [reason, setReason] = useState('');
  const [ref] = useState(newRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const { error } = await supabase.rpc('switch_order_payment_mode', { p_payment_id: payment.id, p_reason: reason, p_client_ref: ref });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone(`Changed ${formatPaise(payment.amount_paise)} to ${to}.`);
  }

  return (
    <Sheet title={`Change ${formatPaise(payment.amount_paise)} to ${to}?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          Use this when a payment was entered with the wrong mode. The cash and UPI totals for that day are corrected.
        </p>
        {error && <Alert>{error}</Alert>}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={`e.g. Customer paid by ${to}`} />
        </Field>
        <Button className="w-full" disabled={busy || reason.trim().length < 3} onClick={run}>
          {busy ? 'Saving…' : `Yes, change to ${to}`}
        </Button>
      </div>
    </Sheet>
  );
}

function CancelSheet({ order, onClose, onDone }: { order: OrderRow; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'cash' | 'upi' | 'keep'>('cash');
  const [error, setError] = useState<string | null>(null);

  async function run() {
    const { error } = await supabase.rpc('cancel_order', {
      p_order_id: order.id,
      p_reason: reason,
      p_refund_mode: order.advance_paise > 0 && refund !== 'keep' ? refund : null,
    });
    if (error) setError(friendlyError(error));
    else onDone('Order cancelled.');
  }

  return (
    <Sheet title={`Cancel ${order.order_no}?`} onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer cancelled" />
        </Field>
        {order.advance_paise > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Advance held: {formatPaise(order.advance_paise)}</p>
            <div className="grid grid-cols-3 gap-2">
              {(['cash', 'upi', 'keep'] as const).map((r) => (
                <Button key={r} variant={refund === r ? 'primary' : 'secondary'} className="px-2 text-sm" onClick={() => setRefund(r)}>
                  {r === 'cash' ? 'Refund cash' : r === 'upi' ? 'Refund UPI' : 'Keep it'}
                </Button>
              ))}
            </div>
          </div>
        )}
        <Button variant="danger" className="w-full" disabled={reason.trim().length < 3} onClick={run}>
          Yes, cancel order
        </Button>
      </div>
    </Sheet>
  );
}

/** Makes the final bill. The advance is applied automatically; collect only the balance. */
function DeliverSheet({ order, items, onClose }: { order: OrderRow; items: OrderItem[]; onClose: () => void }) {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { products } = useProducts(true);
  const [mode, setMode] = useState<'cash' | 'upi' | 'split'>('cash');
  const [splitCash, setSplitCash] = useState('');
  const [ref] = useState(newRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!settings || !products) return null;
  // Same arithmetic as convert_order_to_bill(): GST is added on top only when prices exclude GST.
  const total = items.reduce((s, i) => {
    const rate = products.find((p) => p.id === i.product_id)?.gst_rate_bp ?? 0;
    return s + (settings.prices_include_gst ? i.line_total_paise : i.line_total_paise + Math.round((i.line_total_paise * rate) / 10000));
  }, 0);
  const due = total - order.advance_paise;
  const cashPart = rupeesToPaise(splitCash);
  const upiPart = cashPart !== null ? due - cashPart : null;

  async function save() {
    let payments: { mode: 'cash' | 'upi'; amount_paise: number }[] = [];
    if (due > 0) {
      if (mode === 'split') {
        if (!cashPart || cashPart <= 0 || !upiPart || upiPart <= 0) return setError('Enter the cash part. The rest is UPI.');
        payments = [
          { mode: 'cash', amount_paise: cashPart },
          { mode: 'upi', amount_paise: upiPart },
        ];
      } else payments = [{ mode, amount_paise: due }];
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('convert_order_to_bill', {
      p_order_id: order.id,
      p_payments: payments,
      p_client_ref: ref,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    navigate(`/bills/${(data as { id: string }).id}?new=1`, { replace: true });
  }

  return (
    <Sheet title="Deliver & make bill" onClose={onClose}>
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="space-y-1 rounded-xl bg-gray-50 p-3">
          <div className="flex justify-between">
            <span>Bill total</span>
            <span>{formatPaise(total)}</span>
          </div>
          <div className="flex justify-between text-blue-800">
            <span>Advance already paid</span>
            <span>−{formatPaise(order.advance_paise)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 text-xl font-bold">
            <span>Collect now</span>
            <span>{formatPaise(Math.max(due, 0))}</span>
          </div>
        </div>
        {due < 0 ? (
          <Alert>The advance is more than the bill. Refund {formatPaise(-due)} from the order first.</Alert>
        ) : due > 0 ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(['cash', 'upi', 'split'] as const).map((m) => (
                <Button key={m} variant={mode === m ? 'primary' : 'secondary'} onClick={() => setMode(m)}>
                  {m === 'cash' ? '💵 Cash' : m === 'upi' ? '📱 UPI' : 'Split'}
                </Button>
              ))}
            </div>
            {mode === 'upi' && settings.upi_id && (
              <UpiQr upiId={settings.upi_id} payee={settings.farm_name} amountPaise={due} note={order.order_no} />
            )}
            {mode === 'split' && (
              <>
                <Field label="Cash part (₹)">
                  <Input inputMode="decimal" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} />
                </Field>
                {upiPart !== null && <p className="font-semibold">UPI part: {upiPart > 0 ? formatPaise(upiPart) : '—'}</p>}
              </>
            )}
          </>
        ) : (
          <p className="text-center text-brand-800">Fully paid by advance. Nothing to collect.</p>
        )}
        <Button className="min-h-14 w-full text-lg" disabled={busy || due < 0} onClick={save}>
          {busy ? 'Saving…' : 'Make bill & mark delivered'}
        </Button>
      </div>
    </Sheet>
  );
}
