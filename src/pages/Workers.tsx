import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, buttonClass, Card, Field, Input, Select, Sheet, Spinner } from '../components/ui';
import { friendlyError, istToday } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { displayPhone, normalisePhone } from '../lib/phone';
import { supabase } from '../lib/supabase';
import { balanceText, rateText, type PayType, type Worker, type WorkerBalance } from '../lib/workforce';

export function Workers() {
  const [rows, setRows] = useState<WorkerBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('worker_balances').select('*').order('name');
    if (error) setError(friendlyError(error));
    else setRows(data as WorkerBalance[]);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const shown = (rows ?? []).filter((r) => r.active !== showInactive);
  const totalDue = (rows ?? []).filter((r) => r.active && r.balance_paise > 0).reduce((s, r) => s + r.balance_paise, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Workforce</h2>
        <Button onClick={() => setAdding(true)}>+ Add worker</Button>
      </div>
      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert>{error}</Alert>}

      <div className="grid grid-cols-2 gap-2">
        <Link to="/attendance" className={buttonClass('primary', 'min-h-14')}>
          ✅ Mark attendance
        </Link>
        <Card className="text-center">
          <div className="text-xs text-gray-500">Total due to workers</div>
          <div className="text-lg font-bold">{formatPaise(totalDue)}</div>
        </Card>
      </div>

      <div className="flex gap-2">
        <Button variant={showInactive ? 'secondary' : 'primary'} className="flex-1" onClick={() => setShowInactive(false)}>
          Working
        </Button>
        <Button variant={showInactive ? 'primary' : 'secondary'} className="flex-1" onClick={() => setShowInactive(true)}>
          Left / inactive
        </Button>
      </div>

      {!rows ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => {
            const b = balanceText(r.balance_paise);
            return (
              <li key={r.worker_id}>
                <Link to={`/workers/${r.worker_id}`}>
                  <Card className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{r.name}</div>
                      <div className="text-sm text-gray-600">
                        {rateText(r)}
                        {r.category ? ` · ${r.category}` : ''}
                      </div>
                    </div>
                    <div className={`text-right text-sm font-semibold ${b.cls}`}>{b.text}</div>
                  </Card>
                </Link>
              </li>
            );
          })}
          {shown.length === 0 && <p className="text-center text-gray-500">No workers here.</p>}
        </ul>
      )}

      {adding && (
        <WorkerForm
          worker={null}
          onClose={() => setAdding(false)}
          onDone={(m) => {
            setAdding(false);
            setFlash(m);
            load();
          }}
        />
      )}
    </div>
  );
}

export function WorkerForm({ worker, onClose, onDone }: { worker: Worker | null; onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState(worker?.name ?? '');
  const [phone, setPhone] = useState(worker?.phone ? displayPhone(worker.phone) : '');
  const [payType, setPayType] = useState<PayType>(worker?.pay_type ?? 'daily');
  const [rate, setRate] = useState(worker ? String(worker.rate_paise / 100) : '');
  const [category, setCategory] = useState(worker?.category ?? '');
  const [joined, setJoined] = useState(worker?.joined_on ?? istToday());
  const [active, setActive] = useState(worker?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const p = phone.trim() ? normalisePhone(phone) : null;
    if (phone.trim() && !p) return setError('Mobile number is not valid (or leave it empty).');
    const r = rupeesToPaise(rate);
    if (r === null) return setError('Enter the pay, like 500');
    const row = {
      name: name.trim(),
      phone: p,
      pay_type: payType,
      rate_paise: r,
      category: category.trim() || null,
      joined_on: joined,
      active,
    };
    setBusy(true);
    const res = worker
      ? await supabase.from('workers').update(row).eq('id', worker.id)
      : await supabase.from('workers').insert(row);
    setBusy(false);
    if (res.error)
      setError(/duplicate|unique/i.test(res.error.message) ? 'Another worker already has this mobile number.' : friendlyError(res.error));
    else onDone(`${row.name} saved.`);
  }

  return (
    <Sheet title={worker ? 'Edit worker' : 'Add worker'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Mobile (optional, needed for app login)">
          <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paid">
            <Select value={payType} onChange={(e) => setPayType(e.target.value as PayType)}>
              <option value="daily">Per day</option>
              <option value="monthly">Per month</option>
            </Select>
          </Field>
          <Field label={payType === 'daily' ? '₹ per day' : '₹ per month'}>
            <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required />
          </Field>
        </div>
        {worker && worker.rate_paise !== rupeesToPaise(rate) && (
          <p className="text-xs text-gray-600">The new rate applies to attendance marked from now on. Past wages stay as they were.</p>
        )}
        <Field label="Worker class / category (optional)" hint="Your own grouping, e.g. Harvest, Packing, Senior.">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={50} />
        </Field>
        <Field label="Joined on">
          <Input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
        </Field>
        <label className="flex min-h-12 items-center gap-3">
          <input type="checkbox" className="h-6 w-6 accent-brand-700" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Still working here
        </label>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Sheet>
  );
}
