import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { PrintableReceipt } from '../components/BillActions';
import { Alert, Button, buttonClass, Field, Input, Sheet, Spinner } from '../components/ui';
import { friendlyError, UNIT_LABEL, type Unit } from '../lib/data';
import { formatIST, formatPaise } from '../lib/money';
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
