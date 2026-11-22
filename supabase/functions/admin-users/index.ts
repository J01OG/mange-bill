// Supabase Edge Function: admin-users
// Owner-only account management: create, reset password, enable/disable, change role.
// The service-role key lives only here (Supabase provides it automatically).
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function -> Via Editor,
// name it "admin-users", paste this whole file, Deploy.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Role = 'owner' | 'cashier' | 'worker' | 'customer';
const ROLES: Role[] = ['owner', 'cashier', 'worker', 'customer'];
const BAN_FOREVER = '876000h'; // ~100 years

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
class UserError extends Error {}

function normalisePhone(input: unknown): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  const p = digits.length === 10 ? `91${digits}` : digits;
  if (!/^91[6-9]\d{9}$/.test(p)) throw new UserError('Enter a valid 10-digit Indian mobile number.');
  return p;
}
function checkPassword(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < 6 || s.length > 72) throw new UserError('Password must be 6 to 72 characters.');
  return s;
}
function checkName(n: unknown): string {
  const s = String(n ?? '').trim();
  if (s.length < 1 || s.length > 100) throw new UserError('Enter a name (up to 100 characters).');
  return s;
}
function checkRole(r: unknown): Role {
  if (!ROLES.includes(r as Role)) throw new UserError('Unknown role.');
  return r as Role;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Who is calling? Must be an active owner.
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller, error: callerErr } = await admin.auth.getUser(jwt);
  if (callerErr || !caller?.user) return reply(401, { error: 'Please log in again.' });
  const { data: me } = await admin.from('profiles').select('role, active').eq('id', caller.user.id).single();
  if (!me || me.role !== 'owner' || !me.active) return reply(403, { error: 'Only the owner can manage users.' });

  try {
    const body = await req.json();
    switch (body.action) {
      case 'create': {
        const phone = normalisePhone(body.phone);
        const full_name = checkName(body.full_name);
        const role = checkRole(body.role);
        const password = checkPassword(body.password);

        const { data: existing } = await admin.from('profiles').select('id').eq('phone', phone).maybeSingle();
        if (existing) throw new UserError('A user with this mobile number already exists.');

        const { data: created, error } = await admin.auth.admin.createUser({
          email: `${phone}@farm.local`,
          password,
          email_confirm: true, // no email is ever sent
          user_metadata: { phone, full_name },
        });
        if (error) throw new UserError(error.message);
        const id = created.user.id;

        const { error: pErr } = await admin.from('profiles').insert({ id, phone, full_name, role });
        if (pErr) {
          await admin.auth.admin.deleteUser(id); // undo the half-created login
          throw new Error(pErr.message);
        }
        await linkRecords(admin, id, phone, full_name, role);
        return reply(200, { ok: true, id });
      }

      case 'reset_password': {
        const password = checkPassword(body.password);
        const { error } = await admin.auth.admin.updateUserById(String(body.user_id), { password });
        if (error) throw new UserError(error.message);
        return reply(200, { ok: true });
      }

      case 'set_active': {
        const id = String(body.user_id);
        const active = Boolean(body.active);
        if (id === caller.user.id && !active) throw new UserError('You cannot disable your own account.');
        if (!active) await guardLastOwner(admin, id);
        const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: active ? 'none' : BAN_FOREVER });
        if (error) throw new UserError(error.message);
        const { error: pErr } = await admin.from('profiles').update({ active }).eq('id', id);
        if (pErr) throw new Error(pErr.message);
        return reply(200, { ok: true });
      }

      case 'set_role': {
        const id = String(body.user_id);
        const role = checkRole(body.role);
        if (id === caller.user.id && role !== 'owner') throw new UserError('You cannot remove your own owner role.');
        if (role !== 'owner') await guardLastOwner(admin, id);
        const { data: p, error } = await admin.from('profiles').update({ role }).eq('id', id).select('phone, full_name').single();
        if (error) throw new Error(error.message);
        await linkRecords(admin, id, p.phone, p.full_name, role);
        return reply(200, { ok: true });
      }

      case 'update_name': {
        const { error } = await admin.from('profiles').update({ full_name: checkName(body.full_name) }).eq('id', String(body.user_id));
        if (error) throw new Error(error.message);
        return reply(200, { ok: true });
      }

      default:
        throw new UserError('Unknown action.');
    }
  } catch (e) {
    if (e instanceof UserError) return reply(400, { error: e.message });
    console.error(e);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
});

// Never leave the farm without an active owner.
async function guardLastOwner(admin: SupabaseClient, userId: string) {
  const { data } = await admin.from('profiles').select('id').eq('role', 'owner').eq('active', true);
  const owners = (data ?? []).map((r: { id: string }) => r.id);
  if (owners.length === 1 && owners[0] === userId) throw new UserError('This is the only owner account.');
}

// Connect a login to the matching worker / customer record (matched by mobile number).
async function linkRecords(admin: SupabaseClient, id: string, phone: string, name: string, role: Role) {
  if (role === 'worker' || role === 'cashier') {
    const { data: w } = await admin.from('workers').select('id, profile_id').eq('phone', phone).maybeSingle();
    if (w && !w.profile_id) await admin.from('workers').update({ profile_id: id }).eq('id', w.id);
    // A worker login with no worker record yet: create a basic one the owner can edit later.
    if (!w && role === 'worker') await admin.from('workers').insert({ profile_id: id, name, phone });
  }
  if (role === 'customer') {
    const { data: c } = await admin.from('customers').select('id, profile_id').eq('phone', phone).maybeSingle();
    if (c && !c.profile_id) await admin.from('customers').update({ profile_id: id }).eq('id', c.id);
    if (!c) await admin.from('customers').insert({ profile_id: id, name, phone });
  }
}
