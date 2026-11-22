# Phase 3: returns, cash out and coupons

Do [Phase 2](PHASE-2-BILLING.md) first. Setup takes about 5 minutes.
To try it first with made-up data, run `npm run demo`.

## Step 1 — Update the database

1. Supabase → **SQL Editor** → **New query**.
2. Copy everything from `supabase/migrations/0004_returns_cash_coupons.sql`, paste it in, and click **Run**. You should see *Success*.

> Run it only once. If you see "already exists", it has already been run.

## Step 2 — Update the app online

```powershell
npm run build
```

Netlify → your site → **Deploys** → drag the new **dist** folder onto the box.

---

## How it works

### Coupons (owner: Home → Coupons)
- **% off** or **₹ off**, on **all products** or **only selected products**.
- Optional settings: **only for one customer's mobile**, **minimum bill**, **maximum number of uses**, **last day**.
- To stop a coupon, untick **Coupon is on**. Coupons are never deleted, so old bills still show which coupon was used.
- At the counter: **Charge → Customer & coupon → type the code → Apply**. The new total shows at once.
  For a one-customer coupon, enter the customer's mobile first.
- One coupon per bill. Cancelling (voiding) a bill gives the coupon use back.

### Returns (owner and cashier: Home → Returns, or "Return items" on any bill)
- Find the bill by its number. Just the last digits work: `123` finds `MF/26-27/000123`.
- Choose how many of each item are coming back, choose **Cash refund** or **UPI refund**, and save.
- The refund is the price the customer **actually paid**, after any coupon discount.
- You can do several returns on one bill, but never return more than was bought.
- Cashiers can return items from bills up to **30 days old**. Older bills: owner only.
- A bill with a return can no longer be cancelled. The return already takes care of it.
- The receipt and the customer's WhatsApp link show the returns and the net amount.

### Cash and cash out (Cash tab)
- **Cash out** = money taken out of the till (diesel, tea, owner took cash home…). Enter amount, reason, who took it.
- **Should be in hand** = cash sales − cash refunds − cash out.
  It **does not include the change money you start the day with**. Add that yourself when you count the till.
- A cashier sees only **their own** bills, refunds and cash-outs, for **today**. The owner sees everyone, any day.
- A wrong cash-out entry can be cancelled by the **owner only** (with a reason). It stays in the list, crossed out.

---

## Test Phase 3 (tick each one)

**Coupons (as the owner)**
- [ ] Create `TEST10`: 10% off, all products. Bill 2 × ₹60 with it. The total shows ₹108 and the bill shows "Discount (TEST10) −₹12".
- [ ] Create `BUTTON50`: 50% off, **only** Button mushroom. A bill with only Oyster says it "does not apply". A bill with Button + Oyster discounts only the Button part.
- [ ] Create a coupon with **Max uses = 1**. Use it once. The second time it says "fully used".
- [ ] Create a coupon with **Last day = yesterday**. It says "expired".
- [ ] Create a coupon **only for your mobile**. Without the mobile it is refused; with your mobile it works.
- [ ] Cancel (void) a bill that used a coupon. The coupon's "Used" count goes down by 1.

**Returns (as the cashier)**
- [ ] Make a bill with 3 packets. **Return items** → return 1 → Cash refund. It says "Give back ₹60".
- [ ] Find the same bill again. It shows 2 left. Return 2 → the full amount has now been refunded, and it says "All returned".
- [ ] On a bill with a 10% coupon, returning 1 of 2 ₹60 packets refunds **₹54**, not ₹60.
- [ ] Open the bill → the receipt shows the return lines and "Net after returns".
- [ ] As the owner, try to cancel a bill that has a return. It is refused.

**Cash (as the cashier)**
- [ ] Cash tab: Cash sales, refunds and Should be in hand match your bills.
- [ ] **− Cash out** → ₹50, "Tea". "Should be in hand" drops by ₹50.
- [ ] Log in as the owner → Cash → cancel that entry. It is crossed out, and the total goes back up.
- [ ] Log in as a cashier: there is no date picker, and no other cashier's bills are included.
