# Owner's guide: using the app every day

Keep this on your phone. Each section is a few taps.

## Who sees what
| | Owner | Cashier | Worker | Customer |
|---|---|---|---|---|
| Make bills, returns, cash out | ✅ | ✅ | | |
| See today's own bills and cash | ✅ | ✅ (own only) | | |
| Cancel (void) a bill · cancel a cash out | ✅ | | | |
| Products, coupons, settings, users | ✅ | | | |
| Workforce, attendance, pay | ✅ | own pay only | own pay only | |
| Orders & calendar | ✅ | today's deliveries | | |
| Reports, Excel, backups | ✅ | | | |

---

## At the counter (owner or cashier)
**Make a bill**: **New bill** → tap products (a packet adds 1 with each tap; a **kg** item asks for the weight) → **Charge** →
**Cash** (type what the customer gave to see the change) / **UPI** (the customer scans the QR) / **Split** → **Save bill**.
- Customer's mobile number and a coupon are optional: **Customer & coupon**.
- After saving: **Print** (pick 58 mm / 80 mm / A4) or **Send on WhatsApp** (only if a mobile number was entered) → **+ Next bill**.

**Customer returns something**: Home → **Returns** → type the bill number (just the last digits is fine) → choose how many → Cash/UPI refund → Save.
**Money taken from the till**: **Cash** tab → **− Cash out** → amount, reason, who took it.
**End of day**: **Cash** tab → "Should be in hand". Count the till. The change money you started the day with is not included in this figure.

## Owner only
**Cancel a wrong bill**: open it from **Bills** → *Cancel (void) this bill* → reason. It stays in the records, marked VOID.
(If only some items came back, use Returns instead. A bill made from an order cannot be voided; use Returns.)

**Prices and products**: Home → **Products** → tap one to change its price. **Archive** a product to stop selling it; old bills keep their prices.

**Coupons**: Home → **Coupons** → **+ New coupon**: % or ₹ off, all or some products, optional one-customer-only, minimum bill, max uses, last day.

**Users**: Home → **Users** → **+ Add user** (mobile + password + role). Tap a user to **reset the password**, change the role, or **disable** them.
Nobody can sign up by themselves, and a forgotten password is reset by you here.
*Your own* forgotten password: Supabase dashboard → Authentication → Users → you → change password.

## Workers
- **Every day**: Home → **Attendance** → *Mark the other N as Present* → tap the exceptions (½ / A / L) → **Save attendance**.
  Daily-wage workers' wages are added automatically.
- **Paying**: Workforce → the worker → **Pay** (any amount, any date) · **Advance** · **Bonus** · **Deduct**. The balance updates at once.
  If the cash comes out of the shop till, also add a **Cash out**.
- **Monthly workers**: open the worker → **Month** shows present / absent / **leave** days → type any deduction you decide → **Add salary**.
- **Mistake?** In History, tap *Undo this entry* (nothing is deleted; an opposite line is added). Wrong attendance → just re-mark that day.
- **Let a worker do billing**: worker page → **App login** → *Allow billing (make cashier)*.

## Bulk orders
Home → **Orders & calendar** → **+ New order** → customer, delivery date, items (you can change prices for bulk) → Save → **+ Take advance**.
On the delivery day: open the order → **🚚 Deliver & make bill**. The advance is subtracted and the customer pays only the balance.
Month view shows each day's number of orders and the money still to collect.

## Reports
Home → **Reports**: choose Today / This week / This month / any dates. **⬇ Download Excel** or **✉ Email this now**.
The **daily email** goes out automatically at the time you chose, to your list (change it at the bottom of Reports).

## Backups (automatic)
Every night at 2 am a full copy is saved (Farm settings → **Backups**, last 30 days), and every Sunday's copy is emailed to you.
Keep those Sunday emails. You can also tap **Download a full backup now** any time.

## When something looks wrong
| Problem | What to do |
|---|---|
| Orange "No internet" bar | Bills can't be saved offline. Use mobile data or wait, then tap Save again (it never saves twice). |
| Blue "New version ready" bar | Tap **Update** when you are not in the middle of a bill. |
| "Something went wrong on this screen" | Tap **Reload**. Your saved data is safe. |
| A cashier can't see yesterday's bills | Normal. Cashiers see only their own bills from today. |
| Daily email didn't come | Reports → *Sent reports* shows the reason. Check spam. See MAINTENANCE.md. |
