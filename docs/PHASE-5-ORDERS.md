# Phase 5: bulk orders and the delivery calendar

Do [Phase 4](PHASE-4-WORKFORCE.md) first. Setup takes about 5 minutes.
To try it with made-up data, run `npm run demo` and log in as 90000 00001. Two sample orders are already there.

## Step 1 — Update the database

Supabase → **SQL Editor** → **New query** → paste everything from `supabase/migrations/0006_orders.sql` → **Run**.

## Step 2 — Update the app online

```powershell
npm run build
```

Netlify → your site → **Deploys** → drag the new **dist** folder onto the box.

---

## How it works

### Taking an order (owner: Home → Orders & calendar → + New order)
- Customer name (mobile optional), **delivery date**, time/place note, then add products.
- Each line's **price can be changed** for a bulk deal. The final bill uses these prices.
- Save, then **+ Take advance** (cash or UPI). The order becomes **Advance paid**.
- An advance taken in **cash** is counted in **that day's** cash in hand. It is not counted again on delivery day.

### Calendar
- **Month**: each day shows how many orders are due and the ₹ balance still to collect. Tap a day to see its orders.
- **Week** and **Day** list the orders with status and balance due. Tap the title to jump back to today.
- Status colours: Pending (grey) · Advance paid (blue) · Ready (amber) · Delivered (green) · Cancelled (red).

### On the delivery day
- Open the order → **📦 Mark ready** once it is packed (optional).
- **🚚 Deliver & make bill** shows *Bill total − Advance already paid = Collect now*.
  Choose cash / UPI / split for the balance. A normal numbered bill is made, which you can print and send on WhatsApp like any other bill.
  The bill shows "Paid by Advance" and the rest separately.
- **Cashiers** see **today's** deliveries (Home → Today's deliveries) and can deliver & bill them. They cannot create, edit or cancel orders.

### Changing or cancelling
- **Edit order** works until it is delivered. You cannot lower the total below the advance already taken (refund the difference first).
- **Refund advance** gives back part or all of the advance (cash or UPI).
- **Cancel this order**: give a reason, then choose **Refund cash**, **Refund UPI** or **Keep it** for any advance held.
- A bill made from an order cannot be cancelled (voided), because the advance is tied to it. If goods come back, use **Return items** on that bill.

---

## Test Phase 5 (tick each one)

**As the owner**
- [ ] New order for tomorrow: 10 packets with the price changed to ₹55 → Order total ₹550.
- [ ] **Take advance** ₹200 cash → status **Advance paid**, Balance due ₹350.
- [ ] Cash tab → "Order advances (net) ₹200" is included in Should be in hand.
- [ ] Try an advance of ₹400. It is refused (more than the order).
- [ ] **Edit order** → change 10 to 12 → total ₹660, balance ₹460.
- [ ] Month view: tomorrow shows **1** and ₹460. Tap it to see the order.
- [ ] **Mark ready** → status Ready.
- [ ] **Deliver & make bill** → Collect now ₹460 → UPI → the bill shows Advance ₹200 + UPI ₹460 = ₹660.
- [ ] The Cash tab did **not** add the ₹200 a second time.
- [ ] Second order with a ₹100 advance → **Cancel** → Refund cash. Cash in hand drops by ₹100, and the order shows Cancelled.

**As a cashier**
- [ ] Home → **Today's deliveries** shows only today's orders, with no New order / Edit / Cancel buttons.
- [ ] A cashier can **Deliver & make bill** for today's order.
