import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { Alert, Button, Card, Field, Input, Select } from '../components/ui';
import { supabase } from '../lib/supabase';
import { displayPhone } from '../lib/phone';
import { t } from '../lib/i18n';
import { ROLE_LABEL, type Lang } from '../lib/types';

export function ProfilePage() {
  const { profile, signOut, reloadProfile } = useAuth();
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!profile) return null;

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw1.length < 6) return setMsg({ kind: 'error', text: t('passwordShort') });
    if (pw1 !== pw2) return setMsg({ kind: 'error', text: t('passwordsDiffer') });
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (error) setMsg({ kind: 'error', text: error.message });
    else {
      setMsg({ kind: 'success', text: t('saved') });
      setPw1('');
      setPw2('');
    }
  }

  async function changeLang(lang: Lang) {
    const { error } = await supabase.rpc('set_my_lang', { p_lang: lang });
    if (error) setMsg({ kind: 'error', text: error.message });
    else await reloadProfile();
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-xl font-bold">{profile.full_name}</div>
        <div className="text-gray-600">{displayPhone(profile.phone)}</div>
        <div className="mt-1 text-sm font-medium text-brand-800">{ROLE_LABEL[profile.role]}</div>
      </Card>

      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card>
        <Field label={t('language')} hint="Hindi and Marathi screens will be added later.">
          <Select value={profile.lang} onChange={(e) => changeLang(e.target.value as Lang)}>
            <option value="en">English</option>
            <option value="hi">हिंदी (Hindi)</option>
            <option value="mr">मराठी (Marathi)</option>
          </Select>
        </Field>
      </Card>

      <Card>
        <form onSubmit={changePassword} className="space-y-3">
          <h3 className="font-semibold">{t('changePassword')}</h3>
          <Field label={t('newPassword')}>
            <Input type="password" autoComplete="new-password" value={pw1} onChange={(e) => setPw1(e.target.value)} />
          </Field>
          <Field label={t('confirmPassword')}>
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <Button type="submit" variant="secondary" className="w-full" disabled={busy}>
            {t('changePassword')}
          </Button>
        </form>
      </Card>

      <Button variant="danger" className="w-full" onClick={signOut}>
        {t('logout')}
      </Button>
    </div>
  );
}
