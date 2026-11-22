/* eslint-disable @typescript-eslint/no-explicit-any */
// DEMO MODE ONLY (`npm run demo`). A small in-browser imitation of the Supabase calls the
// app uses, so the screens can be tried without any setup. Data is lost on reload.
// It is NOT included in the real build and has none of the real security rules.
// The real rules and arithmetic live in supabase/migrations and are tested by scripts/test-db.mjs.

type Row = Record<string, any>;
const uid = () => crypto.getRandomValues(new Uint32Array(4)).join('-');
const now = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ok = (data: any = null) => ({ data, error: null });
const fail = (message: string) => ({ data: null, error: { message } });

const OWNER = { id: 'demo-owner', phone: '919000000001', full_name: 'Demo Owner', role: 'owner', active: true, lang: 'en', created_at: now() };
const CASHIER = { id: 'demo-cashier', phone: '919000000002', full_name: 'Demo Cashier', role: 'cashier', active: true, lang: 'en', created_at: now() };

const WORKER = { id: 'demo-worker', phone: '919000000003', full_name: 'Ramesh Pawar', role: 'worker', active: true, lang: 'en', created_at: now() };

const db: Record<string, Row[]> = {
  profiles: [OWNER, CASHIER, WORKER],
  workers: [
    { id: 'w1', profile_id: 'demo-worker', name: 'Ramesh Pawar', phone: '919000000003', pay_type: 'daily', rate_paise: 50000, category: 'Harvest', joined_on: '2026-01-01', active: true },
    { id: 'w2', profile_id: null, name: 'Sunita Jadhav', phone: null, pay_type: 'daily', rate_paise: 45000, category: 'Packing', joined_on: '2026-01-01', active: true },
    { id: 'w3', profile_id: null, name: 'Anil Shinde', phone: null, pay_type: 'monthly', rate_paise: 1500000, category: 'Supervisor', joined_on: '2026-01-01', active: true },
  ],
  attendance: [],
  worker_transactions: [],
  app_settings: [{
    id: true, farm_name: 'Green Valley Mushroom Farm', address: 'Village Road, Pune', phone: '+91 90000 00000',
    gstin: null, prices_include_gst: true, upi_id: 'greenvalley@okaxis', bill_prefix: 'MF',
    bill_footer: 'Fresh from our farm. Thank you!', report_email: null,
    report_enabled: true, report_time: '19:00:00', report_emails: ['owner@example.com'],
  }],
  report_runs: [],
  products: [
    ['Oyster mushroom 200 g', 'packet', 6000], ['Button mushroom 200 g', 'packet', 5000],
    ['Milky mushroom 250 g', 'packet', 7000], ['Oyster mushroom (loose)', 'kg', 24000],
    ['Shiitake 100 g', 'packet', 15000], ['Dried oyster 50 g', 'packet', 12000], ['Mushroom spawn bag', 'piece', 10000],
  ].map(([name, unit, price], i) => ({
    id: `p${i}`, name, local_name: null, unit, price_paise: price, gst_rate_bp: 0, hsn_code: '0709', sort_order: i, archived_at: null,
  })),
  coupons: [
    { id: 'c1', code: 'WELCOME10', description: '10% off', kind: 'percent', value: 1000, applies_to: 'all', customer_id: null,
      min_bill_paise: 0, expires_at: null, usage_limit: null, used_count: 0, active: true, created_at: now() },
    { id: 'c2', code: 'FLAT20', description: 'Rs 20 off', kind: 'flat', value: 2000, applies_to: 'all', customer_id: null,
      min_bill_paise: 0, expires_at: null, usage_limit: null, used_count: 0, active: true, created_at: now() },
  ],
  orders: [], order_items: [], order_payments: [],
  coupon_products: [], customers: [], bills: [], bill_items: [], payments: [], returns: [], return_items: [], cash_out: [],
};
const seq: Record<string, number> = {};
const nextNo = (prefix: string, width: number) => `${prefix}/26-27/${String((seq[prefix] = (seq[prefix] ?? 0) + 1)).padStart(width, '0')}`;
let me: Row | null = null;
const listeners: ((e: string, s: any) => void)[] = [];
const session = () => (me ? { user: { id: me.id }, access_token: 'demo' } : null);

class Query {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: [string, boolean][] = [];
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] = {};
  constructor(private table: string) {}
  select() { return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  private max = Infinity;
  limit(n: number) { this.max = n; return this; }
  range(from: number, to: number) { this.max = to - from + 1; return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
  lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.sorts.push([c, o?.ascending !== false]); return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.payload = p; return this; }
  update(p: Row) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(res?: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve(this.run()).then(res, rej); }
  private out(rows: Row[]) {
    const copy = rows.slice(0, this.max).map((r) => ({ ...r }));
    if (this.mode === 'many') return ok(copy);
    if (this.mode === 'single' && copy.length !== 1) return fail('Not found');
    return ok(copy[0] ?? null);
  }
  private run() {
    if (this.table === 'order_overview') {
      if (me?.role !== 'owner' && me?.role !== 'cashier') return this.out([]);
      let rows = db.orders.map((o): Row => {
        const adv = netAdvance(o.id);
        return { ...o, advance_paise: adv, balance_paise: ['delivered', 'cancelled'].includes(o.status) ? 0 : o.subtotal_paise - adv,
          item_count: db.order_items.filter((i) => i.order_id === o.id).length };
      }).filter((o) => me?.role === 'owner' || o.delivery_date === today());
      rows = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const [c, asc] of [...this.sorts].reverse())
        rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      return this.out(rows);
    }
    if (this.table === 'worker_balances') {
      const rows = db.workers.map((w): Row => {
        const tx = db.worker_transactions.filter((t) => t.worker_id === w.id);
        return { worker_id: w.id, ...w, balance_paise: tx.reduce((a, t) => a + t.amount_paise, 0), last_paid_on: null };
      }).filter((r) => me?.role === 'owner' || r.profile_id === me?.id);
      return this.out(rows.filter((r) => this.filters.every((f) => f(r))).sort((a, b) => a.name.localeCompare(b.name)));
    }
    const t = (db[this.table] ??= []);
    if (this.op === 'insert') {
      const rows = [this.payload].flat().map((r) => ({ id: uid(), created_at: now(), ...r }));
      t.push(...rows);
      return this.out(rows);
    }
    let rows = t.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'delete') {
      db[this.table] = t.filter((r) => !rows.includes(r));
      return ok();
    }
    if (this.op === 'update') {
      rows.forEach((r) => Object.assign(r, this.payload));
      return this.out(rows);
    }
    for (const [c, asc] of [...this.sorts].reverse())
      rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
    if (this.table === 'bills') rows = rows.map((b) => ({ ...b, payments: db.payments.filter((p) => p.bill_id === b.id) }));
    return this.out(rows);
  }
}

function normPhone(p?: string | null) {
  if (!p) return null;
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

/** Simplified version of price_bill() in 0004_returns_cash_coupons.sql. */
function price(items: any[], code: string | null, phone: string | null) {
  const s = db.app_settings[0];
  const c = code ? db.coupons.find((x) => x.code === code.toUpperCase()) : null;
  if (code && !c) throw new Error(`Coupon "${code}" not found.`);
  if (c) {
    if (!c.active) throw new Error(`Coupon "${c.code}" is switched off.`);
    if (c.expires_at && new Date(c.expires_at) < new Date()) throw new Error(`Coupon "${c.code}" has expired.`);
    if (c.usage_limit && c.used_count >= c.usage_limit) throw new Error(`Coupon "${c.code}" has been fully used.`);
    const cust = db.customers.find((x) => x.phone === normPhone(phone));
    if (c.customer_id && c.customer_id !== cust?.id) throw new Error(`Coupon "${c.code}" is for one customer only. Enter that customer's mobile number.`);
  }
  const lines = items.map((i) => {
    const p = db.products.find((x) => x.id === i.product_id)!;
    const eligible = !!c && (c.applies_to === 'all' || db.coupon_products.some((cp) => cp.coupon_id === c.id && cp.product_id === p.id));
    if (i.amount_paise != null) {
      if (p.unit !== 'kg') throw new Error(`"${p.name}" is sold per ${p.unit}, so enter how many, not an amount.`);
      const qty = Math.round((i.amount_paise / p.price_paise) * 1000) / 1000;
      return { p, qty, gross: i.amount_paise, eligible, discount: 0, tax: 0, line: 0 };
    }
    return { p, qty: i.qty, gross: Math.round(p.price_paise * i.qty), eligible, discount: 0, tax: 0, line: 0 };
  });
  const sub = lines.reduce((a, l) => a + l.gross, 0);
  const elig = lines.filter((l) => l.eligible).reduce((a, l) => a + l.gross, 0);
  let disc = 0;
  if (c) {
    if (!elig) throw new Error(`Coupon "${c.code}" does not apply to these products.`);
    if (sub < c.min_bill_paise) throw new Error(`Coupon "${c.code}" needs a bill of at least ₹${(c.min_bill_paise / 100).toFixed(2)}.`);
    disc = c.kind === 'percent' ? Math.round((elig * c.value) / 10000) : Math.min(c.value, elig);
  }
  let left = disc;
  const lastElig = lines.map((l) => l.eligible).lastIndexOf(true);
  lines.forEach((l, i) => {
    l.discount = l.eligible ? (i === lastElig ? left : Math.floor((l.gross * disc) / elig)) : 0;
    left -= l.discount;
    const net = l.gross - l.discount;
    const r = l.p.gst_rate_bp;
    l.tax = s.prices_include_gst ? Math.round((net * r) / (10000 + r)) : Math.round((net * r) / 10000);
    l.line = s.prices_include_gst ? net : net + l.tax;
  });
  const total = lines.reduce((a, l) => a + l.line, 0);
  return { lines, sub, disc, tax: lines.reduce((a, l) => a + l.tax, 0), total, coupon: c };
}

function wrap(fn: (a: any) => any) {
  return (a: any) => {
    try {
      return fn(a);
    } catch (e) {
      return fail((e as Error).message);
    }
  };
}

const wtx = (r: Row) => db.worker_transactions.push({ id: uid(), created_at: now(), mode: null, period_month: null, attendance_id: null, reverses_id: null, note: null, ...r });

const workforce: Record<string, (a: any) => any> = {
  mark_attendance: ({ p_date, p_entries }) => {
    for (const e of p_entries) {
      const w = db.workers.find((x) => x.id === e.worker_id)!;
      let a = db.attendance.find((x) => x.worker_id === w.id && x.att_date === p_date);
      if (a?.status === e.status) continue;
      if (a) a.status = e.status;
      else db.attendance.push((a = { id: uid(), worker_id: w.id, att_date: p_date, status: e.status }));
      const want = w.pay_type === 'daily' ? (e.status === 'present' ? w.rate_paise : e.status === 'half_day' ? Math.round(w.rate_paise / 2) : 0) : 0;
      const posted = db.worker_transactions.filter((t) => t.attendance_id === a!.id);
      const have = posted.reduce((s, t) => s + t.amount_paise, 0);
      if (have !== want) {
        if (have) wtx({ worker_id: w.id, txn_date: p_date, type: 'reversal', amount_paise: -have, attendance_id: a.id, reverses_id: posted.filter((t) => t.type === 'earned').pop()?.id, note: 'Attendance changed' });
        if (want) wtx({ worker_id: w.id, txn_date: p_date, type: 'earned', amount_paise: want, attendance_id: a.id, note: e.status === 'half_day' ? 'Half-day wage' : 'Day wage' });
      }
    }
    return ok(p_entries.length);
  },
  add_worker_txn: ({ p_worker_id, p_type, p_amount_paise, p_date, p_mode, p_note }) => {
    wtx({ worker_id: p_worker_id, txn_date: p_date ?? today(), type: p_type, amount_paise: p_type === 'bonus' ? p_amount_paise : -p_amount_paise, mode: p_mode, note: p_note });
    return ok(uid());
  },
  reverse_worker_txn: ({ p_txn_id, p_reason }) => {
    const t = db.worker_transactions.find((x) => x.id === p_txn_id)!;
    wtx({ worker_id: t.worker_id, txn_date: today(), type: 'reversal', amount_paise: -t.amount_paise, period_month: t.period_month, reverses_id: t.id, note: `Undo: ${p_reason}` });
    return ok();
  },
  close_month: ({ p_worker_id, p_month, p_salary_paise, p_deduction_paise, p_note }) => {
    wtx({ worker_id: p_worker_id, txn_date: today(), type: 'earned', amount_paise: p_salary_paise, period_month: p_month, note: 'Salary' });
    if (p_deduction_paise) wtx({ worker_id: p_worker_id, txn_date: today(), type: 'deduction', amount_paise: -p_deduction_paise, period_month: p_month, note: p_note ?? 'Leave deduction' });
    return ok();
  },
  worker_month: ({ p_worker_id, p_month }) => {
    const w = db.workers.find((x) => x.id === p_worker_id)!;
    const ym = p_month.slice(0, 7);
    const att = db.attendance.filter((a) => a.worker_id === w.id && a.att_date.startsWith(ym));
    const all = db.worker_transactions.filter((t) => t.worker_id === w.id);
    const tx = all.filter((t) => t.txn_date.startsWith(ym)).map((t) => ({
      amt: t.amount_paise, kind: t.type === 'reversal' ? all.find((o) => o.id === t.reverses_id)?.type : t.type,
    }));
    const sum = (k: string) => tx.filter((t) => t.kind === k).reduce((s, t) => s + t.amt, 0);
    const sal = all.find((t) => t.type === 'earned' && t.period_month === p_month && !all.some((r) => r.reverses_id === t.id));
    const n = (s: string) => att.filter((a) => a.status === s).length;
    return ok({
      month: p_month, pay_type: w.pay_type, rate_paise: w.rate_paise, present: n('present'), half_day: n('half_day'),
      absent: n('absent'), leave: n('leave'), earned_paise: sum('earned'), bonus_paise: sum('bonus'), paid_paise: -sum('payment'),
      advance_paise: -sum('advance'), deduction_paise: -sum('deduction'), closed: !!sal, salary_txn_id: sal?.id ?? null,
      balance_paise: all.reduce((s, t) => s + t.amount_paise, 0),
    });
  },
};

function netAdvance(orderId: string) {
  return db.order_payments.filter((p) => p.order_id === orderId).reduce((s, p) => s + (p.kind === 'advance' ? p.amount_paise : -p.amount_paise), 0);
}
function saveOrderMock({ p_order_id, p_customer_name, p_customer_phone, p_delivery_date, p_delivery_note, p_notes, p_items }: any) {
  const lines = p_items.map((i: any) => {
    const p = db.products.find((x) => x.id === i.product_id)!;
    const price = i.price_paise ?? p.price_paise;
    return { product_id: p.id, product_name: p.name, unit: p.unit, unit_price_paise: price, qty: i.qty, line_total_paise: Math.round(price * i.qty) };
  });
  const sub = lines.reduce((s: number, l: Row) => s + l.line_total_paise, 0);
  let o = db.orders.find((x) => x.id === p_order_id);
  if (o && netAdvance(o.id) > sub) throw new Error('The advance taken is more than the new order total. Refund the difference first.');
  const fields = { customer_name: p_customer_name, customer_phone: normPhone(p_customer_phone), delivery_date: p_delivery_date,
    delivery_note: p_delivery_note || null, notes: p_notes || null, subtotal_paise: sub };
  if (o) Object.assign(o, fields);
  else db.orders.push((o = { id: uid(), order_no: nextNo('OR', 4), status: 'pending', bill_id: null, cancel_reason: null, created_at: now(), ...fields }));
  db.order_items = db.order_items.filter((i) => i.order_id !== o!.id);
  lines.forEach((l: Row) => db.order_items.push({ id: uid(), order_id: o!.id, created_at: now(), ...l }));
  return { id: o.id, order_no: o.order_no, subtotal_paise: sub };
}
function orderPay(orderId: string, kind: string, amount: number, mode: string, note: string | null = null) {
  db.order_payments.push({ id: uid(), order_id: orderId, kind, mode, amount_paise: amount, business_date: today(), note, created_at: now(), created_by: me?.id ?? 'demo-owner' });
  const o = db.orders.find((x) => x.id === orderId)!;
  if (o.status === 'pending' && netAdvance(o.id) > 0) o.status = 'advance_paid';
  if (o.status === 'advance_paid' && netAdvance(o.id) === 0) o.status = 'pending';
}
// Two sample orders so the calendar is not empty.
{
  const a = saveOrderMock({ p_customer_name: 'Hotel Sai', p_customer_phone: '9811122233', p_delivery_date: today(), p_delivery_note: '7 am, back gate',
    p_items: [{ product_id: 'p0', qty: 10, price_paise: 5500 }, { product_id: 'p3', qty: 2 }] });
  orderPay(a.id, 'advance', 20000, 'cash', 'Advance');
  const d = new Date(); d.setDate(d.getDate() + 3);
  saveOrderMock({ p_customer_name: 'Green Grocers', p_customer_phone: null, p_delivery_date: d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    p_items: [{ product_id: 'p1', qty: 20, price_paise: 4500 }] });
}

const orders: Record<string, (a: any) => any> = {
  save_order: wrap((a) => ok(saveOrderMock(a))),
  add_order_payment: wrap(({ p_order_id, p_kind, p_amount_paise, p_mode, p_note }) => {
    const o = db.orders.find((x) => x.id === p_order_id)!;
    const net = netAdvance(o.id);
    if (p_kind === 'advance' && net + p_amount_paise > o.subtotal_paise) throw new Error('Advance cannot be more than the order total.');
    if (p_kind === 'refund' && p_amount_paise > net) throw new Error('Cannot refund more than the advance held.');
    orderPay(o.id, p_kind, p_amount_paise, p_mode, p_note);
    return ok();
  }),
  set_order_ready: ({ p_order_id, p_ready }) => {
    const o = db.orders.find((x) => x.id === p_order_id)!;
    o.status = p_ready ? 'ready' : netAdvance(o.id) > 0 ? 'advance_paid' : 'pending';
    return ok();
  },
  cancel_order: ({ p_order_id, p_reason, p_refund_mode }) => {
    const o = db.orders.find((x) => x.id === p_order_id)!;
    const net = netAdvance(o.id);
    if (net > 0 && p_refund_mode) orderPay(o.id, 'refund', net, p_refund_mode, 'Refund on cancel');
    Object.assign(o, { status: 'cancelled', cancel_reason: p_reason });
    return ok();
  },
  convert_order_to_bill: wrap(({ p_order_id, p_payments }) => {
    const o = db.orders.find((x) => x.id === p_order_id)!;
    if (o.status === 'delivered') throw new Error('This order is already billed.');
    const items = db.order_items.filter((i) => i.order_id === o.id);
    const total = items.reduce((s, i) => s + i.line_total_paise, 0);
    const adv = netAdvance(o.id);
    const paid = p_payments.reduce((s: number, p: Row) => s + p.amount_paise, 0);
    if (paid !== total - adv) throw new Error(`Balance to collect is ₹${((total - adv) / 100).toFixed(2)}, but payments add up to ₹${(paid / 100).toFixed(2)}.`);
    const id = uid();
    const bill = { id, bill_no: nextNo(db.app_settings[0].bill_prefix, 6), business_date: today(), created_at: now(), customer_name: o.customer_name,
      customer_phone: o.customer_phone, subtotal_paise: total, discount_paise: 0, tax_paise: 0, total_paise: total, status: 'active',
      coupon_id: null, order_id: o.id, created_by: me?.id,
      share_token: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('') };
    db.bills.push(bill);
    items.forEach((i) => db.bill_items.push({ id: uid(), bill_id: id, product_name: i.product_name, unit: i.unit, qty: i.qty,
      unit_price_paise: i.unit_price_paise, gst_rate_bp: 0, discount_paise: 0, tax_paise: 0, line_total_paise: i.line_total_paise }));
    if (adv) db.payments.push({ id: uid(), bill_id: id, mode: 'advance', amount_paise: adv });
    p_payments.forEach((p: Row) => db.payments.push({ id: uid(), bill_id: id, ...p }));
    Object.assign(o, { status: 'delivered', bill_id: id });
    return ok({ id, bill_no: bill.bill_no, share_token: bill.share_token, total_paise: total, advance_paise: adv });
  }),
};

// Two weeks of made-up past sales so the Reports chart has something to show.
{
  const dayStr = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); };
  for (let n = 14; n >= 1; n--) {
    const count = 3 + ((n * 7) % 6);
    for (let k = 0; k < count; k++) {
      const p = db.products[(n + k) % 4];
      const qty = p.unit === 'kg' ? 1 : 1 + ((n + k) % 3);
      const total = p.price_paise * qty;
      const id = uid();
      const day = dayStr(n);
      db.bills.push({ id, bill_no: nextNo('MF', 6), business_date: day, created_at: `${day}T0${(k % 9) + 1}:30:00.000Z`,
        customer_name: null, customer_phone: null, subtotal_paise: total, discount_paise: 0, tax_paise: 0, total_paise: total,
        status: 'active', coupon_id: null, order_id: null, created_by: 'demo-cashier', share_token: uid() });
      db.bill_items.push({ id: uid(), bill_id: id, product_name: p.name, unit: p.unit, qty, unit_price_paise: p.price_paise,
        gst_rate_bp: 0, discount_paise: 0, tax_paise: 0, line_total_paise: total });
      db.payments.push({ id: uid(), bill_id: id, mode: k % 3 === 0 ? 'upi' : 'cash', amount_paise: total, business_date: day });
    }
  }
}

function dashboardMock({ p_from, p_to }: any) {
  const inR = (d: string) => d >= p_from && d <= p_to;
  const bills = db.bills.filter((b) => inR(b.business_date) && b.status === 'active');
  const pays = db.payments.filter((p) => bills.some((b) => b.id === p.bill_id));
  const sum = (xs: Row[], k = 'amount_paise') => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
  const rets = sum(db.returns.filter((r) => inR(r.business_date)));
  const sales = sum(bills, 'total_paise');
  const cash = sum(pays.filter((p) => p.mode === 'cash'));
  const cashRef = sum(db.returns.filter((r) => inR(r.business_date) && r.refund_mode === 'cash'));
  const out = sum(db.cash_out.filter((c) => inR(c.business_date) && !c.voided));
  const adv = (m: string) => db.order_payments.filter((p) => inR(p.business_date) && p.mode === m)
    .reduce((s, p) => s + (p.kind === 'advance' ? p.amount_paise : -p.amount_paise), 0);
  const days: Row[] = [];
  for (let d = p_from; d <= p_to; ) {
    const bs = bills.filter((b) => b.business_date === d);
    days.push({ day: d, sales_paise: sum(bs, 'total_paise'), bills: bs.length });
    const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 1);
    d = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }
  const byProd: Record<string, Row> = {};
  for (const i of db.bill_items.filter((i) => bills.some((b) => b.id === i.bill_id))) {
    const r = (byProd[i.product_name] ??= { name: i.product_name, unit: i.unit, qty: 0, amount_paise: 0 });
    r.qty += i.qty; r.amount_paise += i.line_total_paise;
  }
  return ok({
    totals: {
      bills: bills.length, sales_paise: sales, net_sales_paise: sales - rets, discount_paise: sum(bills, 'discount_paise'),
      returns_paise: rets, cash_sales_paise: cash, upi_sales_paise: sum(pays.filter((p) => p.mode === 'upi')),
      advance_used_paise: sum(pays.filter((p) => p.mode === 'advance')), cash_out_paise: out,
      advance_cash_paise: adv('cash'), advance_upi_paise: adv('upi'), net_cash_paise: cash - cashRef - out + adv('cash'),
      worker_paid_paise: -sum(db.worker_transactions.filter((t) => inR(t.txn_date) && ['payment', 'advance'].includes(t.type))),
    },
    by_day: days,
    top_products: Object.values(byProd).sort((a, b) => b.amount_paise - a.amount_paise).slice(0, 10),
  });
}

const rpcs: Record<string, (a: any) => any> = {
  ...workforce,
  ...orders,
  dashboard: dashboardMock,
  set_my_lang: ({ p_lang }) => { if (me) me.lang = p_lang; return ok(); },
  preview_bill: wrap(({ p_items, p_coupon_code, p_customer_phone }) => {
    const r = price(p_items, p_coupon_code, p_customer_phone);
    return ok({ subtotal_paise: r.sub, discount_paise: r.disc, tax_paise: r.tax, total_paise: r.total, coupon_code: r.coupon?.code ?? null });
  }),
  create_bill: wrap(({ p_items, p_payments, p_customer_name, p_customer_phone, p_client_ref, p_coupon_code }) => {
    const dup = db.bills.find((b) => p_client_ref && b.client_ref === p_client_ref);
    if (dup) return ok({ id: dup.id, bill_no: dup.bill_no, share_token: dup.share_token, duplicate: true });
    const r = price(p_items, p_coupon_code, p_customer_phone);
    const paid = p_payments.reduce((x: number, p: any) => x + p.amount_paise, 0);
    if (paid !== r.total) throw new Error(`Payments (₹${(paid / 100).toFixed(2)}) do not match the bill total (₹${(r.total / 100).toFixed(2)}).`);
    const id = uid();
    const phone = normPhone(p_customer_phone);
    const bill = {
      id, bill_no: nextNo(db.app_settings[0].bill_prefix, 6), business_date: today(), created_at: now(),
      customer_name: p_customer_name, customer_phone: phone, subtotal_paise: r.sub, discount_paise: r.disc, tax_paise: r.tax,
      total_paise: r.total, status: 'active', void_reason: null, voided_at: null, coupon_id: r.coupon?.id ?? null,
      share_token: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
      client_ref: p_client_ref, created_by: me?.id,
    };
    db.bills.push(bill);
    r.lines.forEach((l) => db.bill_items.push({
      id: uid(), bill_id: id, product_name: l.p.name, unit: l.p.unit, qty: l.qty, unit_price_paise: l.p.price_paise,
      gst_rate_bp: l.p.gst_rate_bp, discount_paise: l.discount, tax_paise: l.tax, line_total_paise: l.line,
    }));
    p_payments.forEach((p: any) => db.payments.push({ id: uid(), bill_id: id, ...p }));
    if (r.coupon) r.coupon.used_count++;
    if (phone && !db.customers.some((c) => c.phone === phone)) db.customers.push({ id: uid(), name: p_customer_name, phone });
    return ok({ id, bill_no: bill.bill_no, share_token: bill.share_token, total_paise: r.total });
  }),
  void_bill: wrap(({ p_bill_id, p_reason }) => {
    const b = db.bills.find((x) => x.id === p_bill_id);
    if (!b || b.status === 'void') throw new Error('Bill not found or already void.');
    if (db.returns.some((x) => x.bill_id === b.id)) throw new Error('This bill has returns. It cannot be voided.');
    Object.assign(b, { status: 'void', void_reason: p_reason, voided_at: now() });
    return ok();
  }),
  find_bill_for_return: ({ p_bill_no }) => {
    const q = String(p_bill_no).trim().toUpperCase();
    const b = [...db.bills].reverse().find((x) => (/^\d+$/.test(q) ? x.bill_no.endsWith('/' + q.padStart(6, '0')) : x.bill_no === q));
    if (!b) return ok(null);
    return ok({
      ...b,
      items: db.bill_items.filter((i) => i.bill_id === b.id).map((i) => {
        const ri = db.return_items.filter((x) => x.bill_item_id === i.id);
        return { id: i.id, name: i.product_name, unit: i.unit, qty: i.qty, line_total_paise: i.line_total_paise,
          returned_qty: ri.reduce((a, x) => a + x.qty, 0), returned_paise: ri.reduce((a, x) => a + x.amount_paise, 0) };
      }),
      returns: db.returns.filter((r) => r.bill_id === b.id),
    });
  },
  create_return: wrap(({ p_bill_id, p_items, p_refund_mode, p_reason, p_client_ref }) => {
    const dup = db.returns.find((r) => p_client_ref && r.client_ref === p_client_ref);
    if (dup) return ok({ ...dup, duplicate: true });
    let sum = 0;
    const rows = p_items.map((x: any) => {
      const bi = db.bill_items.find((i) => i.id === x.bill_item_id)!;
      const prev = db.return_items.filter((r) => r.bill_item_id === bi.id);
      const left = Math.round((bi.qty - prev.reduce((a, r) => a + r.qty, 0)) * 1000) / 1000;
      if (x.qty > left) throw new Error(`Only ${left} of "${bi.product_name}" can still be returned.`);
      const amt = x.qty === left ? bi.line_total_paise - prev.reduce((a, r) => a + r.amount_paise, 0) : Math.round((bi.line_total_paise * x.qty) / bi.qty);
      sum += amt;
      return { bill_item_id: bi.id, qty: x.qty, amount_paise: amt };
    });
    const id = uid();
    const r = { id, return_no: nextNo('RT', 4), bill_id: p_bill_id, business_date: today(), created_at: now(),
      amount_paise: sum, refund_mode: p_refund_mode, reason: p_reason, client_ref: p_client_ref, created_by: me?.id };
    db.returns.push(r);
    rows.forEach((x: Row) => db.return_items.push({ id: uid(), return_id: id, ...x }));
    return ok({ id, return_no: r.return_no, amount_paise: sum });
  }),
  record_cash_out: wrap(({ p_amount_paise, p_reason, p_taken_by }) => {
    const id = uid();
    db.cash_out.push({ id, business_date: today(), created_at: now(), amount_paise: p_amount_paise, reason: p_reason,
      taken_by: p_taken_by, voided: false, void_reason: null, created_by: me?.id });
    return ok(id);
  }),
  void_cash_out: ({ p_id, p_reason }) => {
    const c = db.cash_out.find((x) => x.id === p_id);
    if (c) Object.assign(c, { voided: true, void_reason: p_reason });
    return ok();
  },
  cash_summary: ({ p_date }) => {
    const d = me?.role === 'owner' ? p_date ?? today() : today();
    const mine = (r: Row) => me?.role === 'owner' || r.created_by === me?.id;
    const bills = db.bills.filter((b) => b.business_date === d && b.status === 'active' && mine(b));
    const pays = db.payments.filter((p) => bills.some((b) => b.id === p.bill_id));
    const rets = db.returns.filter((r) => r.business_date === d && mine(r));
    const outs = db.cash_out.filter((c) => c.business_date === d && !c.voided && mine(c));
    const sum = (xs: Row[], k = 'amount_paise') => xs.reduce((a, x) => a + x[k], 0);
    const cashSales = sum(pays.filter((p) => p.mode === 'cash'));
    const cashRef = sum(rets.filter((r) => r.refund_mode === 'cash'));
    const out = sum(outs);
    const adv = (mode: string) => db.order_payments.filter((p) => p.business_date === d && p.mode === mode && mine(p))
      .reduce((s, p) => s + (p.kind === 'advance' ? p.amount_paise : -p.amount_paise), 0);
    return ok({
      advance_cash_paise: adv('cash'), advance_upi_paise: adv('upi'),
      date: d, bills: bills.length, sales_paise: sum(bills, 'total_paise'), discount_paise: sum(bills, 'discount_paise'),
      cash_sales_paise: cashSales, upi_sales_paise: sum(pays.filter((p) => p.mode === 'upi')),
      cash_refunds_paise: cashRef, upi_refunds_paise: sum(rets.filter((r) => r.refund_mode === 'upi')),
      cash_out_paise: out, net_cash_paise: cashSales - cashRef - out + adv('cash'),
    });
  },
  get_public_bill: ({ p_token }) => {
    const b = db.bills.find((x) => x.share_token === p_token);
    if (!b) return ok(null);
    const s = db.app_settings[0];
    return ok({
      ...b,
      coupon_code: db.coupons.find((c) => c.id === b.coupon_id)?.code ?? null,
      items: db.bill_items.filter((i) => i.bill_id === b.id).map((i) => ({
        name: i.product_name, unit: i.unit, qty: i.qty, price_paise: i.unit_price_paise,
        gst_rate_bp: i.gst_rate_bp, tax_paise: i.tax_paise, line_total_paise: i.line_total_paise,
      })),
      payments: db.payments.filter((p) => p.bill_id === b.id).map(({ mode, amount_paise }) => ({ mode, amount_paise })),
      returns: db.returns.filter((r) => r.bill_id === b.id),
      farm: { name: s.farm_name, address: s.address, phone: s.phone, gstin: s.gstin, prices_include_gst: s.prices_include_gst, footer: s.bill_footer },
    });
  },
};

export function createMockClient(): any {
  return {
    from: (t: string) => new Query(t),
    rpc: async (name: string, args: any) => rpcs[name]?.(args) ?? fail(`Demo: ${name} not available`),
    functions: {
      invoke: async (_name: string, { body }: any) => {
        if (body.action === 'create')
          db.profiles.push({ id: uid(), phone: body.phone, full_name: body.full_name, role: body.role, active: true, lang: 'en', created_at: now() });
        return ok({ ok: true });
      },
    },
    auth: {
      getSession: async () => ({ data: { session: session() } }),
      onAuthStateChange: (cb: any) => {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe: () => listeners.splice(listeners.indexOf(cb), 1) } } };
      },
      signInWithPassword: async ({ email }: { email: string }) => {
        me = email.startsWith(CASHIER.phone) ? CASHIER : email.startsWith(WORKER.phone) ? WORKER : OWNER;
        listeners.forEach((l) => l('SIGNED_IN', session()));
        return { error: null };
      },
      signOut: async () => {
        me = null;
        listeners.forEach((l) => l('SIGNED_OUT', null));
        return { error: null };
      },
      updateUser: async () => ({ error: null }),
    },
  };
}
