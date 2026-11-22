import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createMockClient } from '../dev/mockSupabase';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** `npm run demo`: try the screens with made-up data, no Supabase needed. */
export const DEMO = import.meta.env.VITE_DEMO === '1';

export const configMissing = !DEMO && (!url || !anonKey);

export const supabase: SupabaseClient = DEMO
  ? (createMockClient() as SupabaseClient)
  : createClient(url ?? 'http://localhost', anonKey ?? 'missing', {
      auth: { persistSession: true, autoRefreshToken: true },
    });

/** Call an Edge Function and turn any failure into a readable message. */
export async function callFunction<T = unknown>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = 'Could not reach the server. Check your internet and try again.';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.json();
        if (j?.error) message = j.error;
      } catch {
        /* keep default */
      }
    }
    throw new Error(message);
  }
  return data as T;
}
