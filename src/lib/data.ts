import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type Unit = 'kg' | 'packet' | 'piece';

export interface Product {
  id: string;
  name: string;
  local_name: string | null;
  unit: Unit;
  price_paise: number;
  gst_rate_bp: number;
  hsn_code: string | null;
  sort_order: number;
  archived_at: string | null;
}

export interface Settings {
  farm_name: string;
  address: string;
  phone: string;
  gstin: string | null;
  prices_include_gst: boolean;
  upi_id: string | null;
  bill_prefix: string;
  bill_footer: string;
  report_email: string | null;
}

export const UNIT_LABEL: Record<Unit, string> = { kg: 'kg', packet: 'pkt', piece: 'pc' };

/** A random id for each save attempt, so tapping Save twice never saves twice. */
export function newRef(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Today's date in India as YYYY-MM-DD. */
export function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/** Turns a database error into something a person can read. */
export function friendlyError(e: { message?: string } | null | undefined): string {
  const m = e?.message ?? 'Something went wrong.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No internet connection. Please try again.';
  return m;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = useCallback(async () => {
    const { data } = await supabase.from('app_settings').select('*').single();
    if (data) setSettings(data as Settings);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { settings, reload };
}

export function useProducts(includeArchived = false) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    let q = supabase.from('products').select('*').order('sort_order').order('name');
    if (!includeArchived) q = q.is('archived_at', null);
    const { data, error } = await q;
    if (error) setError(friendlyError(error));
    else {
      setError(null);
      setProducts(data as Product[]);
    }
  }, [includeArchived]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { products, error, reload };
}

/** Same arithmetic as create_bill() in the database, for showing totals before saving. */
export function lineAmounts(p: Product, qty: number, pricesIncludeGst: boolean, amountPaise?: number) {
  // "₹100 worth" lines cost exactly the amount asked for; otherwise price × quantity.
  const gross = amountPaise ?? Math.round(p.price_paise * qty);
  const tax = pricesIncludeGst
    ? Math.round((gross * p.gst_rate_bp) / (10000 + p.gst_rate_bp))
    : Math.round((gross * p.gst_rate_bp) / 10000);
  return { gross, tax, line: pricesIncludeGst ? gross : gross + tax };
}

export function formatQty(qty: number, unit: Unit): string {
  const n = Number(qty);
  return unit === 'kg' ? `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} kg` : `${n} ${UNIT_LABEL[unit]}`;
}

/** Remembers small per-device choices (like paper size). Never required to work. */
export const local = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc. */
    }
  },
};
