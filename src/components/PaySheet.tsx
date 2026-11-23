import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Input, Sheet } from './ui';
import { UpiQr } from './UpiQr';
import { formatQty, friendlyError, type Product } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { normalisePhone } from '../lib/phone';
import { supabase } from '../lib/supabase';

export interface Line {
  product: Product;
  qty: number;
  /** Set when a weighed item was sold by money ("₹100 worth"); qty is then the weight to give. */
  amount?: number;
  /** Bargained rate for this bill only (per kg / packet / piece). Unset = normal price. */
  price?: number;
}

type Mode = 'cash' | 'upi' | 'split';
interface Applied {
  code: string;
  discount: number;
  total: number;
}

/** Payment step: coupon, cash / UPI / split, optional customer, then save. */
export function PaySheet({
  lines,
  total,
  upiId,
  farmName,
  clientRef,
  onClose,
}: {
  lines: Line[];
  total: number;
  upiId: string | null;
  farmName: string;
  clientRef: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('cash');
  const [received, setReceived] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [couponText, setCouponText] = useState('');
  const [coupon, setCoupon] = useState<Applied | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = lines.map((l) => ({
    product_id: l.product.id,
    ...(l.amount ? { amount_paise: l.amount } : { qty: l.qty }),
    ...(l.price ? { price_paise: l.price } : {}),
  }));
  const payable = coupon?.total ?? total;

  // Fill in the name of a customer we already know.
  useEffect(() => {
    const p = normalisePhone(phone);
    if (!p) return;
    supabase
      .from('customers')
      .select('name')
      .eq('phone', p)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.name) setName((n) => n || data.name);
      });
  }, [phone]);

  async function applyCoupon() {
    const code = couponText.trim().toUpperCase();
    if (!code) return;
    setCouponMsg(null);
    const { data, error } = await supabase.rpc('preview_bill', {
      p_items: items,
      p_coupon_code: code,
      p_customer_phone: normalisePhone(phone),
    });
    if (error) {
      setCoupon(null);
      return setCouponMsg(friendlyError(error));
    }
    const d = data as { coupon_code: string; discount_paise: number; total_paise: number };
    setCoupon({ code: d.coupon_code, discount: d.discount_paise, total: d.total_paise });
    setSplitCash('');
  }

  const receivedPaise = rupeesToPaise(received);
  const change = receivedPaise !== null ? receivedPaise - payable : null;
  const splitCashPaise = rupeesToPaise(splitCash);
  const splitUpi = splitCashPaise !== null ? payable - splitCashPaise : null;
  const splitValid = splitCashPaise !== null && splitCashPaise > 0 && splitUpi !== null && splitUpi > 0;

  async function save() {
    setError(null);
    const p = phone.trim() ? normalisePhone(phone) : null;
    if (phone.trim() && !p) return setError('Customer mobile number is not valid (or leave it empty).');

    let payments: { mode: 'cash' | 'upi'; amount_paise: number }[] = [];
    if (payable > 0) {
      if (mode === 'split') {
        if (!splitValid) return setError('Enter the cash part. The rest is UPI.');
        payments = [
          { mode: 'cash', amount_paise: splitCashPaise! },
          { mode: 'upi', amount_paise: splitUpi! },
        ];
      } else payments = [{ mode, amount_paise: payable }];
    }

    setBusy(true);
    const { data, error } = await supabase.rpc('create_bill', {
      p_items: items,
      p_payments: payments,
      p_customer_name: name.trim() || null,
      p_customer_phone: p,
      p_client_ref: clientRef,
      p_coupon_code: coupon?.code ?? null,
    });
    if (error) {
      setBusy(false);
      return setError(friendlyError(error));
    }
    navigate(`/bills/${(data as { id: string }).id}?new=1`, { replace: true });
  }

  return (
    <Sheet title={`Total ${formatPaise(payable)}`} onClose={onClose}>
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}

        {coupon && (
          <div className="flex items-center justify-between rounded-xl bg-brand-50 px-3 py-2 text-brand-900 ring-1 ring-brand-100">
            <span>
              🏷️ <b>{coupon.code}</b>: −{formatPaise(coupon.discount)} (was {formatPaise(total)})
            </span>
            <button className="min-h-10 px-2 text-sm text-red-700" onClick={() => setCoupon(null)}>
              Remove
            </button>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {(['cash', 'upi', 'split'] as Mode[]).map((m) => (
            <Button key={m} variant={mode === m ? 'primary' : 'secondary'} onClick={() => setMode(m)}>
              {m === 'cash' ? '💵 Cash' : m === 'upi' ? '📱 UPI' : 'Split'}
            </Button>
          ))}
        </div>

        {mode === 'cash' && (
          <div className="space-y-1">
            <Field label="Cash received (optional, to work out change)">
              <Input inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(payable / 100)} />
            </Field>
            {change !== null && (
              <p className={`text-lg font-bold ${change < 0 ? 'text-red-700' : 'text-brand-800'}`}>
                {change < 0 ? `Short by ${formatPaise(-change)}` : `Give back ${formatPaise(change)}`}
              </p>
            )}
          </div>
        )}

        {mode === 'upi' &&
          (upiId ? (
            <UpiQr upiId={upiId} payee={farmName} amountPaise={payable} note="Farm bill" />
          ) : (
            <p className="text-sm text-gray-600">Tip: add the farm's UPI ID in Settings to show a scan-to-pay QR here.</p>
          ))}

        {mode === 'split' && (
          <div className="space-y-2">
            <Field label="Cash part (₹)">
              <Input inputMode="decimal" value={splitCash} onChange={(e) => setSplitCash(e.target.value)} autoFocus />
            </Field>
            {splitUpi !== null && (
              <p className={`font-semibold ${splitValid ? 'text-gray-800' : 'text-red-700'}`}>
                UPI part: {splitUpi > 0 ? formatPaise(splitUpi) : 'cash part is too big'}
              </p>
            )}
            {upiId && splitValid && <UpiQr upiId={upiId} payee={farmName} amountPaise={splitUpi!} note="Farm bill" />}
          </div>
        )}

        <details className="rounded-xl bg-gray-50 p-3">
          <summary className="min-h-8 cursor-pointer font-medium">Customer & coupon (optional)</summary>
          <div className="mt-3 space-y-3">
            <Field label="Mobile (needed for WhatsApp and personal coupons)">
              <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </Field>
            <Field label="Coupon code">
              <div className="flex gap-2">
                <Input
                  value={couponText}
                  onChange={(e) => setCouponText(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  maxLength={20}
                />
                <Button type="button" variant="secondary" onClick={applyCoupon} disabled={!couponText.trim()}>
                  Apply
                </Button>
              </div>
            </Field>
            {couponMsg && <Alert>{couponMsg}</Alert>}
          </div>
        </details>

        <Button className="min-h-14 w-full text-lg" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : `Save bill · ${formatPaise(payable)}`}
        </Button>
        <p className="text-center text-xs text-gray-500">
          {lines.length} item(s):{' '}
          {lines
            .map((l) => `${l.product.name} × ${l.amount ? `${formatPaise(l.amount)} worth` : formatQty(l.qty, l.product.unit)}`)
            .join(', ')}
        </p>
      </div>
    </Sheet>
  );
}
