import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input, Sheet, Spinner } from '../components/ui';
import { friendlyError, istToday } from '../lib/data';
import { formatPaise, rupeesToPaise } from '../lib/money';
import { displayPhone } from '../lib/phone';
import { callFunction, supabase } from '../lib/supabase';
import { ROLE_LABEL, type Role } from '../lib/types';
import {
  balanceText,
  istMonth,
  monthName,
  rateText,
  TXN_LABEL,
  type MonthSummary,
  type Txn,
  type Worker,
} from '../lib/workforce';
import { WorkerForm } from './Workers';

type EntryType = 'payment' | 'advance' | 'bonus' | 'deduction';
const ENTRY: Record<EntryType, { label: string; icon: string; hint: string }> = {
  payment: { label: 'Pay', icon: '💵', hint: 'Money paid against wages already earned.' },
  advance: { label: 'Advance', icon: '⏩', hint: 'Money given before it is earned. It is adjusted against future wages.' },
  bonus: { label: 'Bonus', icon: '🎁', hint: 'Extra money added to what the farm owes the worker.' },
  deduction: { label: 'Deduct', icon: '➖', hint: 'Reduces what the farm owes (e.g. leave, damage).' },
};

/** Owner: /workers/:id (full control). Worker: /me (read-only, own record). */
export function WorkerDetail({ self = false }: { self?: boolean }) {
  const params = useParams();
  const { profile } = useAuth();
  const isOwner = profile?.role === 'owner' && !self;
  const [worker, setWorker] = useState<Worker | null>(null);
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [entry, setEntry] = useState<EntryType | null>(null);
  const [editing, setEditing] = useState(false);
  const [undoing, setUndoing] = useState<Txn | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(async () => {
    let q = supabase.from('workers').select('*');
    q = self ? q.eq('profile_id', profile?.id ?? '') : q.eq('id', params.id ?? '');
    const { data, error } = await q.maybeSingle();
    if (error) return setError(friendlyError(error));
    if (!data)
      return setError(self ? 'Your login is not linked to a worker record yet. Please ask the owner.' : 'Worker not found.');
    setWorker(data as Worker);
    const t = await supabase
      .from('worker_transactions')
      .select('*')
      .eq('worker_id', data.id)
      .order('txn_date', { ascending: true })
      .order('created_at', { ascending: true });
    if (t.error) return setError(friendlyError(t.error));
    setTxns(t.data as Txn[]);
    setReload((n) => n + 1);
  }, [params.id, profile?.id, self]);

  useEffect(() => {
    load();
  }, [load]);

  // Running balance after each entry; shown newest first.
  const ledger = useMemo(() => {
    let run = 0;
    const undone = new Set((txns ?? []).filter((t) => t.reverses_id).map((t) => t.reverses_id));
    return (txns ?? []).map((t) => ({ ...t, balance: (run += t.amount_paise), undone: undone.has(t.id) })).reverse();
  }, [txns]);
  const balance = ledger[0]?.balance ?? 0;

  if (error) return <Alert>{error}</Alert>;
  if (!worker || !txns) return <Spinner />;
  const b = balanceText(balance);

  function done(m: string) {
    setEntry(null);
    setEditing(false);
    setUndoing(null);
    setFlash(m);
    load();
  }

  return (
    <div className="space-y-4">
      {flash && <Alert kind="success">{flash}</Alert>}

      <Card>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-xl font-bold">{worker.name}</h2>
            <div className="text-sm text-gray-600">
              {rateText(worker)}
              {worker.category ? ` · ${worker.category}` : ''}
              {worker.phone ? ` · ${displayPhone(worker.phone)}` : ''}
            </div>
            {!worker.active && <div className="text-sm font-semibold text-red-700">Not working here now</div>}
          </div>
          {isOwner && (
            <button className="min-h-10 px-2 text-sm font-semibold text-brand-800" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
        <div className={`mt-3 text-2xl font-bold ${b.cls}`}>{b.text}</div>
      </Card>

      {isOwner && (
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(ENTRY) as EntryType[]).map((k) => (
            <Button key={k} variant={k === 'payment' ? 'primary' : 'secondary'} className="flex-col px-1 text-sm" onClick={() => setEntry(k)}>
              <span className="text-lg">{ENTRY[k].icon}</span>
              {ENTRY[k].label}
            </Button>
          ))}
        </div>
      )}

      <MonthCard worker={worker} canClose={isOwner} reloadKey={reload} onChanged={done} />

      <section>
        <h3 className="mb-2 font-semibold">History</h3>
        {ledger.length === 0 ? (
          <p className="text-gray-500">No entries yet. Day wages appear here when attendance is marked.</p>
        ) : (
          <ul className="divide-y rounded-2xl bg-white shadow-sm ring-1 ring-gray-200">
            {ledger.map((t) => (
              <li key={t.id} className={`flex items-center gap-2 p-3 ${t.undone ? 'opacity-50' : ''}`}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {TXN_LABEL[t.type]}
                    {t.mode ? ` (${t.mode === 'cash' ? 'Cash' : 'UPI'})` : ''}
                    {t.undone && ' · undone'}
                  </div>
                  <div className="truncate text-xs text-gray-500">
                    {new Date(t.txn_date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    {t.note ? ` · ${t.note}` : ''}
                  </div>
                  {isOwner && !t.undone && t.type !== 'reversal' && !t.attendance_id && (
                    <button className="min-h-8 text-xs text-red-700" onClick={() => setUndoing(t)}>
                      Undo this entry
                    </button>
                  )}
                </div>
                <div className="text-right">
                  <div className={`font-semibold ${t.amount_paise < 0 ? 'text-red-700' : 'text-brand-800'}`}>
                    {t.amount_paise < 0 ? '−' : '+'}
                    {formatPaise(Math.abs(t.amount_paise))}
                  </div>
                  <div className="text-xs text-gray-500">bal {formatPaise(t.balance)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isOwner && <LoginCard worker={worker} onDone={done} />}

      {entry && <EntrySheet type={entry} worker={worker} balance={balance} onClose={() => setEntry(null)} onDone={done} />}
      {editing && <WorkerForm worker={worker} onClose={() => setEditing(false)} onDone={done} />}
      {undoing && <UndoSheet txn={undoing} onClose={() => setUndoing(null)} onDone={done} />}
    </div>
  );
}

function MonthCard({
  worker,
  canClose,
  reloadKey,
  onChanged,
}: {
  worker: Worker;
  canClose: boolean;
  reloadKey: number;
  onChanged: (m: string) => void;
}) {
  const [month, setMonth] = useState(istMonth());
  const [s, setS] = useState<MonthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [salary, setSalary] = useState('');
  const [deduction, setDeduction] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.rpc('worker_month', { p_worker_id: worker.id, p_month: `${month}-01` }).then(({ data, error }) => {
      if (error) return setError(friendlyError(error));
      setError(null);
      setS(data as MonthSummary);
    });
    setSalary(String(worker.rate_paise / 100));
    setDeduction('');
  }, [worker.id, worker.rate_paise, month, reloadKey]);

  async function closeMonth() {
    const sal = rupeesToPaise(salary);
    const ded = deduction.trim() ? rupeesToPaise(deduction) : 0;
    if (!sal) return setError('Enter the salary for this month.');
    if (ded === null) return setError('Deduction must be a number.');
    setBusy(true);
    const { error } = await supabase.rpc('close_month', {
      p_worker_id: worker.id,
      p_month: `${month}-01`,
      p_salary_paise: sal,
      p_deduction_paise: ded,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onChanged(`${monthName(month)} closed: ${formatPaise(sal - ded)} added for ${worker.name}.`);
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Month</h3>
        <Input type="month" className="max-w-44" value={month} max={istMonth()} onChange={(e) => setMonth(e.target.value || istMonth())} />
      </div>
      {error && <Alert>{error}</Alert>}
      {s && (
        <>
          <div className="grid grid-cols-4 gap-2 text-center">
            {(
              [
                ['Present', s.present, 'text-brand-800'],
                ['Half day', s.half_day, 'text-amber-700'],
                ['Absent', s.absent, 'text-red-700'],
                ['Leave', s.leave, 'text-blue-700'],
              ] as const
            ).map(([label, n, cls]) => (
              <div key={label} className="rounded-xl bg-gray-50 p-2">
                <div className={`text-xl font-bold ${cls}`}>{n}</div>
                <div className="text-xs text-gray-600">{label}</div>
              </div>
            ))}
          </div>
          <div className="space-y-1 text-sm">
            {(
              [
                ['Earned', s.earned_paise, 1],
                ['Bonus', s.bonus_paise, 1],
                ['Deductions', s.deduction_paise, -1],
                ['Advances given', s.advance_paise, -1],
                ['Paid', s.paid_paise, -1],
              ] as const
            ).map(([label, v, sign]) =>
              v ? (
                <div key={label} className="flex justify-between">
                  <span>{label}</span>
                  <span className={sign < 0 ? 'text-red-700' : ''}>
                    {sign < 0 ? '−' : '+'}
                    {formatPaise(v)}
                  </span>
                </div>
              ) : null,
            )}
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Balance now (all months)</span>
              <span>{formatPaise(s.balance_paise)}</span>
            </div>
          </div>

          {s.pay_type === 'monthly' &&
            (s.closed ? (
              <p className="rounded-xl bg-brand-50 p-2 text-sm text-brand-900">
                ✓ Salary for {monthName(month)} is added. {canClose && 'To redo it, undo the salary entry in History.'}
              </p>
            ) : canClose ? (
              <div className="space-y-2 rounded-xl bg-gray-50 p-3">
                <div className="font-semibold">Close {monthName(month)}</div>
                <p className="text-xs text-gray-600">
                  Leave taken: {s.leave} day(s), absent {s.absent}, half days {s.half_day}. Decide any deduction yourself.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Salary ₹">
                    <Input inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} />
                  </Field>
                  <Field label="Deduction ₹ (optional)">
                    <Input inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} placeholder="0" />
                  </Field>
                </div>
                <Field label="Deduction note (optional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. 2 days unpaid leave" />
                </Field>
                <Button className="w-full" disabled={busy} onClick={closeMonth}>
                  {busy ? 'Saving…' : `Add salary ${formatPaise((rupeesToPaise(salary) ?? 0) - (rupeesToPaise(deduction || '0') ?? 0))}`}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-gray-600">Salary for this month is not added yet.</p>
            ))}
        </>
      )}
    </Card>
  );
}

function EntrySheet({
  type,
  worker,
  balance,
  onClose,
  onDone,
}: {
  type: EntryType;
  worker: Worker;
  balance: number;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [amount, setAmount] = useState(type === 'payment' && balance > 0 ? String(balance / 100) : '');
  const [date, setDate] = useState(istToday());
  const [mode, setMode] = useState<'cash' | 'upi'>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsMode = type === 'payment' || type === 'advance';

  async function save() {
    const paise = rupeesToPaise(amount);
    if (!paise) return setError('Enter the amount, like 500');
    setBusy(true);
    const { error } = await supabase.rpc('add_worker_txn', {
      p_worker_id: worker.id,
      p_type: type,
      p_amount_paise: paise,
      p_date: date,
      p_mode: needsMode ? mode : null,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) setError(friendlyError(error));
    else onDone(`${ENTRY[type].label} of ${formatPaise(paise)} saved for ${worker.name}.`);
  }

  return (
    <Sheet title={`${ENTRY[type].label}: ${worker.name}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">{ENTRY[type].hint}</p>
        {type === 'payment' && <p className="text-sm font-medium">{balanceText(balance).text}</p>}
        {error && <Alert>{error}</Alert>}
        <Field label="Amount (₹)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || istToday())} />
        </Field>
        {needsMode && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant={mode === 'cash' ? 'primary' : 'secondary'} onClick={() => setMode('cash')}>
              💵 Cash
            </Button>
            <Button variant={mode === 'upi' ? 'primary' : 'secondary'} onClick={() => setMode('upi')}>
              📱 UPI
            </Button>
          </div>
        )}
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        {needsMode && mode === 'cash' && (
          <p className="text-xs text-gray-500">If this cash comes out of the shop till, also add a Cash out entry so the till matches.</p>
        )}
        <Button className="w-full" disabled={busy || !amount} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Sheet>
  );
}

function UndoSheet({ txn, onClose, onDone }: { txn: Txn; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function run() {
    const { error } = await supabase.rpc('reverse_worker_txn', { p_txn_id: txn.id, p_reason: reason });
    if (error) setError(friendlyError(error));
    else onDone('Entry undone. The history keeps both lines.');
  }
  return (
    <Sheet title={`Undo ${TXN_LABEL[txn.type]} of ${formatPaise(Math.abs(txn.amount_paise))}?`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">An opposite entry is added. Nothing is deleted.</p>
        {error && <Alert>{error}</Alert>}
        <Field label="Reason">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Entered twice" />
        </Field>
        <Button variant="danger" className="w-full" disabled={reason.trim().length < 3} onClick={run}>
          Yes, undo it
        </Button>
      </div>
    </Sheet>
  );
}

/** Owner: give the worker an app login, or let them do billing (cashier). */
function LoginCard({ worker, onDone }: { worker: Worker; onDone: (m: string) => void }) {
  const [login, setLogin] = useState<{ role: Role; active: boolean } | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!worker.profile_id) return setLogin(null);
    supabase
      .from('profiles')
      .select('role, active')
      .eq('id', worker.profile_id)
      .maybeSingle()
      .then(({ data }) => setLogin((data as { role: Role; active: boolean }) ?? null));
  }, [worker.profile_id]);

  async function run(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await callFunction('admin-users', body);
      onDone(message);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <Card className="space-y-3">
      <h3 className="font-semibold">App login</h3>
      {error && <Alert>{error}</Alert>}
      {login === undefined ? null : login ? (
        <>
          <p className="text-sm">
            Logs in as <b>{ROLE_LABEL[login.role]}</b>
            {!login.active && ' (disabled)'}. Can see their own attendance and pay.
          </p>
          {login.role === 'worker' && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => run({ action: 'set_role', user_id: worker.profile_id, role: 'cashier' }, `${worker.name} can now make bills.`)}
            >
              🧾 Allow billing (make cashier)
            </Button>
          )}
          {login.role === 'cashier' && (
            <Button
              variant="secondary"
              className="w-full"
              disabled={busy}
              onClick={() => run({ action: 'set_role', user_id: worker.profile_id, role: 'worker' }, `${worker.name} can no longer make bills.`)}
            >
              Stop billing (back to worker)
            </Button>
          )}
          <p className="text-xs text-gray-500">Reset password or disable the login from Home → Users.</p>
        </>
      ) : !worker.phone ? (
        <p className="text-sm text-gray-600">Add a mobile number (Edit) to give {worker.name} an app login.</p>
      ) : (
        <>
          <p className="text-sm text-gray-600">
            {worker.name} can log in with {displayPhone(worker.phone)} to see their own attendance and pay.
          </p>
          <Field label="Set a password (at least 6 characters)">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy || password.length < 6}
            onClick={() =>
              run(
                { action: 'create', phone: worker.phone, full_name: worker.name, role: 'worker', password },
                `Login created for ${worker.name}.`,
              )
            }
          >
            Create login
          </Button>
        </>
      )}
    </Card>
  );
}
