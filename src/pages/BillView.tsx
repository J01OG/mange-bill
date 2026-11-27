import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { PrintableReceipt } from '../components/BillActions';
import { CashUpiInputs, cashUpiLines, cashUpiTotal, type CashUpi } from '../components/CashUpiInputs';
import { Alert, Button, buttonClass, Field, Input, Sheet, Spinner } from '../components/ui';
import { friendlyError, UNIT_LABEL, type Unit } from '../lib/data';
import { formatIST, formatPaise } from '../lib/money';
import { displayPhone, normalisePhone } from '../lib/phone';
import { fetchReceipt, shareLink, whatsappText, whatsappUrl, type Receipt } from '../lib/receipt';
import { supabase } from '../lib/supabase';

interface BillRow {
  id: string;
  share_token: string;
  customer_phone: string | null;
  status: 'active' | 'void';
  void_reason: string | null;
  voided_at: string | null;
  order_id: string | null;
}

interface Bargain {
  product_name: string;
  unit: Unit;
  unit_price_paise: number;
  list_price_paise: number;
}

export function BillView() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const isNew = params.get('new') === '1';
  const { profile } = useAuth();
  const [bill, setBill] = useState<BillRow | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [bargains, setBargains] = useState<Bargain[]>([]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('bills')
      .select('id, share_token, customer_phone, status, void_reason, voided_at, order_id')
      .eq('id', id!)
      .maybeSingle();
    if (error) return setError(friendlyError(error));
    if (!data) return setError('Bill not found (cashiers can only open their own bills from today).');
    setBill(data as BillRow);
    const { data: b } = await supabase
      .from('bill_items')
      .select('product_name, unit, unit_price_paise, list_price_paise')
      .eq('bill_id', data.id)
      .not('list_price_paise', 'is', null);
    setBargains((b ?? []) as Bargain[]);
    try {
      setReceipt(await fetchReceipt(data.share_token));
    } catch (e) {
      setError(friendlyError(e as Error));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <Alert>{error}</Alert>;
  if (!bill || !receipt) return <Spinner />;

  const link = shareLink(bill.share_token);

  return (
    <div className="space-y-4">
      {isNew && <Alert kind="success">Bill {receipt.bill_no} saved.</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      {bill.status === 'void' && (
        <Alert>
          Cancelled {bill.voided_at && formatIST(bill.voided_at)}. Reason: {bill.void_reason}
        </Alert>
      )}

      {isNew && (
        <Link to="/bill" className={buttonClass('primary', 'min-h-14 w-full text-lg')}>
          + Next bill
        </Link>
      )}

      {bill.customer_phone ? (
        <a
          href={whatsappUrl(bill.customer_phone, whatsappText(receipt, link))}
          target="_blank"
          rel="noreferrer"
          className={buttonClass('primary', 'w-full !bg-[#1a8f47]')}
        >
          💬 Send on WhatsApp
        </a>
      ) : (
        <p className="text-center text-sm text-gray-500">No mobile number on this bill, so WhatsApp sharing is off.</p>
      )}

      {bargains.length > 0 && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-300">
          <b>🤝 Bargained on this bill</b>
          {bargains.map((x, n) => (
            <div key={n}>
              {x.product_name}: {formatPaise(x.unit_price_paise)}/{UNIT_LABEL[x.unit]} (normal {formatPaise(x.list_price_paise)})
            </div>
          ))}
        </div>
      )}

      <PrintableReceipt r={receipt} />

      {bill.status === 'active' && (
        <Link to={`/returns?bill=${encodeURIComponent(receipt.bill_no)}`} className={buttonClass('secondary', 'w-full')}>
          ↩️ Return items from this bill
        </Link>
      )}

      {bill.status === 'active' && (
        <Button variant="secondary" className="w-full" onClick={() => setEditing(true)}>
          ✏️ Change payment / customer
        </Button>
      )}

      {editing && (
        <EditBillSheet
          billId={bill.id}
          receipt={receipt}
          phone={bill.customer_phone}
          onClose={() => setEditing(false)}
          onDone={(m) => {
            setEditing(false);
            setFlash(m);
            load();
          }}
        />
      )}

      {profile?.role === 'owner' && bill.status === 'active' && !bill.order_id && (
        <Button variant="ghost" className="w-full text-red-700" onClick={() => setVoiding(true)}>
          Cancel (void) this bill
        </Button>
      )}

      {voiding && (
        <VoidSheet
          billId={bill.id}
          billNo={receipt.bill_no}
          onClose={() => setVoiding(false)}
          onDone={() => {
            setVoiding(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function VoidSheet({ billId, billNo, onClose, onDone }: { billId: string; billNo: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    const { error } = await supabase.rpc('void_bill', {
      p_bill_id: billId,
      p_reason: reason,
    });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone();
  }

  return (
    <Sheet title={`Cancel bill ${billNo}?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          The bill stays in your records marked VOID and is left out of sales totals. This cannot be undone. If the customer is only
          returning some items, use "Return items" instead.
        </p>
        {error && <Alert>{error}</Alert>}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong items entered" />
        </Field>
        <Button variant="danger" className="w-full" disabled={busy || reason.trim().length < 3} onClick={run}>
          {busy ? 'Cancelling…' : 'Yes, cancel this bill'}
        </Button>
      </div>
    </Sheet>
  );
}

/** Fix a saved bill: who the customer is, and how it was really paid (cash / UPI / both). */
function EditBillSheet({
  billId,
  receipt,
  phone,
  onClose,
  onDone,
}: {
  billId: string;
  receipt: Receipt;
  phone: string | null;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const paid = (m: string) => receipt.payments.filter((p) => p.mode === m).reduce((s, p) => s + p.amount_paise, 0);
  const advance = paid('advance');
  const due = receipt.total_paise - advance;
  const [start] = useState<CashUpi>(() => ({
    cash: paid('cash') ? String(paid('cash') / 100) : '',
    upi: paid('upi') ? String(paid('upi') / 100) : '',
  }));
  const [name, setName] = useState(receipt.customer_name ?? '');
  const [mobile, setMobile] = useState(phone ? displayPhone(phone) : '');
  const [pay, setPay] = useState<CashUpi>(start);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = cashUpiLines(pay);
  const payChanged = JSON.stringify(lines) !== JSON.stringify(cashUpiLines(start));

  async function save() {
    setError(null);
    const p = mobile.trim() ? normalisePhone(mobile) : null;
    if (mobile.trim() && !p) return setError('Mobile number is not valid (or leave it empty).');
    if (payChanged) {
      if (!lines || cashUpiTotal(pay) !== due) return setError(`Cash + UPI must add up to ${formatPaise(due)}.`);
      if (reason.trim().length < 3) return setError('Write why the payment is being changed.');
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('edit_bill', {
      p_bill_id: billId,
      p_customer_name: name.trim() || null,
      p_customer_phone: p,
      p_payments: payChanged ? lines : null,
      p_reason: reason.trim() || null,
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    onDone((data as { changed: boolean }).changed ? 'Bill updated.' : 'Nothing was changed.');
  }

  return (
    <Sheet title={`Change bill ${receipt.bill_no}`} onClose={onClose}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <section className="space-y-2">
          <h3 className="font-semibold">Customer</h3>
          <Field label="Name (optional)">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Mobile (optional)" hint="Add it to send the bill on WhatsApp.">
            <Input type="tel" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="98765 43210" />
          </Field>
        </section>
        <section className="space-y-2">
          <h3 className="font-semibold">How was it paid?</h3>
          {advance > 0 && <p className="text-sm text-blue-800">{formatPaise(advance)} was paid earlier for the order.</p>}
          <CashUpiInputs value={pay} onChange={setPay} target={due} />
          {payChanged && (
            <Field label="Why is the payment changed?">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                placeholder="e.g. Customer paid cash, not UPI"
              />
            </Field>
          )}
          <p className="text-xs text-gray-500">
            Nothing is deleted. The change and its reason are kept in the records and the Excel report.
          </p>
        </section>
        <Button className="w-full" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </Sheet>
  );
}
