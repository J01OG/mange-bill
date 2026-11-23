import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { PaySheet, type Line } from '../components/PaySheet';
import { Alert, Button, Field, Input, Sheet, Spinner } from '../components/ui';
import { colorOf, formatQty, lineAmounts, newRef, UNIT_LABEL, useProducts, useSettings, type Product } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const OTHER = 'Other';

/** "0.417 kg" → "417 g"; 1 kg and above stays in kg. */
function weightText(kg: number) {
  return kg < 1 ? `${Math.round(kg * 1000)} g` : formatQty(kg, 'kg');
}

/** What a weigh / rate pop-up hands back. */
type LineChange = { qty: number; amount?: number; price?: number };

export function NewBill() {
  const { products, error: loadError } = useProducts(false);
  const { settings } = useSettings();
  const { profile } = useAuth();
  const canBargain = profile?.role === 'owner' || (settings?.allow_bargain ?? true);
  const [lines, setLines] = useState<Line[]>([]);
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<string>('');
  const [weighing, setWeighing] = useState<Product | null>(null);
  const [pricing, setPricing] = useState<Product | null>(null);
  const [paying, setPaying] = useState(false);
  // A fresh id for each different cart, so a retried save never makes two bills.
  const [clientRef, setClientRef] = useState(newRef);
  useEffect(() => setClientRef(newRef()), [lines]);

  const incl = settings?.prices_include_gst ?? true;
  const total = useMemo(() => lines.reduce((s, l) => s + lineAmounts(l.product, l.qty, incl, l.amount, l.price).line, 0), [lines, incl]);

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
  const lineOf = (p: Product) => lines.find((l) => l.product.id === p.id);
  /** Packets / pieces: change the count, keep any bargained rate. */
  function setQty(p: Product, qty: number) {
    const q = round3(qty);
    const price = lineOf(p)?.price;
    putLine(p, q > 0 ? { product: p, qty: q, ...(price ? { price } : {}) } : null);
  }
  function applyChange(p: Product, c: LineChange) {
    putLine(p, c.qty > 0 ? { product: p, ...c } : null);
  }

  function tap(p: Product) {
    if (p.unit === 'kg') setWeighing(p);
    else setQty(p, (lineOf(p)?.qty ?? 0) + 1);
  }

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!products) return <Spinner />;

  // Sections in the order their first product appears (products come sorted by position).
  const sectionOf = (p: Product) => p.section?.trim() || OTHER;
  const sections = [...new Set(products.map(sectionOf))];
  const hasSections = sections.some((s) => s !== OTHER);

  const q = search.trim().toLowerCase();
  const shown = products.filter(
    (p) => (!q || p.name.toLowerCase().includes(q) || p.local_name?.toLowerCase().includes(q)) && (!section || sectionOf(p) === section),
  );
  const groups = hasSections
    ? sections
        .map((s) => ({
          name: s,
          items: shown.filter((p) => sectionOf(p) === s),
        }))
        .filter((g) => g.items.length)
    : [{ name: '', items: shown }];

  const tile = (p: Product) => {
    const l = lineOf(p);
    const c = colorOf(p);
    return (
      <button
        key={p.id}
        onClick={() => tap(p)}
        className={`relative min-h-20 rounded-2xl p-3 text-left shadow-sm transition active:scale-[0.97] ${c.tile} ${
          l ? 'ring-1 outline outline-[3px] outline-offset-1 outline-brand-700' : 'ring-1'
        }`}
      >
        <div className={`flex items-start gap-2 ${l ? 'pr-12' : ''}`}>
          <span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${c.dot}`} aria-hidden />
          <span className="font-semibold leading-tight">{p.name}</span>
        </div>
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
  };

  return (
    <div className="space-y-4 pb-24" style={{ paddingBottom: 'calc(6rem + var(--badge-gap))' }}>
      {products.length > 8 && <Input placeholder="Search product" value={search} onChange={(e) => setSearch(e.target.value)} />}

      {hasSections && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {['', ...sections].map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setSection(s)}
              aria-pressed={section === s}
              className={`min-h-10 shrink-0 rounded-full px-4 text-sm font-semibold ${
                section === s ? 'bg-brand-700 text-white' : 'bg-white text-gray-700 ring-1 ring-gray-200'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      )}

      {products.length === 0 && <Alert kind="info">No products yet. The owner can add them under Products.</Alert>}

      {groups.map((g) => (
        <section key={g.name || 'all'} className="space-y-2">
          {hasSections && <h3 className="text-sm font-bold uppercase tracking-wide text-gray-500">{g.name}</h3>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{g.items.map(tile)}</div>
        </section>
      ))}

      {lines.length > 0 && (
        <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-gray-200">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">This bill</h3>
            <button className="min-h-10 px-2 text-sm text-red-700" onClick={() => setLines([])}>
              Clear all
            </button>
          </div>
          <ul className="divide-y">
            {lines.map(({ product: p, qty, amount, price }) => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <span className={`h-3 w-3 shrink-0 rounded-full ${colorOf(p).dot}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.name}</div>
                  <div className="text-sm text-gray-600">
                    {formatPaise(lineAmounts(p, qty, incl, amount, price).line)}
                    {amount ? <span className="ml-1 font-semibold text-brand-800">· give {weightText(qty)}</span> : null}
                  </div>
                  {price ? (
                    <div className="text-xs font-semibold text-amber-700">
                      🤝 {formatPaise(price)}/{UNIT_LABEL[p.unit]} (normal {formatPaise(p.price_paise)})
                    </div>
                  ) : null}
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
                  <>
                    {(canBargain || price) && (
                      <button
                        aria-label={`Bargain price for ${p.name}`}
                        className={`h-11 w-11 rounded-xl text-lg ${price ? 'bg-amber-100' : 'bg-gray-100'}`}
                        onClick={() => setPricing(p)}
                      >
                        🤝
                      </button>
                    )}
                    <div className="flex items-center">
                      <button
                        aria-label="One less"
                        className="h-11 w-11 rounded-xl bg-gray-100 text-2xl"
                        onClick={() => setQty(p, qty - 1)}
                      >
                        −
                      </button>
                      <span className="w-9 text-center text-lg font-bold">{qty}</span>
                      <button
                        aria-label="One more"
                        className="h-11 w-11 rounded-xl bg-gray-100 text-2xl"
                        onClick={() => setQty(p, qty + 1)}
                      >
                        +
                      </button>
                    </div>
                  </>
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
          canBargain={canBargain}
          onClose={() => setWeighing(null)}
          onSave={(c) => {
            applyChange(weighing, c);
            setWeighing(null);
          }}
        />
      )}

      {pricing && (
        <RateSheet
          product={pricing}
          current={lineOf(pricing)?.price}
          onClose={() => setPricing(null)}
          onSave={(price) => {
            const l = lineOf(pricing);
            if (l)
              putLine(pricing, {
                product: pricing,
                qty: l.qty,
                ...(price ? { price } : {}),
              });
            setPricing(null);
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

/** The "bargain" rate box. The normal price (or the same number) means no bargain. */
function useRate(product: Product, current: number | undefined) {
  const [text, setText] = useState(String((current ?? product.price_paise) / 100));
  const paise = rupeesToPaise(text);
  const valid = !!paise && paise > 0 && paise <= 10000000;
  const bargain = valid && paise !== product.price_paise ? paise! : undefined;
  return {
    text,
    setText,
    paise: valid ? paise! : null,
    bargain,
    reset: () => setText(String(product.price_paise / 100)),
  };
}

function RateField({ product, rate }: { product: Product; rate: ReturnType<typeof useRate> }) {
  return (
    <div className={`rounded-xl p-3 ${rate.bargain ? 'bg-amber-50 ring-1 ring-amber-300' : 'bg-gray-50'}`}>
      <Field
        label={`🤝 Rate for this bill (₹ per ${UNIT_LABEL[product.unit]})`}
        hint={`Normal price ${formatPaise(product.price_paise)}. Change it only if you agreed a different price. The product's own price stays the same.`}
      >
        <div className="flex items-center gap-2">
          <Input
            aria-label="Bargain rate"
            inputMode="decimal"
            value={rate.text}
            onChange={(e) => rate.setText(e.target.value.replace(/[^\d.]/g, ''))}
          />
          {rate.bargain && (
            <button
              type="button"
              className="min-h-11 shrink-0 rounded-xl bg-white px-3 text-sm font-semibold ring-1 ring-gray-300"
              onClick={rate.reset}
            >
              Normal
            </button>
          )}
        </div>
      </Field>
      {!rate.paise && <p className="mt-1 text-sm text-red-700">Enter a rate like 160 or 160.50</p>}
    </div>
  );
}

/** Packets / pieces: bargain the rate for this bill. */
function RateSheet({
  product,
  current,
  onClose,
  onSave,
}: {
  product: Product;
  current: number | undefined;
  onClose: () => void;
  onSave: (price: number | undefined) => void;
}) {
  const rate = useRate(product, current);
  return (
    <Sheet title={product.name} onClose={onClose}>
      <div className="space-y-3">
        <RateField product={product} rate={rate} />
        <Button className="w-full" disabled={!rate.paise} onClick={() => onSave(rate.bargain)}>
          {rate.bargain ? `Use ${formatPaise(rate.bargain)} / ${UNIT_LABEL[product.unit]}` : 'Use normal price'}
        </Button>
      </div>
    </Sheet>
  );
}

/** For kg products: sell by weight or by money, optionally at a bargained rate. Quick buttons add up. */
function WeighSheet({
  product,
  current,
  canBargain,
  onClose,
  onSave,
}: {
  product: Product;
  current: Line | null;
  canBargain: boolean;
  onClose: () => void;
  onSave: (c: LineChange) => void;
}) {
  const [mode, setMode] = useState<'weight' | 'amount'>(current?.amount ? 'amount' : 'weight');
  const [kgText, setKgText] = useState(current && !current.amount ? String(current.qty) : '');
  const [rsText, setRsText] = useState(current?.amount ? String(current.amount / 100) : '');
  const [showRate, setShowRate] = useState(!!current?.price);
  const rate = useRate(product, current?.price);
  const perKg = rate.paise ?? product.price_paise;

  const kg = Number(kgText);
  const kgValid = kgText !== '' && Number.isFinite(kg) && kg > 0 && kg <= 10000 && !!rate.paise;
  const paise = rupeesToPaise(rsText);
  const giveKg = paise ? round3(paise / perKg) : 0;
  const rsValid = !!paise && giveKg > 0 && giveKg <= 10000 && !!rate.paise;

  const addKg = (w: number) => setKgText(String(round3((Number(kgText) || 0) + w)));
  const addRs = (r: number) => setRsText(String(Math.round(((Number(rsText) || 0) + r) * 100) / 100));
  const price = rate.bargain ? { price: rate.bargain } : {};
  const saveWeight = () => kgValid && onSave({ qty: round3(kg), ...price });
  const saveAmount = () => rsValid && onSave({ qty: giveKg, amount: paise!, ...price });

  return (
    <Sheet title={product.name} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-gray-600">
            {rate.bargain ? (
              <>
                <b className="text-amber-700">{formatPaise(rate.bargain)} per kg</b> (normal {formatPaise(product.price_paise)})
              </>
            ) : (
              <>{formatPaise(product.price_paise)} per kg</>
            )}
          </p>
          {!showRate && canBargain && (
            <button
              className="min-h-10 shrink-0 rounded-xl bg-amber-50 px-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-300"
              onClick={() => setShowRate(true)}
            >
              🤝 Bargain
            </button>
          )}
        </div>
        {showRate && <RateField product={product} rate={rate} />}

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
              {[0.1, 0.25, 0.5, 1].map((w) => (
                <Button key={w} variant="secondary" className="whitespace-nowrap px-1 text-sm" onClick={() => addKg(w)}>
                  +{w < 1 ? `${Math.round(w * 1000)} g` : `${w} kg`}
                </Button>
              ))}
            </div>
            <Field label="Weight in kg" hint="Tap to add up (250 g twice = 0.5 kg), or type, e.g. 1.35">
              <div className="flex items-center gap-2">
                <Input
                  inputMode="decimal"
                  value={kgText}
                  onChange={(e) => setKgText(e.target.value.replace(/[^\d.]/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && saveWeight()}
                />
                {kgText && (
                  <button className="min-h-11 shrink-0 rounded-xl bg-gray-100 px-3 text-sm font-semibold" onClick={() => setKgText('')}>
                    Clear
                  </button>
                )}
              </div>
            </Field>
            {kgValid && (
              <p className="text-center text-gray-600">
                {weightText(kg)} = <b>{formatPaise(Math.round(perKg * kg))}</b>
              </p>
            )}
            <Button className="w-full" disabled={!kgValid} onClick={saveWeight}>
              Set weight
            </Button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {[50, 100, 200, 500].map((r) => (
                <Button key={r} variant="secondary" className="whitespace-nowrap px-1 text-sm" onClick={() => addRs(r)}>
                  +₹{r}
                </Button>
              ))}
            </div>
            <Field
              label="Amount the customer wants (₹)"
              hint="Tap to add up (₹50 twice = ₹100), or type. The bill shows exactly this amount."
            >
              <div className="flex items-center gap-2">
                <Input
                  inputMode="decimal"
                  value={rsText}
                  onChange={(e) => setRsText(e.target.value.replace(/[^\d.]/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && saveAmount()}
                />
                {rsText && (
                  <button className="min-h-11 shrink-0 rounded-xl bg-gray-100 px-3 text-sm font-semibold" onClick={() => setRsText('')}>
                    Clear
                  </button>
                )}
              </div>
            </Field>
            {paise && rate.paise ? (
              rsValid ? (
                <p className="text-center text-lg">
                  Give <b className="text-brand-800">{weightText(giveKg)}</b>
                </p>
              ) : (
                <p className="text-center text-sm text-red-700">That amount is too small to weigh.</p>
              )
            ) : null}
            <Button className="w-full" disabled={!rsValid} onClick={saveAmount}>
              Set amount
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
