import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input, Select, Spinner } from '../components/ui';
import { friendlyError, istToday, UNIT_LABEL, useProducts, useSettings } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { displayPhone, normalisePhone } from '../lib/phone';
import type { OrderItem, OrderRow } from '../lib/orders';
import { supabase } from '../lib/supabase';

interface Line {
  product_id: string;
  name: string;
  unit: 'kg' | 'packet' | 'piece';
  qty: string;
  price: string; // rupees, editable (bulk price)
}

/** New order (/orders/new) or edit (/orders/:id/edit). Owner or cashier. */
export function OrderEdit() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { products } = useProducts(false);
  const { settings } = useSettings();
  const { profile } = useAuth();
  const canBargain = profile?.role === 'owner' || (settings?.allow_bargain ?? true);
  const [loaded, setLoaded] = useState(!id);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(istToday());
  const [deliveryNote, setDeliveryNote] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      supabase.from('order_overview').select('*').eq('id', id).single(),
      supabase.from('order_items').select('*').eq('order_id', id).order('created_at'),
    ]).then(([o, items]) => {
      if (o.error) return setError(friendlyError(o.error));
      const r = o.data as OrderRow;
      setName(r.customer_name);
      setPhone(r.customer_phone ? displayPhone(r.customer_phone) : '');
      setDate(r.delivery_date);
      setDeliveryNote(r.delivery_note ?? '');
      setNotes(r.notes ?? '');
      setLines(
        ((items.data ?? []) as OrderItem[]).map((i) => ({
          product_id: i.product_id,
          name: i.product_name,
          unit: i.unit,
          qty: String(Number(i.qty)),
          price: String(i.unit_price_paise / 100),
        })),
      );
      setLoaded(true);
    });
  }, [id]);

  function addProduct(pid: string) {
    const p = products?.find((x) => x.id === pid);
    if (!p || lines.some((l) => l.product_id === pid)) return;
    setLines([...lines, { product_id: p.id, name: p.name, unit: p.unit, qty: '', price: String(p.price_paise / 100) }]);
    setPick('');
  }
  const update = (i: number, patch: Partial<Line>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const lineTotal = (l: Line) => Math.round((rupeesToPaise(l.price) ?? 0) * (Number(l.qty) || 0));
  const total = lines.reduce((s, l) => s + lineTotal(l), 0);

  async function save() {
    setError(null);
    if (!name.trim()) return setError('Enter the customer name.');
    const p = phone.trim() ? normalisePhone(phone) : null;
    if (phone.trim() && !p) return setError('Mobile number is not valid (or leave it empty).');
    if (lines.length === 0) return setError('Add at least one product.');
    for (const l of lines) {
      if (!(Number(l.qty) > 0)) return setError(`Enter the quantity for ${l.name}.`);
      if (rupeesToPaise(l.price) === null) return setError(`Enter a price for ${l.name}.`);
    }
    setBusy(true);
    const { data, error } = await supabase.rpc('save_order', {
      p_order_id: id ?? null,
      p_customer_name: name,
      p_customer_phone: p,
      p_delivery_date: date,
      p_delivery_note: deliveryNote,
      p_notes: notes,
      p_items: lines.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), price_paise: rupeesToPaise(l.price) })),
    });
    setBusy(false);
    if (error) return setError(friendlyError(error));
    navigate(`/orders/${(data as { id: string }).id}`, { replace: true });
  }

  if (!loaded || !products) return error ? <Alert>{error}</Alert> : <Spinner />;
  const available = products.filter((p) => !lines.some((l) => l.product_id === p.id));

  return (
    <div className="space-y-4 pb-6">
      <h2 className="text-xl font-bold">{id ? 'Edit order' : 'New order'}</h2>
      {error && <Alert>{error}</Alert>}

      <Card className="space-y-3">
        <Field label="Customer name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="e.g. Hotel Sai" />
        </Field>
        <Field label="Mobile (optional)">
          <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Delivery date">
            <Input type="date" value={date} min={istToday()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time / place (optional)">
            <Input value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} maxLength={200} placeholder="7 am, back gate" />
          </Field>
        </div>
        {id && <p className="text-xs text-gray-500">Customer wants it later or earlier? Just change the delivery date.</p>}
      </Card>

      <Card className="space-y-3">
        <h3 className="font-semibold">Items</h3>
        {lines.map((l, i) => (
          <div key={l.product_id} className="rounded-xl bg-gray-50 p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{l.name}</span>
              <button
                aria-label={`Remove ${l.name}`}
                className="h-10 w-10 text-xl text-gray-500"
                onClick={() => setLines(lines.filter((_, n) => n !== i))}
              >
                ×
              </button>
            </div>
            <div className="grid grid-cols-3 items-end gap-2">
              <Field label={`Qty (${UNIT_LABEL[l.unit]})`}>
                <Input inputMode="decimal" value={l.qty} onChange={(e) => update(i, { qty: e.target.value.replace(/[^\d.]/g, '') })} />
              </Field>
              <Field label="Price ₹ each">
                <Input inputMode="decimal" value={l.price} readOnly={!canBargain} onChange={(e) => update(i, { price: e.target.value })} />
              </Field>
              <div className="pb-3 text-right font-semibold">{formatPaise(lineTotal(l))}</div>
            </div>
          </div>
        ))}
        {available.length > 0 && (
          <Select value={pick} onChange={(e) => addProduct(e.target.value)} aria-label="Add a product">
            <option value="">+ Add a product…</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({formatPaise(p.price_paise)}/{UNIT_LABEL[p.unit]})
              </option>
            ))}
          </Select>
        )}
        <p className="text-xs text-gray-500">
          {canBargain ? 'You can change the price for a bulk deal. The bill will use these prices.' : 'Only the owner can change prices.'}
        </p>
        <div className="flex justify-between border-t pt-2 text-lg font-bold">
          <span>Order total</span>
          <span>{formatPaise(total)}</span>
        </div>
      </Card>

      <Field label="Notes (optional)">
        <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </Field>

      <Button className="min-h-14 w-full text-lg" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : id ? 'Save changes' : 'Save order'}
      </Button>
    </div>
  );
}
