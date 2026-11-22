import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Field, Input } from '../components/ui';
import { normalisePhone } from '../lib/phone';
import { t } from '../lib/i18n';
import { configMissing, DEMO } from '../lib/supabase';

export function Login() {
  const { signIn, notice } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = normalisePhone(phone);
    if (!p) return setError(t('badPhone'));
    setBusy(true);
    setError(await signIn(p, password));
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-brand-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow">
        <div className="text-center">
          <div className="text-5xl" aria-hidden>
            🍄
          </div>
          <h1 className="mt-2 text-2xl font-bold text-brand-900">{t('appName')}</h1>
        </div>

        {configMissing && (
          <Alert>App is not connected to Supabase yet. Create the .env file (see setup guide) and rebuild.</Alert>
        )}
        {DEMO && (
          <Alert kind="info">
            Demo mode (made-up data, nothing is saved). Mobile 90000 00001 = owner, 90000 00002 = cashier, 90000 00003 = worker. Any password.
          </Alert>
        )}
        {notice && <Alert>{notice}</Alert>}
        {error && <Alert>{error}</Alert>}

        <Field label={t('mobile')}>
          <div className="flex">
            <span className="flex min-h-12 items-center rounded-l-xl border border-r-0 border-gray-300 bg-gray-50 px-3 text-gray-600">
              +91
            </span>
            <Input
              className="rounded-l-none"
              type="tel"
              inputMode="numeric"
              autoComplete="username"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
        </Field>

        <Field label={t('password')}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t('loggingIn') : t('login')}
        </Button>
        <p className="text-center text-sm text-gray-500">{t('forgot')}</p>
      </form>
    </div>
  );
}
