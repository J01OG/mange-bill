// Runs every migration in an in-memory Postgres (PGlite) that imitates Supabase's
// auth schema and roles, then checks the security rules. Usage: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../supabase/', import.meta.url);
const db = new PGlite();

// --- Imitate the parts of Supabase the migrations rely on --------------------
// Older Supabase projects automatically grant new tables/functions to the app's roles.
// Newer projects do NOT. By default we test the newer (stricter) behaviour;
// set SUPABASE_STYLE=old to test the older one. Both must pass.
const OLD_STYLE = process.env.SUPABASE_STYLE === 'old';
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated;
`);
if (OLD_STYLE) {
  await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
}
console.log(`Supabase style: ${OLD_STYLE ? 'old (automatic grants)' : 'new (no automatic grants)'}`);

const migrations = readdirSync(new URL('migrations/', root)).filter((f) => f.endsWith('.sql')).sort();
for (const f of migrations) {
  await db.exec(readFileSync(new URL(`migrations/${f}`, root), 'utf8'));
  console.log(`applied ${f}`);
}
await db.exec(readFileSync(new URL('seed.sql', root), 'utf8'));
console.log('applied seed.sql\n');

// --- Test users ------------------------------------------------------------
const U = {
  owner: '00000000-0000-0000-0000-000000000001',
  cashier: '00000000-0000-0000-0000-000000000002',
  worker: '00000000-0000-0000-0000-000000000003',
  customer: '00000000-0000-0000-0000-000000000004',
  disabled: '00000000-0000-0000-0000-000000000005',
};
const phones = { owner: '919811111111', cashier: '919822222222', worker: '919800000001', customer: '919844444444', disabled: '919855555555' };
for (const [k, id] of Object.entries(U)) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${phones[k]}@farm.local`]);
}
const ownerMsg = await db.query(`select bootstrap_owner('9811111111', 'Test Owner') as m`);
for (const k of ['cashier', 'worker', 'customer', 'disabled']) {
  await db.query(`insert into profiles (id, phone, full_name, role, active) values ($1, $2, $3, $4, $5)`,
    [U[k], phones[k], k, k === 'disabled' ? 'cashier' : k, k !== 'disabled']);
}
await db.query(`update workers set profile_id = $1 where phone = $2`, [U.worker, phones.worker]);
const cust = await db.query(`insert into customers (name, phone, profile_id) values ('Cust', $1, $2) returning id`, [phones.customer, U.customer]);
const custId = cust.rows[0].id;
const prod = (await db.query(`select id from products limit 1`)).rows[0].id;

// Bills: one by cashier today, one by cashier yesterday, one for the customer.
async function bill(by, date, customerId = null) {
  const no = (await db.query(`select next_doc_no('MF', $1::date, 6) as n`, [date])).rows[0].n;
  const b = await db.query(
    `insert into bills (bill_no, business_date, subtotal_paise, total_paise, created_by, customer_id)
     values ($1, $2, 6000, 6000, $3, $4) returning id`, [no, date, by, customerId]);
  const id = b.rows[0].id;
  await db.query(`insert into bill_items (bill_id, product_id, product_name, unit, unit_price_paise, qty, line_total_paise)
                  values ($1, $2, 'Oyster', 'packet', 6000, 1, 6000)`, [id, prod]);
  await db.query(`insert into payments (bill_id, mode, amount_paise, business_date) values ($1, 'cash', 6000, $2)`, [id, date]);
  return { id, no };
}
const today = (await db.query(`select ist_today()::text as d`)).rows[0].d;
const yesterday = (await db.query(`select (ist_today() - 1)::text as d`)).rows[0].d;
const b1 = await bill(U.cashier, today);
await bill(U.cashier, yesterday);
await bill(U.owner, today, custId);

const w = (await db.query(`select id from workers where phone = $1`, [phones.worker])).rows[0].id;
const w2 = (await db.query(`select id from workers where phone = '919800000002'`)).rows[0].id;
await db.query(`insert into worker_transactions (worker_id, type, amount_paise) values ($1, 'earned', 50000), ($2, 'earned', 45000)`, [w, w2]);

// --- Helpers --------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
async function as(user, sql, params = []) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [user ? U[user] : '']);
  await db.exec(user ? 'set role authenticated' : 'set role anon');
  try { return { rows: (await db.query(sql, params)).rows }; }
  catch (e) { return { error: e.message }; }
  finally { await db.exec('reset role'); }
}
async function count(user, table) {
  const r = await as(user, `select count(*)::int as n from ${table}`);
  return r.error ? `error: ${r.error}` : r.rows[0].n;
}

// --- Checks -------------------------------------------------------------------
console.log('Numbering and dates');
check('bootstrap_owner works', ownerMsg.rows[0].m.startsWith('Owner created'));
check('fy_label(2025-11-21) = 25-26', (await db.query(`select fy_label('2025-11-21') as x`)).rows[0].x === '25-26');
check('fy_label(2026-03-31) = 25-26', (await db.query(`select fy_label('2026-03-31') as x`)).rows[0].x === '25-26');
check('fy_label(2026-04-01) = 26-27', (await db.query(`select fy_label('2026-04-01') as x`)).rows[0].x === '26-27');
check('bill numbers are sequential', /^MF\/\d\d-\d\d\/00000[1-3]$/.test(b1.no), b1.no);
check('second owner is refused',
  await db.query(`select bootstrap_owner('9822222222','x')`).then(() => false, () => true));

console.log('Anonymous (public key, not logged in)');
check('anon cannot read products', String(await count(null, 'products')).startsWith('error'));
check('anon cannot read bills', String(await count(null, 'bills')).startsWith('error'));
check('anon cannot call bootstrap_owner', !!(await as(null, `select bootstrap_owner('9822222222','x')`)).error);

console.log('Owner');
check('owner sees all profiles (5)', (await count('owner', 'profiles')) === 5);
check('owner sees all bills (3)', (await count('owner', 'bills')) === 3);
check('owner sees all worker ledgers (2)', (await count('owner', 'worker_transactions')) === 2);
check('owner can add a product', !(await as('owner', `insert into products (name, price_paise) values ('Test', 100)`)).error);
check('owner can edit settings', !(await as('owner', `update app_settings set farm_name = 'X'`)).error);

console.log('Cashier');
check('cashier sees only own profile', (await count('cashier', 'profiles')) === 1);
check('cashier sees products', (await count('cashier', 'products')) > 0);
check('cashier sees only own bills from today (1)', (await count('cashier', 'bills')) === 1);
check('cashier sees items only of visible bills (1)', (await count('cashier', 'bill_items')) === 1);
check('cashier sees no workers', (await count('cashier', 'workers')) === 0);
check('cashier sees no worker ledger', (await count('cashier', 'worker_transactions')) === 0);
check('cashier sees no audit log', (await count('cashier', 'audit_log')) === 0);
check('cashier cannot insert bills directly',
  !!(await as('cashier', `insert into bills (bill_no, subtotal_paise, total_paise) values ('HACK', 1, 1)`)).error);
check('cashier cannot add products',
  !!(await as('cashier', `insert into products (name, price_paise) values ('Hack', 1)`)).error);
const upd = await as('cashier', `update products set price_paise = 1 returning id`);
check('cashier cannot change prices', !!upd.error || upd.rows.length === 0);
check('cashier cannot call next_doc_no', !!(await as('cashier', `select next_doc_no('MF', current_date, 6)`)).error);

console.log('Worker');
check('worker sees only own worker row', (await count('worker', 'workers')) === 1);
check('worker sees only own ledger (1)', (await count('worker', 'worker_transactions')) === 1);
check('worker sees no bills', (await count('worker', 'bills')) === 0);
check('worker sees no products', (await count('worker', 'products')) === 0);
check('worker cannot add ledger rows',
  !!(await as('worker', `insert into worker_transactions (worker_id, type, amount_paise) values ('${w}', 'bonus', 99999)`)).error);

console.log('Customer');
check('customer sees only own bill (1)', (await count('customer', 'bills')) === 1);
check('customer sees no products', (await count('customer', 'products')) === 0);

console.log('Disabled user');
check('disabled user sees no bills', (await count('disabled', 'bills')) === 0);
check('disabled user sees no products', (await count('disabled', 'products')) === 0);

console.log('Data safety (even as database admin)');
const del = await db.query(`delete from bills where id = $1`, [b1.id]).then(() => null, (e) => e.message);
check('bills cannot be deleted', !!del, del);
check('payments cannot be edited', await db.query(`update payments set amount_paise = 1`).then(() => false, () => true));
check('ledger cannot be edited', await db.query(`update worker_transactions set amount_paise = 1`).then(() => false, () => true));
check('bill totals cannot be edited', await db.query(`update bills set total_paise = 1 where id = $1`, [b1.id]).then(() => false, () => true));
check('bill can be voided', await db.query(
  `update bills set status = 'void', void_reason = 'test', voided_at = now() where id = $1`, [b1.id]).then(() => true, () => false));
check('void bill cannot be re-voided', await db.query(
  `update bills set void_reason = 'again' where id = $1`, [b1.id]).then(() => false, () => true));
check('void was written to audit log',
  (await db.query(`select count(*)::int as n from audit_log where table_name = 'bills' and row_id = $1`, [b1.id])).rows[0].n === 1);
check('wrong-sign ledger row rejected', await db.query(
  `insert into worker_transactions (worker_id, type, amount_paise) values ($1, 'payment', 500)`, [w]).then(() => false, () => true));

// --- Phase 2: billing ---------------------------------------------------------
console.log('Billing (create_bill)');
const pid = async (name) => (await db.query(`select id from products where name = $1`, [name])).rows[0].id;
const packet = await pid('Oyster mushroom 200 g');   // ₹60 / packet
const loose = await pid('Oyster mushroom (loose)');  // ₹240 / kg
async function createBill(user, items, payments, name = null, phone = null, ref = null) {
  const r = await as(user, `select create_bill($1::jsonb, $2::jsonb, $3, $4, $5::uuid) as r`,
    [JSON.stringify(items), JSON.stringify(payments), name, phone, ref]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
const cash = (n) => [{ mode: 'cash', amount_paise: n }];

const okBill = await createBill('cashier', [{ product_id: packet, qty: 2 }, { product_id: loose, qty: 0.5 }], cash(24000));
check('cashier creates a bill: 2 × ₹60 + 0.5 kg × ₹240 = ₹240', okBill.total_paise === 24000, JSON.stringify(okBill));
check('bill number has prefix and FY', /^MF\/\d\d-\d\d\/\d{6}$/.test(okBill.bill_no ?? ''), okBill.bill_no);
check('items and payment saved',
  (await db.query(`select count(*)::int n from bill_items where bill_id = $1`, [okBill.id])).rows[0].n === 2 &&
  (await db.query(`select count(*)::int n from payments where bill_id = $1`, [okBill.id])).rows[0].n === 1);
check('cashier sees the new bill', (await as('cashier', `select id from bills where id = $1`, [okBill.id])).rows?.length === 1);

const wrongPay = await createBill('cashier', [{ product_id: packet, qty: 1 }], cash(5000));
check('payment not matching total is refused', /do not match/.test(wrongPay.error ?? ''), wrongPay.error);
await db.query(`update app_settings set allow_bargain = false`);
const fakePrice = await createBill('cashier', [{ product_id: packet, qty: 1, price_paise: 1 }], cash(1));
check('bargain off: price sent by phone is refused', /switched off/.test(fakePrice.error ?? ''), fakePrice.error);
check('owner may still bargain when cashiers cannot', !(await createBill('owner', [{ product_id: packet, qty: 1, price_paise: 5500 }], cash(5500))).error);
await db.query(`update app_settings set allow_bargain = true`);
check('worker cannot create bills', !!(await createBill('worker', [{ product_id: packet, qty: 1 }], cash(6000))).error);
check('anon cannot create bills', !!(await createBill(null, [{ product_id: packet, qty: 1 }], cash(6000))).error);
check('half a packet is refused', /whole number/.test((await createBill('cashier', [{ product_id: packet, qty: 0.5 }], cash(3000))).error ?? ''));
check('empty bill is refused', !!(await createBill('cashier', [], [])).error);
check('cheque/other mode is refused', !!(await createBill('cashier', [{ product_id: packet, qty: 1 }], [{ mode: 'advance', amount_paise: 6000 }])).error);

const split = await createBill('cashier', [{ product_id: packet, qty: 3 }],
  [{ mode: 'cash', amount_paise: 10000 }, { mode: 'upi', amount_paise: 8000 }], 'Asha', '98765 43210');
check('split cash + UPI bill works', split.total_paise === 18000, JSON.stringify(split));
const custRow = (await db.query(`select c.name, c.phone from bills b join customers c on c.id = b.customer_id where b.id = $1`, [split.id])).rows[0];
check('customer saved from mobile number', custRow?.phone === '919876543210' && custRow?.name === 'Asha');
check('bad customer mobile refused',
  /not valid/.test((await createBill('cashier', [{ product_id: packet, qty: 1 }], cash(6000), null, '12345')).error ?? ''));

const ref = '11111111-2222-3333-4444-555555555555';
const first = await createBill('cashier', [{ product_id: packet, qty: 1 }], cash(6000), null, null, ref);
const again = await createBill('cashier', [{ product_id: packet, qty: 1 }], cash(6000), null, null, ref);
check('double-tap does not create two bills', first.id === again.id && again.duplicate === true);

await db.query(`update products set archived_at = now() where name = 'Shiitake 100 g'`);
check('archived product cannot be billed',
  /no longer sold/.test((await createBill('cashier', [{ product_id: await pid('Shiitake 100 g'), qty: 1 }], cash(15000))).error ?? ''));

await db.query(`update products set gst_rate_bp = 500, price_paise = 10500 where name = 'Dried oyster 50 g'`);
const gst = await createBill('owner', [{ product_id: await pid('Dried oyster 50 g'), qty: 1 }], cash(10500));
const gstRow = (await db.query(`select tax_paise, total_paise from bills where id = $1`, [gst.id])).rows[0];
check('GST 5% inside ₹105 price = ₹5 tax, total ₹105', gstRow.tax_paise == 500 && gstRow.total_paise == 10500, JSON.stringify(gstRow));
await db.query(`update app_settings set prices_include_gst = false`);
const gstEx = await createBill('owner', [{ product_id: await pid('Dried oyster 50 g'), qty: 1 }], cash(11025));
check('GST added on top when prices exclude GST (₹105 + ₹5.25)', gstEx.total_paise === 11025, JSON.stringify(gstEx));
await db.query(`update app_settings set prices_include_gst = true`);

console.log('Share link and void');
const pub = await as(null, `select get_public_bill($1) as r`, [split.share_token]);
check('share link works without login', pub.rows?.[0].r?.total_paise === 18000 && pub.rows[0].r.items.length === 1, pub.error);
check('share link hides customer phone', !JSON.stringify(pub.rows?.[0].r ?? {}).includes('9876543210'));
check('wrong token returns nothing', (await as(null, `select get_public_bill('0123456789abcdef0123456789abcdef') as r`)).rows?.[0].r === null);
check('cashier cannot void', !!(await as('cashier', `select void_bill($1, 'mistake')`, [okBill.id])).error);
check('void needs a reason', !!(await as('owner', `select void_bill($1, '')`, [okBill.id])).error);
check('owner can void', !(await as('owner', `select void_bill($1, 'Wrong items')`, [okBill.id])).error);
check('voided bill shows VOID on share link',
  (await as(null, `select get_public_bill($1) as r`, [okBill.share_token])).rows?.[0].r?.status === 'void');

// --- Phase 3: coupons, returns, cash out ---------------------------------------------
console.log('Coupons');
async function bill6(user, items, payments, { name = null, phone = null, coupon = null } = {}) {
  const r = await as(user, `select create_bill($1::jsonb, $2::jsonb, $3, $4, null, $5) as r`,
    [JSON.stringify(items), JSON.stringify(payments), name, phone, coupon]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
async function preview(user, items, coupon, phone = null) {
  const r = await as(user, `select preview_bill($1::jsonb, $2, $3) as r`, [JSON.stringify(items), coupon, phone]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
const two = [{ product_id: packet, qty: 2 }]; // ₹120
const pv = await preview('cashier', two, 'welcome10');
check('preview: 10% off ₹120 = ₹12 off, total ₹108', pv.discount_paise === 1200 && pv.total_paise === 10800, JSON.stringify(pv));
const cb = await bill6('cashier', two, cash(10800), { coupon: 'WELCOME10' });
check('bill with 10% coupon saved at ₹108', cb.total_paise === 10800, JSON.stringify(cb));
check('coupon use counted', (await db.query(`select used_count from coupons where code = 'WELCOME10'`)).rows[0].used_count === 1);
const lines = (await db.query(`select discount_paise, line_total_paise from bill_items where bill_id = $1`, [cb.id])).rows[0];
check('discount stored on the item line', lines.discount_paise == 1200 && lines.line_total_paise == 10800);
check('flat ₹20 on a ₹60 bill = ₹40', (await preview('cashier', [{ product_id: packet, qty: 1 }], 'FLAT20')).total_paise === 4000);
check('unknown coupon refused', /not found/.test((await preview('cashier', two, 'NOPE')).error ?? ''));
check('worker cannot preview', !!(await preview('worker', two, null)).error);

await db.query(`insert into coupons (code, kind, value, expires_at) values ('OLD5', 'percent', 500, now() - interval '1 day')`);
check('expired coupon refused', /expired/.test((await preview('cashier', two, 'OLD5')).error ?? ''));
await db.query(`insert into coupons (code, kind, value, usage_limit) values ('ONCE', 'flat', 1000, 1)`);
check('limited coupon works the first time', !(await bill6('cashier', two, cash(11000), { coupon: 'ONCE' })).error);
check('limited coupon refused the second time', /fully used/.test((await preview('cashier', two, 'ONCE')).error ?? ''));
await db.query(`insert into coupons (code, kind, value, min_bill_paise) values ('BIG', 'flat', 1000, 50000)`);
check('minimum bill amount enforced', /at least/.test((await preview('cashier', two, 'BIG')).error ?? ''));

const sel = (await db.query(`insert into coupons (code, kind, value, applies_to) values ('BUTTON50', 'percent', 5000, 'selected') returning id`)).rows[0].id;
const button = await pid('Button mushroom 200 g'); // ₹50
await db.query(`insert into coupon_products values ($1, $2)`, [sel, button]);
const mixed = await preview('cashier', [{ product_id: packet, qty: 1 }, { product_id: button, qty: 2 }], 'BUTTON50');
check('selected-product coupon discounts only those products (50% of ₹100)', mixed.discount_paise === 5000 && mixed.total_paise === 11000, JSON.stringify(mixed));
check('selected-product coupon refused when none of them bought', /does not apply/.test((await preview('cashier', two, 'BUTTON50')).error ?? ''));

await db.query(`insert into coupons (code, kind, value, customer_id) values ('ASHA', 'flat', 1500, (select id from customers where phone = '919876543210'))`);
check('personal coupon needs the customer mobile', /one customer only/.test((await preview('cashier', two, 'ASHA')).error ?? ''));
check('personal coupon refused for another mobile', !!(await preview('cashier', two, 'ASHA', '9123456789')).error);
check('personal coupon works with the right mobile', (await preview('cashier', two, 'ASHA', '9876543210')).discount_paise === 1500);

const wb = await bill6('owner', two, cash(10800), { coupon: 'WELCOME10' });
await as('owner', `select void_bill($1, 'test void')`, [wb.id]);
check('voiding a bill gives the coupon use back', (await db.query(`select used_count from coupons where code = 'WELCOME10'`)).rows[0].used_count === 1);

console.log('Returns');
async function ret(user, billId, items, mode = 'cash', ref = null) {
  const r = await as(user, `select create_return($1, $2::jsonb, $3, 'test', $4::uuid) as r`, [billId, JSON.stringify(items), mode, ref]);
  return r.error ? { error: r.error } : r.rows[0].r;
}
const rb = await bill6('cashier', [{ product_id: packet, qty: 3 }], cash(18000));
const rbItem = (await db.query(`select id from bill_items where bill_id = $1`, [rb.id])).rows[0].id;
const found = await as('cashier', `select find_bill_for_return($1) as r`, [rb.bill_no.split('/')[2].replace(/^0+/, '')]);
check('find bill by its short number', found.rows?.[0].r?.id === rb.id, found.error);
const r1 = await ret('cashier', rb.id, [{ bill_item_id: rbItem, qty: 1 }]);
check('return 1 of 3 packets refunds ₹60', r1.amount_paise === 6000 && /^RT\//.test(r1.return_no), JSON.stringify(r1));
check('cannot return more than was sold', /can still be returned/.test((await ret('cashier', rb.id, [{ bill_item_id: rbItem, qty: 3 }])).error ?? ''));
const r2 = await ret('cashier', rb.id, [{ bill_item_id: rbItem, qty: 2 }], 'upi');
check('return the rest: total refunded equals what was paid', r1.amount_paise + r2.amount_paise === 18000);
check('nothing left to return', !!(await ret('cashier', rb.id, [{ bill_item_id: rbItem, qty: 1 }])).error);
check('bill with returns cannot be voided', !!(await as('owner', `select void_bill($1, 'try')`, [rb.id])).error);

const cbItem = (await db.query(`select id from bill_items where bill_id = $1`, [cb.id])).rows[0].id;
check('return on a discounted bill refunds the discounted price (₹54)',
  (await ret('owner', cb.id, [{ bill_item_id: cbItem, qty: 1 }])).amount_paise === 5400);
check('worker cannot record returns', !!(await ret('worker', cb.id, [{ bill_item_id: cbItem, qty: 1 }])).error);
const vItem = (await db.query(`select id from bill_items where bill_id = $1`, [wb.id])).rows[0].id;
check('cannot return from a void bill', /void/.test((await ret('owner', wb.id, [{ bill_item_id: vItem, qty: 1 }])).error ?? ''));
const rref = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const lb = await bill6('cashier', [{ product_id: loose, qty: 1.5 }], cash(36000));
const lbItem = (await db.query(`select id from bill_items where bill_id = $1`, [lb.id])).rows[0].id;
const ra = await ret('cashier', lb.id, [{ bill_item_id: lbItem, qty: 0.25 }], 'cash', rref);
const rb2 = await ret('cashier', lb.id, [{ bill_item_id: lbItem, qty: 0.25 }], 'cash', rref);
check('return of 250 g = ₹60, and double-tap makes only one return', ra.amount_paise === 6000 && ra.id === rb2.id);
const rbToken = (await db.query(`select share_token from bills where id = $1`, [rb.id])).rows[0].share_token;
const shared = await as(null, `select get_public_bill($1) as r`, [rbToken]);
check('share link lists the returns', shared.rows?.[0].r?.returns?.length === 2);

console.log('Cash out and cash summary');
const summary = async (user, d = null) => (await as(user, `select cash_summary($1::date) as r`, [d])).rows?.[0].r;
const before = await summary('cashier');
const co = await as('cashier', `select record_cash_out(50000, 'Diesel for pump', 'Ramesh') as id`);
check('cashier records cash out', !co.error, co.error);
const after = await summary('cashier');
check('cash out lowers cash in hand by ₹500', before.net_cash_paise - after.net_cash_paise === 50000, JSON.stringify(after));
check('net cash = cash sales − cash refunds − cash out',
  after.net_cash_paise === after.cash_sales_paise - after.cash_refunds_paise - after.cash_out_paise);
const own = await summary('owner');
check('cashier summary excludes the owner\'s bills', own.sales_paise > after.sales_paise);
check('cashier cannot see another day', (await summary('cashier', yesterday)).date === today);
check('cash out needs a reason', !!(await as('cashier', `select record_cash_out(100, '', 'x')`)).error);
check('cashier cannot cancel cash out', !!(await as('cashier', `select void_cash_out($1, 'oops')`, [co.rows[0].id])).error);
check('owner can cancel cash out', !(await as('owner', `select void_cash_out($1, 'Entered twice')`, [co.rows[0].id])).error);
check('cancelled cash out no longer counted', (await summary('cashier')).net_cash_paise === before.net_cash_paise);
check('cash summary refused for worker', !!(await as('worker', `select cash_summary()`)).error);

// --- Phase 4: workforce ------------------------------------------------------------
console.log('Attendance and day wages');
const dw = (await db.query(`insert into workers (name, pay_type, rate_paise) values ('Test Daily', 'daily', 50000) returning id`)).rows[0].id;
const mw = (await db.query(`insert into workers (name, pay_type, rate_paise) values ('Test Monthly', 'monthly', 1500000) returning id`)).rows[0].id;
const bal = async (id) => Number((await db.query(`select coalesce(sum(amount_paise),0) b from worker_transactions where worker_id = $1`, [id])).rows[0].b);
const rowsFor = async (id) => (await db.query(`select count(*)::int n from worker_transactions where worker_id = $1`, [id])).rows[0].n;
const mark = (user, date, entries) => as(user, `select mark_attendance($1::date, $2::jsonb) as n`, [date, JSON.stringify(entries)]);

await mark('owner', today, [{ worker_id: dw, status: 'present' }, { worker_id: mw, status: 'present' }]);
check('present day adds ₹500 day wage', (await bal(dw)) === 50000);
check('monthly worker gets no day wage', (await bal(mw)) === 0);
await mark('owner', today, [{ worker_id: dw, status: 'half_day' }]);
check('changing to half day → balance ₹250 (old wage reversed)', (await bal(dw)) === 25000);
await mark('owner', today, [{ worker_id: dw, status: 'absent' }]);
check('changing to absent → balance ₹0', (await bal(dw)) === 0);
const n1 = await rowsFor(dw);
await mark('owner', today, [{ worker_id: dw, status: 'absent' }]);
check('saving the same mark again adds nothing', (await rowsFor(dw)) === n1);
await mark('owner', yesterday, [{ worker_id: dw, status: 'present' }]);
await mark('owner', today, [{ worker_id: dw, status: 'present' }]);
check('two present days = ₹1,000', (await bal(dw)) === 100000);
const tomorrow = (await db.query(`select (ist_today() + 1)::text d`)).rows[0].d;
check('future date refused', !!(await mark('owner', tomorrow, [{ worker_id: dw, status: 'present' }])).error);
check('cashier cannot mark attendance', !!(await mark('cashier', today, [{ worker_id: dw, status: 'present' }])).error);
check('owner cannot write attendance directly (only via the function)',
  !!(await as('owner', `insert into attendance (worker_id, att_date, status) values ($1, '2020-01-01', 'present')`, [dw])).error);
check('owner cannot write ledger rows directly',
  !!(await as('owner', `insert into worker_transactions (worker_id, type, amount_paise) values ($1, 'bonus', 100)`, [dw])).error);

console.log('Payments, advances, bonus, deduction, undo');
const txn = (user, worker, type, amt, mode = 'cash', date = null) =>
  as(user, `select add_worker_txn($1, $2, $3, $4::date, $5, 'test') as id`, [worker, type, amt, date, mode]);
const pay = await txn('owner', dw, 'payment', 30000);
check('payment ₹300 → balance ₹700', !pay.error && (await bal(dw)) === 70000, pay.error);
await txn('owner', dw, 'bonus', 10000, null);
check('bonus ₹100 → balance ₹800', (await bal(dw)) === 80000);
await txn('owner', dw, 'advance', 100000);
check('advance ₹1,000 → balance −₹200 (worker owes)', (await bal(dw)) === -20000);
await txn('owner', dw, 'deduction', 5000, null);
check('deduction ₹50 → balance −₹250', (await bal(dw)) === -25000);
check('payment needs cash or UPI', !!(await txn('owner', dw, 'payment', 100, null)).error);
check('negative amount refused', !!(await txn('owner', dw, 'payment', -100)).error);
check('worker cannot add entries', !!(await txn('worker', w, 'bonus', 100000, null)).error);
check('cashier cannot add entries', !!(await txn('cashier', dw, 'payment', 100)).error);
const undo = await as('owner', `select reverse_worker_txn($1, 'paid twice')`, [pay.rows[0].id]);
check('undo the ₹300 payment → balance +₹50', !undo.error && (await bal(dw)) === 5000, undo.error);
check('cannot undo twice', !!(await as('owner', `select reverse_worker_txn($1, 'again')`, [pay.rows[0].id])).error);
const wageRow = (await db.query(`select id from worker_transactions where worker_id = $1 and attendance_id is not null limit 1`, [dw])).rows[0].id;
check('day wage cannot be undone directly (change attendance instead)',
  /attendance/.test((await as('owner', `select reverse_worker_txn($1, 'nope')`, [wageRow])).error ?? ''));

console.log('Monthly salary');
const thisMonth = today.slice(0, 7) + '-01';
await mark('owner', today, [{ worker_id: mw, status: 'leave' }]);
const close = await as('owner', `select close_month($1, $2::date, null, 50000, 'Leave 1 day')`, [mw, thisMonth]);
check('close month: ₹15,000 salary − ₹500 deduction = ₹14,500', !close.error && (await bal(mw)) === 1450000, close.error);
check('month cannot be closed twice', /already closed/.test((await as('owner', `select close_month($1, $2::date)`, [mw, thisMonth])).error ?? ''));
check('daily worker month cannot be closed', !!(await as('owner', `select close_month($1, $2::date)`, [dw, thisMonth])).error);
const wm = (await as('owner', `select worker_month($1, $2::date) as r`, [mw, thisMonth])).rows[0].r;
check('month summary: closed, ₹15,000 earned, ₹500 deducted, 1 leave day',
  wm.closed && wm.earned_paise === 1500000 && wm.deduction_paise === 50000 && wm.leave === 1, JSON.stringify(wm));
const salaryUndo = await as('owner', `select reverse_worker_txn($1, 'redo month')`, [wm.salary_txn_id]);
check('undoing the salary re-opens the month', !salaryUndo.error &&
  (await as('owner', `select worker_month($1, $2::date) as r`, [mw, thisMonth])).rows[0].r.closed === false);

console.log('Who sees what');
check('owner sees all worker balances', (await count('owner', 'worker_balances')) >= 5);
const wb2 = await as('worker', `select worker_id, balance_paise from worker_balances`);
check('worker sees only their own balance', wb2.rows?.length === 1 && wb2.rows[0].worker_id === w, JSON.stringify(wb2));
check('cashier sees no worker balances', (await count('cashier', 'worker_balances')) === 0);
check('anon cannot read balances', String(await count(null, 'worker_balances')).startsWith('error'));
check('worker can read own month summary', !(await as('worker', `select worker_month($1, $2::date)`, [w, thisMonth])).error);
check("worker cannot read someone else's month", !!(await as('worker', `select worker_month($1, $2::date)`, [dw, thisMonth])).error);

// --- Phase 5: orders ----------------------------------------------------------------
console.log('Orders');
const saveOrder = (user, id, items, date = today, name = 'Hotel Sai', phone = '9811122233') =>
  as(user, `select save_order($1, $2, $3, $4::date, 'Morning', null, $5::jsonb) as r`, [id, name, phone, date, JSON.stringify(items)]);
const o1 = await saveOrder('owner', null, [{ product_id: packet, qty: 10, price_paise: 5500 }]);
const ord = o1.rows?.[0].r;
check('order of 10 packets at bulk price ₹55 = ₹550', ord?.subtotal_paise === 55000 && /^OR\//.test(ord.order_no), o1.error);
check('cashier cannot create orders', !!(await saveOrder('cashier', null, [{ product_id: packet, qty: 1 }])).error);
check('past delivery date refused for a new order', !!(await saveOrder('owner', null, [{ product_id: packet, qty: 1 }], yesterday)).error);
check('owner cannot insert orders directly',
  !!(await as('owner', `insert into orders (order_no, customer_name, delivery_date) values ('X', 'Y', current_date)`)).error);

const orderPay = (user, id, kind, amt, mode = 'cash') =>
  as(user, `select add_order_payment($1, $2, $3, $4)`, [id, kind, amt, mode]);
const ownBefore = await summary('owner');
check('advance ₹200 cash taken', !(await orderPay('owner', ord.id, 'advance', 20000)).error);
const ov = (await as('owner', `select status, advance_paise, balance_paise from order_overview where id = $1`, [ord.id])).rows[0];
check('order shows advance ₹200, balance ₹350, status advance_paid',
  ov.status === 'advance_paid' && ov.advance_paise == 20000 && ov.balance_paise == 35000, JSON.stringify(ov));
const ownAfter = await summary('owner');
check("advance counted in today's cash in hand", ownAfter.net_cash_paise - ownBefore.net_cash_paise === 20000);
check('advance more than the order total refused', /cannot be more/.test((await orderPay('owner', ord.id, 'advance', 40000)).error ?? ''));
check('editing the order below the advance refused',
  /more than the new order total/.test((await saveOrder('owner', ord.id, [{ product_id: packet, qty: 1 }])).error ?? ''));
check('editing the order works', (await saveOrder('owner', ord.id, [{ product_id: packet, qty: 12, price_paise: 5500 }])).rows?.[0].r.subtotal_paise === 66000);
check('mark ready', !(await as('owner', `select set_order_ready($1, true)`, [ord.id])).error);
check("cashier sees today's order", (await as('cashier', `select id from order_overview where id = $1`, [ord.id])).rows?.length === 1);
check('worker sees no orders', (await count('worker', 'order_overview')) === 0);

console.log('Deliver & bill');
const conv = (user, id, pays) => as(user, `select convert_order_to_bill($1, $2::jsonb) as r`, [id, JSON.stringify(pays)]);
check('wrong balance refused', /Balance to collect/.test((await conv('cashier', ord.id, [{ mode: 'cash', amount_paise: 66000 }])).error ?? ''));
const cv = await conv('cashier', ord.id, [{ mode: 'upi', amount_paise: 46000 }]);
const cvb = cv.rows?.[0].r;
check('cashier delivers: bill ₹660 = ₹200 advance + ₹460 UPI', cvb?.total_paise === 66000 && cvb.advance_paise === 20000, cv.error);
const cvPays = (await db.query(`select mode, amount_paise from payments where bill_id = $1 order by mode`, [cvb.id])).rows;
check('bill payments: advance ₹200 + UPI ₹460', cvPays.length === 2 && cvPays.some((p) => p.mode === 'advance' && p.amount_paise == 20000));
check('order is now delivered and linked to the bill',
  (await db.query(`select status, bill_id from orders where id = $1`, [ord.id])).rows[0].bill_id === cvb.id);
check('cannot bill the same order twice', /already billed/.test((await conv('owner', ord.id, [])).error ?? ''));
check('advance is not counted twice in cash (bill advance excluded)',
  (await summary('owner')).net_cash_paise === ownAfter.net_cash_paise);
check('bill from an order cannot be voided', /Returns instead/.test((await as('owner', `select void_bill($1, 'try it')`, [cvb.id])).error ?? ''));

const o2 = (await saveOrder('owner', null, [{ product_id: packet, qty: 2 }], tomorrow)).rows[0].r;
check("cashier cannot bill tomorrow's order", /due today/.test((await conv('cashier', o2.id, [{ mode: 'cash', amount_paise: 12000 }])).error ?? ''));
await orderPay('owner', o2.id, 'advance', 5000, 'upi');
check('partial advance refund', !(await orderPay('owner', o2.id, 'refund', 2000, 'upi')).error);
check('cannot refund more than held', !!(await orderPay('owner', o2.id, 'refund', 9000, 'upi')).error);
check('cancel with refund of the remaining ₹30', !(await as('owner', `select cancel_order($1, 'Customer changed plan', 'cash')`, [o2.id])).error);
const o2v = (await as('owner', `select status, advance_paise from order_overview where id = $1`, [o2.id])).rows[0];
check('cancelled order holds no advance', o2v.status === 'cancelled' && o2v.advance_paise == 0, JSON.stringify(o2v));
check('cancelled order cannot be billed', /cancelled/.test((await conv('owner', o2.id, [])).error ?? ''));

const o3 = (await saveOrder('owner', null, [{ product_id: packet, qty: 1 }])).rows[0].r;
await orderPay('owner', o3.id, 'advance', 6000);
const full = await conv('owner', o3.id, []);
check('fully paid in advance: bill with nothing more to collect', !full.error && full.rows[0].r.total_paise === 6000, full.error);

// --- Phase 6: reports ----------------------------------------------------------------
console.log('Report settings');
const setS = (sql) => as('owner', `update app_settings set ${sql}`);
check('bad email in the list refused', !!(await setS(`report_emails = array['not-an-email']`)).error);
check('more than 10 emails refused', !!(await setS(`report_emails = array_fill('a@b.co'::text, array[11])`)).error);
check('time not on a 15-minute step refused', !!(await setS(`report_time = '19:07'`)).error);
check('owner saves time 19:15 and two emails', !(await setS(`report_time = '19:15', report_emails = array['owner@example.com','accounts@example.com']`)).error);
check('cashier cannot change report settings',
  ((await as('cashier', `update app_settings set report_time = '08:00' returning 1`)).rows ?? []).length === 0);

console.log('Dashboard and report data');
const dash = await as('owner', `select dashboard($1::date, $1::date) as r`, [today]);
const dr = dash.rows?.[0].r;
check('dashboard totals, one day, top products', dr?.totals.bills > 0 && dr.by_day.length === 1 && dr.top_products.length > 0, dash.error);
check('dashboard sales = sum of active bills',
  dr?.totals.sales_paise === Number((await db.query(`select sum(total_paise) s from bills where status = 'active' and business_date = $1`, [today])).rows[0].s));
check('cashier cannot open the dashboard', !!(await as('cashier', `select dashboard($1::date, $1::date)`, [today])).error);
const rd = await as('owner', `select report_data($1::date, $1::date) as r`, [today]);
const rdata = rd.rows?.[0].r;
const sheets = ['Summary', 'Bills', 'Items sold', 'Payments by mode', 'Returns', 'Cash out', 'Coupons used', 'Order advances'];
check('report has all 8 sheets', !!rdata && sheets.every((k) => Array.isArray(rdata[k])), rd.error);
check('Bills sheet lists every bill of the day (incl. void)',
  rdata?.Bills.length === Number((await db.query(`select count(*) n from bills where business_date = $1`, [today])).rows[0].n));
check('Summary shows sales in rupees',
  rdata?.Summary.find((x) => x.Item === 'Sales ₹')?.Value === dr.totals.sales_paise / 100);
check('Returns and Cash out sheets filled', rdata?.Returns.length > 0 && rdata['Cash out'].length > 0);
check('cashier cannot get report data', !!(await as('cashier', `select report_data($1::date, $1::date)`, [today])).error);
check('worker cannot get report data', !!(await as('worker', `select report_data($1::date, $1::date)`, [today])).error);
const rdFile = new URL('../supabase/functions/report/sample-report-data.json', import.meta.url);
(await import('node:fs')).writeFileSync(rdFile, JSON.stringify(rdata, null, 1)); // used by the Excel test

console.log('Daily report timer (custom time + email list)');
await db.exec(`
  create schema if not exists net;
  create table net.calls (url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint
  language sql as $$ insert into net.calls values (url, headers, body); select 1::bigint $$;`);
const tick = async () => (await db.query(`select report_tick() as r`)).rows[0].r;
await db.query(`update app_settings set report_emails = '{}'`);
check('no emails in the list → nothing sent', (await tick()) === 'off');
await db.query(`update app_settings set report_emails = array['owner@example.com'], report_time = '00:00'`);
check('secrets not set → waits', (await tick()) === 'not set up');
await db.query(`update app_secrets set report_function_url = 'https://x.supabase.co/functions/v1/report', cron_secret = 's3cret'`);
check('time passed → report sent', (await tick()) === 'sent');
const call = (await db.query(`select * from net.calls`)).rows[0];
check('request carries the secret and today\'s date', call?.headers['x-cron-secret'] === 's3cret' && call.body.date === today);
check('second check the same day → not sent again', (await tick()) === 'already sent');
await db.query(`update report_runs set status = 'failed' where kind = 'daily'`);
check('after a failure it retries', (await tick()) === 'sent');
await db.query(`update report_runs set status = 'failed' where kind = 'daily'`);
await tick();
await db.query(`update report_runs set status = 'failed' where kind = 'daily'`);
check('gives up after 3 tries in a day', (await tick()) === 'gave up after 3 tries');
await db.query(`update app_settings set report_enabled = false`);
check('switched off → nothing sent', (await tick()) === 'off');
check('app cannot run the timer itself', !!(await as('owner', `select report_tick()`)).error);
check('owner cannot read the timer secret', !!(await as('owner', `select cron_secret from app_secrets`)).error);
check('owner sees report history', (await count('owner', 'report_runs')) >= 3);

// --- Phase 7: nightly backup ----------------------------------------------------------
console.log('Nightly backup timer');
const btick = async () => (await db.query(`select backup_tick() as r`)).rows[0].r;
await db.exec(`delete from net.calls`);
check('backup request sent', (await btick()) === 'sent');
const bcall = (await db.query(`select body from net.calls`)).rows[0];
check('request asks for a backup', bcall?.body.kind === 'backup' && bcall.body.date === today);
check('backup not repeated the same night', (await btick()) === 'already done');
await db.query(`update report_runs set status = 'failed' where kind = 'backup'`);
check('failed backup is retried', (await btick()) === 'sent');
check('backup runs even when the daily email is off', (await db.query(`select report_enabled from app_settings`)).rows[0].report_enabled === false);
check('app cannot start the backup timer itself', !!(await as('owner', `select backup_tick()`)).error);
const fnSrc = readFileSync(new URL('../supabase/functions/report/index.ts', import.meta.url), 'utf8');
const backedUp = new Set([...fnSrc.matchAll(/^\s*\['([a-z_]+)', \[/gm)].map((m) => m[1]));
const allTables = (await db.query(`select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'app_secrets'`)).rows.map((r) => r.table_name);
const missing = allTables.filter((t) => !backedUp.has(t));
check('backup covers every table', missing.length === 0, `missing: ${missing.join(', ')}`);

// --- Sell weighed items by amount ("₹100 worth") -----------------------------------
console.log('Sell by amount');
const amt = await bill6('cashier', [{ product_id: loose, amount_paise: 10000 }], cash(10000)); // ₹240/kg
check('₹100 of loose oyster: bill is exactly ₹100', amt.total_paise === 10000, JSON.stringify(amt));
const amtLine = (await db.query(`select qty::text q, line_total_paise l from bill_items where bill_id = $1`, [amt.id])).rows[0];
check('weight to give is worked out: 0.417 kg', amtLine.q === '0.417' && amtLine.l == 10000, JSON.stringify(amtLine));
const mix = await bill6('cashier', [{ product_id: loose, amount_paise: 5000 }, { product_id: packet, qty: 2 }], cash(17000));
check('amount line + packets on one bill = ₹50 + ₹120', mix.total_paise === 17000, mix.error ?? JSON.stringify(mix));
check('amount on a packet product is refused',
  /enter how many/.test((await bill6('cashier', [{ product_id: packet, amount_paise: 10000 }], cash(10000))).error ?? ''));
check('amount under 1 gram is refused',
  /too small/.test((await bill6('cashier', [{ product_id: loose, amount_paise: 10 }], cash(10))).error ?? ''));
check('zero or negative amount is refused',
  !!(await bill6('cashier', [{ product_id: loose, amount_paise: 0 }], [])).error);
await db.query(`update coupons set used_count = 0, usage_limit = null, active = true, expires_at = null where code = 'WELCOME10'`);
const amtCoupon = await preview('cashier', [{ product_id: loose, amount_paise: 10000 }], 'WELCOME10');
check('10% coupon on ₹100 worth = ₹90', amtCoupon.total_paise === 9000, JSON.stringify(amtCoupon));
const amtItem = (await db.query(`select id from bill_items where bill_id = $1`, [amt.id])).rows[0].id;
const amtRet = await ret('cashier', amt.id, [{ bill_item_id: amtItem, qty: 0.417 }]);
check('returning all of it refunds exactly ₹100', amtRet.amount_paise === 10000, amtRet.error ?? JSON.stringify(amtRet));

// --- Bargain price, colours, sections ----------------------------------------------
console.log('Bargain price, colours, sections');
const bg = await bill6('cashier', [{ product_id: loose, qty: 0.5, price_paise: 16000 }], cash(8000)); // normal ₹240/kg
check('bargain: 0.5 kg at ₹160/kg = ₹80', bg.total_paise === 8000, bg.error ?? JSON.stringify(bg));
const bgLine = (await db.query(`select unit_price_paise p, list_price_paise l from bill_items where bill_id = $1`, [bg.id])).rows[0];
check('bill line keeps bargained rate ₹160 and normal ₹240', bgLine.p == 16000 && bgLine.l == 24000, JSON.stringify(bgLine));
check('product price is unchanged', (await db.query(`select price_paise from products where id = $1`, [loose])).rows[0].price_paise == 24000);
const bgAmt = await bill6('cashier', [{ product_id: loose, amount_paise: 10000, price_paise: 20000 }], cash(10000));
const bgAmtQ = (await db.query(`select qty::text q from bill_items where bill_id = $1`, [bgAmt.id])).rows[0]?.q;
check('₹100 worth at bargained ₹200/kg = give 0.5 kg', bgAmt.total_paise === 10000 && bgAmtQ === '0.500', bgAmt.error ?? bgAmtQ);
const bgUp = await bill6('cashier', [{ product_id: packet, qty: 2, price_paise: 7000 }], cash(14000));
check('bargain can be higher too: 2 packets at ₹70', bgUp.total_paise === 14000, bgUp.error ?? JSON.stringify(bgUp));
const normal = await bill6('cashier', [{ product_id: packet, qty: 1 }], cash(6000));
check('normal sale has no bargain mark',
  (await db.query(`select list_price_paise l from bill_items where bill_id = $1`, [normal.id])).rows[0].l === null);
check('zero bargain price refused',
  /bargain/.test((await bill6('cashier', [{ product_id: packet, qty: 1, price_paise: 0 }], cash(0))).error ?? ''));
check('text bargain price refused',
  /bargain/.test((await bill6('cashier', [{ product_id: packet, qty: 1, price_paise: 'abc' }], cash(6000))).error ?? ''));
const bgPrev = await preview('cashier', [{ product_id: packet, qty: 2, price_paise: 5000 }], 'WELCOME10');
check('coupon works on bargained price: 2 × ₹50 − 10% = ₹90', bgPrev.total_paise === 9000, JSON.stringify(bgPrev));
check('owner can set colour and section',
  !(await as('owner', `update products set color = 'green', section = 'Fresh' where id = '${loose}'`)).error);
check('unknown colour refused', !!(await as('owner', `update products set color = 'neon' where id = '${loose}'`)).error);
await as('cashier', `update products set color = 'red' where id = '${loose}'`);
check('cashier cannot change colour', (await db.query(`select color from products where id = $1`, [loose])).rows[0].color === 'green');
check('bill lines still cannot be edited',
  await db.query(`update bill_items set list_price_paise = null where bill_id = $1`, [bg.id]).then(() => false, () => true));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
