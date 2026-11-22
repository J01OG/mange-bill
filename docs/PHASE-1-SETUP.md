# Phase 1 setup: database, login and users

This takes about 30–40 minutes the first time. You only do it once.
You need a computer (Windows is fine), a Google or email account, and this project folder.

---

## Step 1 — Install Node.js (one time)

1. Go to **https://nodejs.org** and download the **LTS** version.
2. Run the installer and keep clicking **Next** (the default settings are fine).
3. To check it worked, open **PowerShell** (Start menu → type "PowerShell") and type:
   ```powershell
   node -v
   ```
   You should see something like `v22.x.x`.

## Step 2 — Create the Supabase project (free)

1. Go to **https://supabase.com** → **Start your project** → sign up.
2. Click **New project**.
   - **Name:** `mushroom-farm`
   - **Database password:** click *Generate*, then **copy it and keep it somewhere safe** (a notebook is fine).
   - **Region:** **South Asia (Mumbai)**, because it's the closest to you and so the fastest.
   - Plan: **Free**.
3. Click **Create new project** and wait about 2 minutes until it says the project is ready.

## Step 3 — Create the database tables

1. In the left menu click **SQL Editor** → **New query**.
2. Open the file `supabase/migrations/0001_schema.sql` from this project in Notepad, select everything (Ctrl+A), copy (Ctrl+C).
3. Paste it into the SQL Editor and click **Run**. You should see *"Success. No rows returned"*.
4. Click **New query** again and do the same with `supabase/migrations/0002_security.sql`.
5. *(Optional, for trying things out)* Do the same with `supabase/seed.sql`. This adds sample products, three sample workers and two coupons. You can edit or archive them later.

> If you see an error saying something "already exists", that file was already run. Don't run it twice.

## Step 4 — Turn off public sign-up and create the owner login

1. Left menu → **Authentication** → **Sign In / Providers** (on some screens: *Providers*).
   - Turn **OFF** "Allow new users to sign up".
   - Under **Email**, turn **OFF** "Confirm email". Leave the Email provider itself **ON**.
   - Click **Save**.
2. Left menu → **Authentication** → **Users** → **Add user** → **Create new user**:
   - **Email:** `91` + your 10-digit mobile + `@farm.local`
     For example, if your mobile is 98765 43210 → `919876543210@farm.local`
   - **Password:** choose one (at least 6 characters).
   - Tick **Auto Confirm User**.
   - Click **Create user**.
3. Go back to **SQL Editor** → **New query**, paste this line (with **your** mobile number and name) and click **Run**:
   ```sql
   select bootstrap_owner('9876543210', 'Your Name');
   ```
   You should see `Owner created: ...`.

## Step 5 — Add the "manage users" function

1. Left menu → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly: `admin-users`
3. Delete the sample code in the editor. Open `supabase/functions/admin-users/index.ts` from this project in Notepad, copy everything, and paste it in.
4. Click **Deploy function**.
5. Open the function → **Details** (or **Settings**) → turn **OFF** "Enforce JWT verification" (sometimes called "Verify JWT") → **Save**.
   *This is safe: the function checks for itself that the person calling it is the owner.*

## Step 6 — Connect the app to Supabase

1. In Supabase: **Project Settings** (gear icon) → **API Keys** (on some screens: **API**).
   You need two values:
   - **Project URL**, which looks like `https://abcdxyz.supabase.co` (shown under **Data API**, or on the project home page)
   - The **anon public** key (or **Publishable key**), a long text
   > ⚠️ Never copy the **service_role** / **secret** key into the app.
2. In this project folder, copy the file `.env.example` and rename the copy to `.env`.
3. Open `.env` in Notepad and paste your two values after the `=` signs. Save.

## Step 7 — Run the app on your computer

Open PowerShell **in this project folder**: in File Explorer, open the folder, click the address bar, type `powershell` and press Enter. Then run:

```powershell
npm install
```

```powershell
npm run dev
```

Open **http://localhost:5173** in Chrome. Log in with your mobile number and password.

## Step 8 — Test Phase 1 (tick each one)

**As the owner**
- [ ] You can log in. The Home screen shows your name and **Owner**.
- [ ] Open **Users** → **+ Add user** → add a **Cashier** (use a real or test mobile, e.g. a family member's) with a password.
- [ ] Add a **Worker** the same way.
- [ ] Tap the cashier → **Reset password** to a new one. It says "Password changed".
- [ ] **My account** → change your own password, log out and log back in with the new one.

**As the cashier** (log out, then log in with the cashier's number)
- [ ] Home shows **Cashier** and only cashier tiles. There is **no** Users tab.
- [ ] Typing `http://localhost:5173/users` in the address bar sends you back to Home.

**As the worker**
- [ ] Home shows only "My attendance & pay" (it will start working in Phase 4).

**Disabling**
- [ ] As the owner, open the worker → **Disable user**. Log in as that worker; it must say the account is disabled.
- [ ] Enable them again, and they can log in.

**Safety**
- [ ] As the owner, try to disable yourself. The button isn't shown for your own account.

## Step 9 — Put it online (Netlify, free)

1. In PowerShell (in the project folder):
   ```powershell
   npm run build
   ```
   This creates a folder called **dist**.
2. Go to **https://app.netlify.com/drop**, sign up (free), and **drag the `dist` folder** onto the page.
3. Netlify gives you a link like `https://random-name.netlify.app`. You can rename it under **Site configuration → Change site name** (e.g. `greenvalley-farm.netlify.app`).
4. **To update the app later:** run `npm run build` again, open your site in Netlify → **Deploys** → drag the new `dist` folder onto the box.

## Step 10 — Install on phones

On each phone, open the Netlify link in **Chrome** → ⋮ menu → **Add to Home screen** / **Install app**. The app then opens full-screen like a normal app.

---

### If something goes wrong

| Problem | Fix |
|---|---|
| Red box "App is not connected to Supabase" | The `.env` file is missing or has typos. Check Step 6, then stop (Ctrl+C) and run `npm run dev` again. For the online version, rebuild and re-upload `dist`. |
| "Wrong mobile number or password" for the owner | In Supabase → Authentication → Users, check the email is exactly `91XXXXXXXXXX@farm.local`. You can set a new password there (⋮ → *Reset password* is email-based and won't work, so use **Update user / Change password** instead). |
| "This login is not set up yet" | Step 4.3 (`bootstrap_owner`) wasn't run, or the number in it didn't match the login email. |
| Adding a user says "Only the owner can manage users" or "Please log in again" | Log out and in again. Check Step 5.5 (JWT verification off). |
| Adding a user says "Could not reach the server" | The function isn't deployed or its name isn't exactly `admin-users` (Step 5). |
| Owner forgot their password | Supabase dashboard → Authentication → Users → click the owner → change password. |
