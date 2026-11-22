import { formatPaise } from './money';

export type PayType = 'daily' | 'monthly';
export type AttStatus = 'present' | 'half_day' | 'absent' | 'leave';
export type TxnType = 'earned' | 'bonus' | 'payment' | 'advance' | 'deduction' | 'reversal';

export interface WorkerBalance {
  worker_id: string;
  name: string;
  phone: string | null;
  pay_type: PayType;
  rate_paise: number;
  category: string | null;
  active: boolean;
  profile_id: string | null;
  balance_paise: number;
  last_paid_on: string | null;
}

export interface Worker {
  id: string;
  name: string;
  phone: string | null;
  pay_type: PayType;
  rate_paise: number;
  category: string | null;
  joined_on: string;
  active: boolean;
  profile_id: string | null;
}

export interface Txn {
  id: string;
  txn_date: string;
  type: TxnType;
  amount_paise: number;
  mode: 'cash' | 'upi' | null;
  period_month: string | null;
  attendance_id: string | null;
  reverses_id: string | null;
  note: string | null;
  created_at: string;
}

export interface MonthSummary {
  month: string;
  pay_type: PayType;
  rate_paise: number;
  present: number;
  half_day: number;
  absent: number;
  leave: number;
  earned_paise: number;
  bonus_paise: number;
  paid_paise: number;
  advance_paise: number;
  deduction_paise: number;
  closed: boolean;
  salary_txn_id: string | null;
  balance_paise: number;
}

export const ATT: Record<AttStatus, { short: string; label: string; on: string }> = {
  present: { short: 'P', label: 'Present', on: 'bg-brand-700 text-white ring-brand-700' },
  half_day: { short: '½', label: 'Half day', on: 'bg-amber-500 text-white ring-amber-500' },
  absent: { short: 'A', label: 'Absent', on: 'bg-red-600 text-white ring-red-600' },
  leave: { short: 'L', label: 'Leave', on: 'bg-blue-600 text-white ring-blue-600' },
};

export const TXN_LABEL: Record<TxnType, string> = {
  earned: 'Earned',
  bonus: 'Bonus',
  payment: 'Paid',
  advance: 'Advance',
  deduction: 'Deduction',
  reversal: 'Undo',
};

export function rateText(w: { pay_type: PayType; rate_paise: number }) {
  return `${formatPaise(w.rate_paise)} / ${w.pay_type === 'daily' ? 'day' : 'month'}`;
}

/** Positive balance = farm owes the worker. Negative = worker has taken more (advance). */
export function balanceText(paise: number) {
  if (paise > 0) return { text: `Due to worker ${formatPaise(paise)}`, cls: 'text-brand-800' };
  if (paise < 0) return { text: `Advance taken ${formatPaise(-paise)}`, cls: 'text-amber-700' };
  return { text: 'All settled', cls: 'text-gray-600' };
}

/** "2026-11" for <input type="month"> in India time. */
export function istMonth(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
}
export function monthName(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}
