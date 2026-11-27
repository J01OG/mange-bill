import { Field, Input } from './ui';
import { formatPaise, rupeesToPaise } from '../lib/money';

/** Two boxes, "Cash ₹" and "UPI ₹". Fill one, or both for a split. */
export interface CashUpi {
  cash: string;
  upi: string;
}

/** The typed amounts as payment lines. null = a box holds something that is not an amount. */
export function cashUpiLines(v: CashUpi): { mode: 'cash' | 'upi'; amount_paise: number }[] | null {
  const out: { mode: 'cash' | 'upi'; amount_paise: number }[] = [];
  for (const mode of ['cash', 'upi'] as const) {
    const t = v[mode].trim();
    if (!t) continue;
    const p = rupeesToPaise(t);
    if (p === null) return null;
    if (p > 0) out.push({ mode, amount_paise: p });
  }
  return out;
}
export const cashUpiTotal = (v: CashUpi) => (cashUpiLines(v) ?? []).reduce((s, l) => s + l.amount_paise, 0);

export function CashUpiInputs({ value, onChange, target }: { value: CashUpi; onChange: (v: CashUpi) => void; target?: number }) {
  const total = cashUpiTotal(value);
  const clean = (s: string) => s.replace(/[^\d.]/g, '');
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="💵 Cash ₹">
          <Input
            inputMode="decimal"
            value={value.cash}
            onChange={(e) => onChange({ ...value, cash: clean(e.target.value) })}
            placeholder="0"
          />
        </Field>
        <Field label="📱 UPI ₹">
          <Input
            inputMode="decimal"
            value={value.upi}
            onChange={(e) => onChange({ ...value, upi: clean(e.target.value) })}
            placeholder="0"
          />
        </Field>
      </div>
      {target !== undefined && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            className="min-h-10 rounded-xl bg-gray-100 px-3 font-semibold"
            onClick={() => onChange({ cash: String(target / 100), upi: '' })}
          >
            All cash
          </button>
          <button
            type="button"
            className="min-h-10 rounded-xl bg-gray-100 px-3 font-semibold"
            onClick={() => onChange({ cash: '', upi: String(target / 100) })}
          >
            All UPI
          </button>
          <span className={`ml-auto font-semibold ${total === target ? 'text-brand-800' : 'text-red-700'}`}>
            {formatPaise(total)} of {formatPaise(target)}
          </span>
        </div>
      )}
    </div>
  );
}
