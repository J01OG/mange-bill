import { useEffect, useMemo, useState } from 'react';
import { PaySheet, type Line } from '../components/PaySheet';
import { Alert, Button, Field, Input, Sheet, Spinner } from '../components/ui';
import { formatQty, gramsToKg, lineAmounts, newRef, UNIT_LABEL, useProducts, useSettings, type Product } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const weightText = (kg: number) => formatQty(kg, 'kg');

export function NewBill() {
  const { products, error: loadError } = useProducts(false);
  const { settings } = useSettings();
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [weighing, setWeighing] = useState<Product | null>(null);
  const [paying, setPaying] = useState(false);
  // A fresh id for each different cart, so a retried save never makes two bills.
  const [clientRef, setClientRef] = useState(newRef);
  useEffect(() => setClientRef(newRef()), [lines]);

  const incl = settings?.prices_include_gst ?? true;
  const total = useMemo(
    () => lines.reduce((s, l) => s + lineAmounts(l.product, l.qty, incl, l.amount).line, 0),
    [lines, incl],
  );

  function putLine(p: Product, line: Line | null) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product.id === p.id);
      if (!line) return ls.filter((l) => l.product.id !== p.id);
      if (i === -1) return [...ls, line];
      const copy = [...ls];
      copy[i] = line;
      return copy;
    });
  }
  function setQty(p: Product, qty: number) {
    const q = round3(qty);
    putLine(p, q > 0 ? { product: p, qty: q } : null);
  }
  /** "₹100 worth": the bill shows exactly this amount; the weight to give is worked out. */
  function setAmount(p: Product, paise: number) {
    putLine(p, paise > 0 ? { product: p, qty: round3(paise / p.price_paise), amount: paise } : null);
  }
  const lineOf = (p: Product) => lines.find((l) => l.product.id === p.id);
  const qtyOf = (p: Product) => lineOf(p)?.qty ?? 0;

  function tap(p: Product) {
    if (p.unit === 'kg') setWeighing(p);
    else setQty(p, qtyOf(p) + 1);
  }

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!products) return <Spinner />;

  const q = search.trim().toLowerCase();
  const shown = q ? products.filter((p) => p.name.toLowerCase().includes(q) || p.local_name?.toLowerCase().includes(q)) : products;

  return (
    <div className="space-y-4 pb-24" style={{ paddingBottom: 'calc(6rem + var(--badge-gap))' }}>
      {products.length > 8 && <Input placeholder="Search product" value={search} onChange={(e) => setSearch(e.target.value)} />}

      {products.length === 0 && <Alert kind="info">No products yet. The owner can add them under Products.</Alert>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shown.map((p) => {
          const l = lineOf(p);
          return (
            <button
              key={p.id}
              onClick={() => tap(p)}
              className={`relative min-h-20 rounded-2xl p-3 text-left shadow-sm ring-1 transition active:scale-[0.97] ${
                l ? 'bg-brand-50 ring-2 ring-brand-700' : 'bg-white ring-gray-200'
              }`}
            >
              <div className="font-semibold leading-tight">{p.name}</div>
              <div className="mt-1 text-sm text-gray-600">
                {formatPaise(p.price_paise)} / {UNIT_LABEL[p.unit]}
              </div>
              {l && (
                <span className="absolute right-2 top-2 rounded-full bg-brand-700 px-2 py-0.5 text-xs font-bold text-white">
                  {l.amount ? formatPaise(l.amount) : p.unit === 'kg' ? weightText(l.qty) : l.qty}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {lines.length > 0 && (
        <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-gray-200">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">This bill</h3>
            <button className="min-h-10 px-2 text-sm text-red-700" onClick={() => setLines([])}>
              Clear all
            </button>
          </div>
          <ul className="divide-y">
            {lines.map(({ product: p, qty, amount }) => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-sm text-gray-600">
                    {formatPaise(lineAmounts(p, qty, incl, amount).line)}
                    {amount ? (
                      <span className="ml-1 font-semibold text-brand-800">· give {weightText(qty)}</span>
                    ) : null}
                  </div>
                </div>
                {p.unit === 'kg' ? (
                  <>
                    <button className="min-h-11 rounded-xl bg-gray-100 px-3 font-semibold" onClick={() => setWeighing(p)}>
                      {amount ? `${formatPaise(amount)} worth` : formatQty(qty, 'kg')} ✎
                    </button>
                    <button aria-label="Remove" className="h-11 w-11 rounded-xl bg-gray-100 text-xl" onClick={() => setQty(p, 0)}>
                      ×
                    </button>
                  </>
                ) : (
                  <div className="flex items-center">
                    <button aria-label="One less" className="h-11 w-11 rounded-xl bg-gray-100 text-2xl" onClick={() => setQty(p, qty - 1)}>
                      −
                    </button>
                    <span className="w-10 text-center text-lg font-bold">{qty}</span>
                    <button aria-label="One more" className="h-11 w-11 rounded-xl bg-gray-100 text-2xl" onClick={() => setQty(p, qty + 1)}>
                      +
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Total bar, sits just above the bottom menu */}
      <div className="above-badge-bar fixed inset-x-0 z-20 border-t border-gray-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="flex-1">
            <div className="text-xs text-gray-500">{lines.length} item(s)</div>
            <div className="text-2xl font-bold">{formatPaise(total)}</div>
          </div>
          <Button className="min-h-14 px-8 text-lg" disabled={lines.length === 0} onClick={() => setPaying(true)}>
            Charge →
          </Button>
        </div>
      </div>

      {weighing && (
        <WeighSheet
          product={weighing}
          current={lineOf(weighing) ?? null}
          onClose={() => setWeighing(null)}
          onSetWeight={(qty) => {
            setQty(weighing, qty);
            setWeighing(null);
          }}
          onSetAmount={(paise) => {
            setAmount(weighing, paise);
            setWeighing(null);
          }}
        />
      )}

      {paying && settings && (
        <PaySheet
          lines={lines}
          total={total}
          upiId={settings.upi_id}
          farmName={settings.farm_name}
          clientRef={clientRef}
          onClose={() => setPaying(false)}
        />
      )}
    </div>
  );
}

/** For kg products: sell by weight ("500 g") or by money ("₹100 worth"). */
function WeighSheet({
  product,
  current,
  onClose,
  onSetWeight,
  onSetAmount,
}: {
  product: Product;
  current: Line | null;
  onClose: () => void;
  onSetWeight: (q: number) => void;
  onSetAmount: (paise: number) => void;
}) {
  const [mode, setMode] = useState<'weight' | 'amount'>(current?.amount ? 'amount' : 'weight');
  // Weight is typed in GRAMS (e.g. 350); the database stores kilograms (0.35).
  const [gText, setGText] = useState(current && !current.amount ? String(Math.round(current.qty * 1000)) : '');
  const [rsText, setRsText] = useState(current?.amount ? String(current.amount / 100) : '');

  const grams = Number(gText);
  const kg = gramsToKg(grams);
  const kgValid = gText !== '' && Number.isInteger(grams) && grams >= 1 && kg <= 10000;
  const paise = rupeesToPaise(rsText);
  const giveKg = paise ? round3(paise / product.price_paise) : 0;
  const rsValid = !!paise && giveKg > 0 && giveKg <= 10000;

  return (
    <Sheet title={product.name} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{formatPaise(product.price_paise)} per kg</p>
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1">
          {(['weight', 'amount'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`min-h-11 rounded-lg text-sm font-semibold ${mode === m ? 'bg-white shadow' : 'text-gray-600'}`}
            >
              {m === 'weight' ? '⚖️ By weight' : '₹ By amount'}
            </button>
          ))}
        </div>

        {mode === 'weight' ? (
          <>
            <div className="grid grid-cols-4 gap-2">
              {[100, 250, 500, 1000].map((g) => (
                <Button key={g} variant="secondary" onClick={() => onSetWeight(gramsToKg(g))}>
                  {g < 1000 ? `${g} g` : `${g / 1000} kg`}
                </Button>
              ))}
            </div>
            <Field label="Or type the weight in grams" hint="Example: 350 for 350 g · 1250 for 1 kg 250 g">
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  inputMode="numeric"
                  value={gText}
                  onChange={(e) => setGText(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && kgValid && onSetWeight(kg)}
                />
                <span className="font-semibold text-gray-600">g</span>
              </div>
            </Field>
            {kgValid && (
              <p className="text-center text-gray-600">
                {weightText(kg)} = {formatPaise(Math.round(product.price_paise * kg))}
              </p>
            )}
            <Button className="w-full" disabled={!kgValid} onClick={() => onSetWeight(kg)}>
              Set weight
            </Button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {[50, 100, 200, 500].map((r) => (
                <Button key={r} variant="secondary" onClick={() => onSetAmount(r * 100)}>
                  ₹{r}
                </Button>
              ))}
            </div>
            <Field label="Or type the amount the customer wants (₹)" hint="The bill will show exactly this amount.">
              <Input
                autoFocus
                inputMode="decimal"
                value={rsText}
                onChange={(e) => setRsText(e.target.value.replace(/[^\d.]/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && rsValid && onSetAmount(paise!)}
              />
            </Field>
            {paise ? (
              rsValid ? (
                <p className="text-center text-lg">
                  Give <b className="text-brand-800">{weightText(giveKg)}</b>
                </p>
              ) : (
                <p className="text-center text-sm text-red-700">That amount is too small to weigh.</p>
              )
            ) : null}
            <Button className="w-full" disabled={!rsValid} onClick={() => onSetAmount(paise!)}>
              Set amount
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
