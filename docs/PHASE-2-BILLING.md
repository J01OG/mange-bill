# Phase 2: products, billing, printing and WhatsApp

Do [Phase 1](PHASE-1-SETUP.md) first. This phase takes about 15 minutes to set up, plus printer setup.

## Try it first without any setup (optional)

Open PowerShell in the project folder and run:

```powershell
npm run demo
```

Open **http://localhost:5173**. Log in with mobile **90000 00001** (owner) or **90000 00002** (cashier) and any password.
It uses made-up data that disappears when you refresh the page. Nothing is saved anywhere.

---

## Step 1 — Add the billing functions to the database

1. Supabase → **SQL Editor** → **New query**.
2. Copy everything from `supabase/migrations/0003_billing.sql`, paste it in, and click **Run**. You should see *Success*.

## Step 2 — Update the app online

```powershell
npm run build
```

Then Netlify → your site → **Deploys** → drag the new **dist** folder onto the box.
Phones that already installed the app pick up the update the next time they open it. If one doesn't, close the app fully and open it again.

## Step 3 — Fill in your farm details (owner)

In the app: **Home → Farm settings**.
- Farm name, address, phone and the bottom-of-bill message are printed on every bill.
- **GSTIN**: leave it empty for now. Bills show a "GST: Nil" line. Add the GSTIN later and it appears on bills automatically.
- **Prices already include GST**: leave this ticked.
- **UPI ID**, e.g. `yourfarm@okaxis`: when the cashier chooses UPI, a QR code with the exact amount appears for the customer to scan.

Then **Home → Products**: fix the names and prices, archive the sample products you don't sell, and add your real ones.
"Position on bill screen" puts your best sellers first (smaller number = shown earlier).

## Step 4 — Set up printing

The app prints through the browser's normal print button, so any printer that your phone or PC can print to will work.

### From a Windows PC (USB receipt printer or normal A4 printer)
1. Install the printer's Windows driver (it usually comes on a CD, or from the brand's website).
2. In Windows **Printers & scanners** → your receipt printer → **Printing preferences**, set the paper to **80 mm** (or 58 mm), with the length set to "receipt" or "continuous".
3. In the app, open a bill → choose **80 mm** / **58 mm** / **A4** → **Print**.
4. In Chrome's print window, the first time only: pick the printer, **More settings → Margins: None**, untick **Headers and footers**, **Scale: Default**. Chrome remembers these.

> **Faster (optional):** to skip the print window entirely on the billing PC, make a Chrome shortcut on the desktop, right-click it → *Properties*, and add ` --kiosk-printing` to the end of *Target*. Open the app from that shortcut. Every Print then goes straight to the default printer.

### From an Android phone (Bluetooth receipt printer)
1. Pair the printer in the phone's **Settings → Bluetooth**.
2. From the Play Store, install **RawBT** (free). Open it, select your printer, and set the paper width to **58 mm** or **80 mm**.
3. In **Settings → Connected devices → Printing**, turn on the **RawBT** print service.
4. In the app, open a bill → choose the paper size → **Print** → choose **RawBT** as the printer → print.
   > Some printer brands have their own print-service app; that works the same way.

## Step 5 — Test Phase 2 (tick each one)

**Billing as the cashier**
- [ ] **New bill** → tap a packet product twice. It shows **2** and the total updates.
- [ ] Tap a **kg** product → **500 g**. The line shows 0.5 kg at half the kg price.
- [ ] Use **−** to remove a packet, and **×** to remove the kg line.
- [ ] **Charge → Cash**, type the cash received (e.g. 500). It shows how much change to give back. **Save bill**. A bill number like `MF/26-27/000001` appears.
- [ ] Time yourself: three products → Charge → Cash → Save should take **under 15 seconds**.
- [ ] **+ Next bill** → make a **UPI** bill. The QR shows (if you set a UPI ID). Scan it with your own phone: the UPI app should show the farm's name and the exact amount. *Don't pay. Just check, then cancel.*
- [ ] **Split**: on a ₹180 bill, enter cash 100. It shows UPI ₹80. Save.
- [ ] Open **Customer details**, enter your own mobile → Save → **Send on WhatsApp**. WhatsApp opens with the bill text. Send it to yourself and open the link. The bill opens without logging in.
- [ ] A bill with no mobile number shows no WhatsApp button.
- [ ] **Print** at 58 mm, 80 mm and A4. Only the bill prints, with no app menus.
- [ ] **Bills** tab shows today's bills with Cash / UPI / Total at the top.
- [ ] The cashier **cannot** see yesterday's bills, Products, or Settings.

**As the owner**
- [ ] **Bills** → change the date to see another day.
- [ ] Open a bill → **Cancel (void) this bill** → give a reason. It shows VOID, and the Bills totals drop.
- [ ] Archive a product. It disappears from the New bill screen. Put it back on sale.
- [ ] Change a price, then make a bill. The new price is used. Old bills keep the old price.

**Safety**
- [ ] Turn on airplane mode → an orange "No internet" bar appears, and saving a bill shows "No internet connection". Turn airplane mode off and tap Save again. Only **one** bill is created.
