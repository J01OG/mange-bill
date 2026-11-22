import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Select, Sheet, Spinner } from '../components/ui';
import { friendlyError, useProducts } from '../lib/data';
import { formatIST, formatPaise, rupeesToPaise } from '../lib/money';
import { displayPhone, normalisePhone } from '../lib/phone';
import { supabase } from '../lib/supabase';

interface Coupon {
  id: string;
  code: string;
  description: string | null;
  kind: 'percent' | 'flat';
  value: number;
  applies_to: 'all' | 'selected';
  customer_id: string | null;
  min_bill_paise: number;
  expires_at: string | null;
  usage_limit: number | null;
  used_count: number;
  active: boolean;
}

function describe(c: Coupon) {
  const off = c.kind === 'percent' ? `${c.value / 100}% off` : `${formatPaise(c.value)} off`;
  return `${off}${c.applies_to === 'selected' ? ' selected products' : ''}${c.min_bill_paise ? ` · min ${formatPaise(c.min_bill_paise)}` : ''}`;
}
function status(c: Coupon): { text: string; ok: boolean } {
  if (!c.active) return { text: 'Off', ok: false };
  if (c.expires_at && new Date(c.expires_at) < new Date()) return { text: 'Expired', ok: false };
  if (c.usage_limit && c.used_count >= c.usage_limit) return { text: 'Used up', ok: false };
  return { text: 'Active', ok: true };
}

export function Coupons() {
  const [list, setList] = useState<Coupon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
    if (error) setError(friendlyError(error));
    else setList(data as Coupon[]);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Coupons</h2>
        <Button onClick={() => setEditing('new')}>+ New coupon</Button>
      </div>
      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert>{error}</Alert>}
      {!list ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {list.map((c) => {
            const st = status(c);
            return (
              <li key={c.id}>
                <button className="w-full text-left" onClick={() => setEditing(c)}>
                  <Card className={st.ok ? '' : 'opacity-60'}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-lg font-bold">{c.code}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.ok ? 'bg-brand-100 text-brand-900' : 'bg-gray-200 text-gray-700'}`}>
                        {st.text}
                      </span>
                    </div>
                    <div className="text-sm text-gray-700">{describe(c)}</div>
                    <div className="text-xs text-gray-500">
                      Used {c.used_count ?? 0}
                      {c.usage_limit ? ` of ${c.usage_limit}` : ''} {(c.used_count ?? 0) === 1 && !c.usage_limit ? 'time' : 'times'}
                      {c.expires_at ? ` · ends ${formatIST(c.expires_at, false)}` : ''}
                      {c.customer_id ? ' · one customer only' : ''}
                    </div>
                  </Card>
                </button>
              </li>
            );
          })}
          {list.length === 0 && <p className="text-center text-gray-500">No coupons yet.</p>}
        </ul>
      )}
      {editing && (
        <CouponForm
          coupon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setFlash(m);
            load();
          }}
        />
      )}
    </div>
  );
}

function CouponForm({ coupon, onClose, onDone }: { coupon: Coupon | null; onClose: () => void; onDone: (m: string) => void }) {
  const { products } = useProducts(false);
  const [code, setCode] = useState(coupon?.code ?? '');
  const [description, setDescription] = useState(coupon?.description ?? '');
  const [kind, setKind] = useState<'percent' | 'flat'>(coupon?.kind ?? 'percent');
  const [value, setValue] = useState(coupon ? String(coupon.value / 100) : '');
  const [appliesTo, setAppliesTo] = useState<'all' | 'selected'>(coupon?.applies_to ?? 'all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phone, setPhone] = useState('');
  const [minBill, setMinBill] = useState(coupon?.min_bill_paise ? String(coupon.min_bill_paise / 100) : '');
  const [expires, setExpires] = useState(
    coupon?.expires_at ? new Date(coupon.expires_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '',
  );
  const [limit, setLimit] = useState(coupon?.usage_limit ? String(coupon.usage_limit) : '');
  const [active, setActive] = useState(coupon?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the extra details of an existing coupon.
  useEffect(() => {
    if (!coupon) return;
    supabase
      .from('coupon_products')
      .select('product_id')
      .eq('coupon_id', coupon.id)
      .then(({ data }) => setSelected(new Set((data ?? []).map((r: { product_id: string }) => r.product_id))));
    if (coupon.customer_id)
      supabase
        .from('customers')
        .select('phone')
        .eq('id', coupon.customer_id)
        .maybeSingle()
        .then(({ data }) => data?.phone && setPhone(displayPhone(data.phone)));
  }, [coupon]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(c)) return setError('Code: 3–20 letters or numbers, no spaces (e.g. DIWALI10).');
    const v = rupeesToPaise(value); // "10" -> 1000 = 10% in basis points, or ₹10 in paise
    if (!v || v <= 0) return setError(kind === 'percent' ? 'Enter the % off, like 10' : 'Enter the ₹ off, like 20');
    if (kind === 'percent' && v > 10000) return setError('Percent cannot be more than 100.');
    if (appliesTo === 'selected' && selected.size === 0) return setError('Tick at least one product.');
    const min = minBill.trim() ? rupeesToPaise(minBill) : 0;
    if (min === null) return setError('Minimum bill must be a number.');

    setBusy(true);
    // Personal coupon: find or create the customer by mobile.
    let customer_id: string | null = null;
    if (phone.trim()) {
      const p = normalisePhone(phone);
      if (!p) {
        setBusy(false);
        return setError('Customer mobile is not valid (or leave it empty for everyone).');
      }
      const found = await supabase.from('customers').select('id').eq('phone', p).maybeSingle();
      if (found.data) customer_id = found.data.id;
      else {
        const made = await supabase.from('customers').insert({ phone: p }).select('id').single();
        if (made.error) {
          setBusy(false);
          return setError(friendlyError(made.error));
        }
        customer_id = made.data.id;
      }
    }

    const row = {
      code: c,
      description: description.trim() || null,
      kind,
      value: v,
      applies_to: appliesTo,
      customer_id,
      min_bill_paise: min,
      expires_at: expires ? `${expires}T23:59:59+05:30` : null,
      usage_limit: limit.trim() ? Math.max(1, Math.floor(Number(limit))) : null,
      active,
    };
    const res = coupon
      ? await supabase.from('coupons').update(row).eq('id', coupon.id).select('id').single()
      : await supabase.from('coupons').insert(row).select('id').single();
    if (res.error) {
      setBusy(false);
      return setError(/duplicate|unique/i.test(res.error.message) ? 'That code is already used.' : friendlyError(res.error));
    }
    const id = res.data.id as string;
    await supabase.from('coupon_products').delete().eq('coupon_id', id);
    if (appliesTo === 'selected') {
      const { error } = await supabase
        .from('coupon_products')
        .insert([...selected].map((product_id) => ({ coupon_id: id, product_id })));
      if (error) {
        setBusy(false);
        return setError(friendlyError(error));
      }
    }
    onDone(`Coupon ${c} saved.`);
  }

  return (
    <Sheet title={coupon ? `Edit ${coupon.code}` : 'New coupon'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Code (what the customer says)">
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={20} placeholder="DIWALI10" />
        </Field>
        <Field label="Note for yourself (optional)">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as 'percent' | 'flat')}>
              <option value="percent">% off</option>
              <option value="flat">₹ off</option>
            </Select>
          </Field>
          <Field label={kind === 'percent' ? 'Percent' : 'Rupees'}>
            <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required placeholder={kind === 'percent' ? '10' : '20'} />
          </Field>
        </div>
        <Field label="Applies to">
          <Select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as 'all' | 'selected')}>
            <option value="all">All products</option>
            <option value="selected">Only selected products</option>
          </Select>
        </Field>
        {appliesTo === 'selected' && (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl bg-gray-50 p-2">
            {(products ?? []).map((p) => (
              <label key={p.id} className="flex min-h-11 items-center gap-3">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-brand-700"
                  checked={selected.has(p.id)}
                  onChange={(e) => {
                    const s = new Set(selected);
                    if (e.target.checked) s.add(p.id);
                    else s.delete(p.id);
                    setSelected(s);
                  }}
                />
                {p.name}
              </label>
            ))}
          </div>
        )}
        <Field label="Only for this customer's mobile (optional)" hint="Leave empty so anyone can use it.">
          <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Minimum bill ₹ (optional)">
            <Input inputMode="decimal" value={minBill} onChange={(e) => setMinBill(e.target.value)} />
          </Field>
          <Field label="Max uses (optional)">
            <Input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ''))} />
          </Field>
        </div>
        <Field label="Last day (optional)">
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" className="h-6 w-6 accent-brand-700" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Coupon is on
        </label>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save coupon'}
        </Button>
      </form>
    </Sheet>
  );
}
