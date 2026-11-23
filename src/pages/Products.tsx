import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Select, Sheet, Spinner } from '../components/ui';
import { colorOf, COLORS, friendlyError, UNIT_LABEL, useProducts, type Color, type Product, type Unit } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { supabase } from '../lib/supabase';

const GST_RATES = [0, 5, 12, 18];

export function Products() {
  const [showArchived, setShowArchived] = useState(false);
  const { products, error, reload } = useProducts(true);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const shown = (products ?? []).filter((p) => (showArchived ? p.archived_at : !p.archived_at));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Products</h2>
        <Button onClick={() => setEditing('new')}>+ Add product</Button>
      </div>
      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="flex gap-2">
        <Button variant={showArchived ? 'secondary' : 'primary'} className="flex-1" onClick={() => setShowArchived(false)}>
          On sale
        </Button>
        <Button variant={showArchived ? 'primary' : 'secondary'} className="flex-1" onClick={() => setShowArchived(true)}>
          Archived
        </Button>
      </div>

      {!products ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {shown.map((p) => (
            <li key={p.id}>
              <button className="w-full text-left" onClick={() => setEditing(p)}>
                <Card className="flex items-center justify-between gap-3">
                  <span className={`h-4 w-4 shrink-0 rounded-full ${colorOf(p).dot}`} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-sm text-gray-600">
                      {p.section ? `${p.section} · ` : ''}per {UNIT_LABEL[p.unit]} · GST {p.gst_rate_bp / 100}%
                      {p.hsn_code ? ` · HSN ${p.hsn_code}` : ''}
                    </div>
                  </div>
                  <div className="text-lg font-bold">{formatPaise(p.price_paise)}</div>
                </Card>
              </button>
            </li>
          ))}
          {shown.length === 0 && <p className="text-center text-gray-500">No products here.</p>}
        </ul>
      )}

      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          sections={[...new Set((products ?? []).map((p) => p.section?.trim()).filter((x): x is string => !!x))]}
          onClose={() => setEditing(null)}
          onDone={(m) => {
            setEditing(null);
            setFlash(m);
            reload();
          }}
        />
      )}
    </div>
  );
}

function ProductForm({
  product,
  sections,
  onClose,
  onDone,
}: {
  product: Product | null;
  sections: string[];
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [color, setColor] = useState<Color>((product?.color as Color) ?? 'gray');
  const [section, setSection] = useState(product?.section ?? '');
  const [name, setName] = useState(product?.name ?? '');
  const [localName, setLocalName] = useState(product?.local_name ?? '');
  const [unit, setUnit] = useState<Unit>(product?.unit ?? 'packet');
  const [price, setPrice] = useState(product ? String(product.price_paise / 100) : '');
  const [gst, setGst] = useState(String((product?.gst_rate_bp ?? 0) / 100));
  const [hsn, setHsn] = useState(product?.hsn_code ?? '');
  const [sort, setSort] = useState(String(product?.sort_order ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const price_paise = rupeesToPaise(price);
    if (price_paise === null) return setError('Enter a price like 60 or 60.50');
    const row = {
      name: name.trim(),
      local_name: localName.trim() || null,
      unit,
      price_paise,
      gst_rate_bp: Math.round(Number(gst) * 100),
      hsn_code: hsn.trim() || null,
      sort_order: Number(sort) || 0,
      color,
      section: section.trim() || null,
    };
    setBusy(true);
    const { error } = product
      ? await supabase.from('products').update(row).eq('id', product.id)
      : await supabase.from('products').insert(row);
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone(`${row.name} saved.`);
  }

  async function toggleArchive() {
    if (!product) return;
    setBusy(true);
    const archived_at = product.archived_at ? null : new Date().toISOString();
    const { error } = await supabase.from('products').update({ archived_at }).eq('id', product.id);
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone(archived_at ? `${product.name} archived. It no longer shows on the bill screen.` : `${product.name} is on sale again.`);
  }

  return (
    <Sheet title={product ? 'Edit product' : 'Add product'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Name (as printed on the bill)">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </Field>
        <Field label="Local name (optional)" hint="Hindi / Marathi name, for later.">
          <Input value={localName} onChange={(e) => setLocalName(e.target.value)} maxLength={80} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sold per">
            <Select value={unit} onChange={(e) => setUnit(e.target.value as Unit)}>
              <option value="packet">Packet</option>
              <option value="kg">Kg (weighed)</option>
              <option value="piece">Piece</option>
            </Select>
          </Field>
          <Field label="Price (₹)">
            <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="60" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GST rate">
            <Select value={gst} onChange={(e) => setGst(e.target.value)}>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>
                  {r === 0 ? '0% (nil)' : `${r}%`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN code (optional)">
            <Input value={hsn} onChange={(e) => setHsn(e.target.value)} maxLength={10} inputMode="numeric" />
          </Field>
        </div>
        <Field label="Section (optional)" hint="Groups buttons on the bill screen, e.g. Fresh, Dry, Spawn.">
          <Input list="product-sections" value={section} onChange={(e) => setSection(e.target.value)} maxLength={40} placeholder="Fresh" />
          <datalist id="product-sections">
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700">Button colour</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Button colour">
            {(Object.keys(COLORS) as Color[]).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={COLORS[c].label}
                title={COLORS[c].label}
                onClick={() => setColor(c)}
                className={`flex h-11 w-11 items-center justify-center rounded-full ring-1 ${COLORS[c].tile} ${color === c ? 'outline outline-[3px] outline-offset-2 outline-brand-700' : ''}`}
              >
                <span className={`h-5 w-5 rounded-full ${COLORS[c].dot}`} />
              </button>
            ))}
          </div>
        </div>
        <Field label="Position on bill screen" hint="Smaller numbers show first.">
          <Input inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {product && (
          <Button type="button" variant="secondary" className="w-full" disabled={busy} onClick={toggleArchive}>
            {product.archived_at ? 'Put back on sale' : 'Archive (stop selling)'}
          </Button>
        )}
      </form>
    </Sheet>
  );
}
