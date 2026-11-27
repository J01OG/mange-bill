import type { Unit } from './data';

export type OrderStatus = 'pending' | 'advance_paid' | 'ready' | 'delivered' | 'cancelled';

export interface OrderRow {
  id: string;
  order_no: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  delivery_date: string;
  delivery_note: string | null;
  status: OrderStatus;
  subtotal_paise: number;
  notes: string | null;
  cancel_reason: string | null;
  bill_id: string | null;
  created_at: string;
  advance_paise: number;
  balance_paise: number;
  item_count: number;
}

export interface OrderItem {
  id: string;
  product_id: string;
  product_name: string;
  unit: Unit;
  unit_price_paise: number;
  qty: number;
  line_total_paise: number;
}

export interface OrderPayment {
  id: string;
  kind: 'advance' | 'refund';
  mode: 'cash' | 'upi';
  amount_paise: number;
  business_date: string;
  note: string | null;
  created_at: string;
  /** Set on the two lines that switch an earlier payment to the other mode. */
  corrects_id?: string | null;
}

export const STATUS: Record<OrderStatus, { label: string; cls: string }> = {
  pending: { label: 'Pending', cls: 'bg-gray-200 text-gray-800' },
  advance_paid: { label: 'Advance paid', cls: 'bg-blue-100 text-blue-900' },
  ready: { label: 'Ready', cls: 'bg-amber-100 text-amber-900' },
  delivered: { label: 'Delivered', cls: 'bg-brand-100 text-brand-900' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-100 text-red-800' },
};

export const isOpen = (s: OrderStatus) => s === 'pending' || s === 'advance_paid' || s === 'ready';

/** Date helpers working on plain YYYY-MM-DD strings (no time-zone surprises). */
export function parseDay(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day);
}
export function fmtDay(dt: Date) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
export function addDays(d: string, n: number) {
  const dt = parseDay(d);
  dt.setDate(dt.getDate() + n);
  return fmtDay(dt);
}
/** Monday of the week containing d. */
export function weekStart(d: string) {
  const dt = parseDay(d);
  return addDays(d, -((dt.getDay() + 6) % 7));
}
export function longDay(d: string) {
  return parseDay(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}
