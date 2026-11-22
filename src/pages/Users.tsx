import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input, Select, Sheet, Spinner } from '../components/ui';
import { callFunction, supabase } from '../lib/supabase';
import { displayPhone, normalisePhone } from '../lib/phone';
import { ROLE_LABEL, type Profile, type Role } from '../lib/types';

const ROLES: Role[] = ['cashier', 'worker', 'customer', 'owner'];

export function Users() {
  const { profile: me } = useAuth();
  const [users, setUsers] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('profiles').select('*').order('active', { ascending: false }).order('full_name');
    if (error) setError(error.message);
    else setUsers(data as Profile[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function done(message: string) {
    setAdding(false);
    setEditing(null);
    setFlash(message);
    load();
  }

  const q = filter.trim().toLowerCase();
  const shown = (users ?? []).filter(
    (u) => !q || u.full_name.toLowerCase().includes(q) || u.phone.includes(q.replace(/\D/g, '') || '§'),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Users</h2>
        <Button onClick={() => setAdding(true)}>+ Add user</Button>
      </div>

      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert>{error}</Alert>}

      <Input placeholder="Search name or mobile" value={filter} onChange={(e) => setFilter(e.target.value)} />

      {!users ? (
        <Spinner />
      ) : (
        <ul className="space-y-2">
          {shown.map((u) => (
            <li key={u.id}>
              <button className="w-full text-left" onClick={() => setEditing(u)}>
                <Card className={`flex items-center justify-between ${u.active ? '' : 'opacity-60'}`}>
                  <div>
                    <div className="font-semibold">
                      {u.full_name} {u.id === me?.id && <span className="text-sm text-gray-500">(you)</span>}
                    </div>
                    <div className="text-sm text-gray-600">{displayPhone(u.phone)}</div>
                  </div>
                  <div className="text-right text-sm">
                    <div className="font-medium text-brand-800">{ROLE_LABEL[u.role]}</div>
                    {!u.active && <div className="text-red-700">Disabled</div>}
                  </div>
                </Card>
              </button>
            </li>
          ))}
          {shown.length === 0 && <p className="text-center text-gray-500">No users found.</p>}
        </ul>
      )}

      {adding && <AddUser onClose={() => setAdding(false)} onDone={done} />}
      {editing && <EditUser user={editing} isMe={editing.id === me?.id} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  );
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('cashier');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = normalisePhone(phone);
    if (!p) return setError('Enter a valid 10-digit mobile number.');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    setBusy(true);
    setError(null);
    try {
      await callFunction('admin-users', { action: 'create', full_name: name, phone: p, role, password });
      onDone(`${name} added. They can log in with ${displayPhone(p)} and the password you set.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet title="Add user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Field label="Full name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Field label="Mobile number">
          <Input type="tel" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Password" hint="At least 6 characters. Tell it to the person; they can change it later.">
          <Input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Adding…' : 'Add user'}
        </Button>
      </form>
    </Sheet>
  );
}

function EditUser({
  user,
  isMe,
  onClose,
  onDone,
}: {
  user: Profile;
  isMe: boolean;
  onClose: () => void;
  onDone: (m: string) => void;
}) {
  const [role, setRole] = useState<Role>(user.role);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(body: Record<string, unknown>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await callFunction('admin-users', { user_id: user.id, ...body });
      onDone(message);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet title={user.full_name} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm text-gray-600">
          {displayPhone(user.phone)} · {ROLE_LABEL[user.role]} · {user.active ? 'Active' : 'Disabled'}
        </p>
        {error && <Alert>{error}</Alert>}

        <section className="space-y-2">
          <Field label="Role" hint="To make a worker a cashier, change their role here.">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={isMe}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy || role === user.role}
            onClick={() => run({ action: 'set_role', role }, `${user.full_name} is now ${ROLE_LABEL[role]}.`)}
          >
            Save role
          </Button>
        </section>

        <section className="space-y-2">
          <Field label="Set a new password">
            <Input type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy || password.length < 6}
            onClick={() => run({ action: 'reset_password', password }, `Password changed for ${user.full_name}.`)}
          >
            Reset password
          </Button>
        </section>

        {!isMe && (
          <Button
            variant={user.active ? 'danger' : 'primary'}
            className="w-full"
            disabled={busy}
            onClick={() => {
              if (user.active && !confirm(`Disable ${user.full_name}? They will not be able to log in.`)) return;
              run(
                { action: 'set_active', active: !user.active },
                `${user.full_name} is now ${user.active ? 'disabled' : 'active again'}.`,
              );
            }}
          >
            {user.active ? 'Disable user' : 'Enable user'}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
