import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { phoneToEmail } from '../lib/phone';
import { setLang, t } from '../lib/i18n';
import type { Profile } from '../lib/types';

interface AuthState {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  notice: string | null;
  signIn: (phone: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  reloadProfile: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    // Keep this callback synchronous: calling Supabase inside it can lock up.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;

  const loadProfile = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error || !data || !data.active) {
      // Say what actually went wrong: a server/setup problem is not a disabled account.
      setNotice(error ? `${t('profileError')} (${error.message})` : !data ? t('noProfile') : t('accountDisabled'));
      setProfile(null);
      await supabase.auth.signOut();
      return;
    }
    setLang(data.lang);
    setProfile(data as Profile);
  }, [userId]);

  useEffect(() => {
    if (session === null) {
      setProfile(null);
      return;
    }
    setLoading(true);
    loadProfile().finally(() => setLoading(false));
  }, [loadProfile, session]);

  const signIn = async (phone: string, password: string) => {
    setNotice(null);
    const { error } = await supabase.auth.signInWithPassword({ email: phoneToEmail(phone), password });
    if (!error) return null;
    if (/banned/i.test(error.message)) return t('accountDisabled');
    if (/invalid login/i.test(error.message)) return t('badLogin');
    return error.message;
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
  };

  return (
    <Ctx.Provider value={{ loading, session, profile, notice, signIn, signOut, reloadProfile: loadProfile }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
