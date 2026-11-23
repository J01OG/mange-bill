import { useEffect, useState, type FormEvent } from 'react';
import { Backups } from '../components/Backups';
import { Alert, Button, Card, Field, Input, Spinner } from '../components/ui';
import { friendlyError, useSettings, type Settings } from '../lib/data';
import { supabase } from '../lib/supabase';

export function SettingsPage() {
  const { settings, reload } = useSettings();
  const [form, setForm] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{
    kind: 'error' | 'success';
    text: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  if (!form) return <Spinner />;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const prefix = form.bill_prefix.trim().toUpperCase();
    if (!/^[A-Z]{1,5}$/.test(prefix))
      return setMsg({
        kind: 'error',
        text: 'Bill prefix must be 1–5 letters, like MF.',
      });
    setBusy(true);
    const { error } = await supabase
      .from('app_settings')
      .update({
        farm_name: form.farm_name.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        gstin: form.gstin?.trim().toUpperCase() || null,
        prices_include_gst: form.prices_include_gst,
        upi_id: form.upi_id?.trim() || null,
        bill_prefix: prefix,
        bill_footer: form.bill_footer.trim(),
        allow_bargain: form.allow_bargain ?? true,
      })
      .eq('id', true);
    setBusy(false);
    if (error) setMsg({ kind: 'error', text: friendlyError(error) });
    else {
      setMsg({ kind: 'success', text: 'Settings saved.' });
      reload();
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <h2 className="text-xl font-bold">Farm settings</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <Card className="space-y-3">
        <h3 className="font-semibold">Printed on every bill</h3>
        <Field label="Farm name">
          <Input value={form.farm_name} onChange={(e) => set('farm_name', e.target.value)} required maxLength={80} />
        </Field>
        <Field label="Address">
          <Input value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={200} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} maxLength={40} />
        </Field>
        <Field label="Message at the bottom of the bill">
          <Input value={form.bill_footer} onChange={(e) => set('bill_footer', e.target.value)} maxLength={120} />
        </Field>
      </Card>

      <Card className="space-y-3">
        <h3 className="font-semibold">GST</h3>
        <Field label="GSTIN (leave empty if not registered)">
          <Input value={form.gstin ?? ''} onChange={(e) => set('gstin', e.target.value)} maxLength={15} />
        </Field>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="h-6 w-6 accent-brand-700"
            checked={form.prices_include_gst}
            onChange={(e) => set('prices_include_gst', e.target.checked)}
          />
          <span>Product prices already include GST</span>
        </label>
      </Card>

      <Card className="space-y-3">
        <h3 className="font-semibold">Payments and bills</h3>
        <label className="flex min-h-12 items-center gap-3">
          <input
            type="checkbox"
            className="h-6 w-6 accent-brand-700"
            checked={form.allow_bargain ?? true}
            onChange={(e) => set('allow_bargain', e.target.checked)}
          />
          <span>
            Cashiers can bargain (change the rate on a bill)
            <span className="block text-sm text-gray-500">You can always bargain. Every bargained bill shows the normal price.</span>
          </span>
        </label>
        <Field label="UPI ID for the scan-to-pay QR (optional)" hint="Example: greenvalley@okaxis">
          <Input value={form.upi_id ?? ''} onChange={(e) => set('upi_id', e.target.value)} maxLength={60} />
        </Field>
        <Field label="Bill number prefix" hint="Bills look like MF/25-26/000123. Changing it starts a new series.">
          <Input value={form.bill_prefix} onChange={(e) => set('bill_prefix', e.target.value)} maxLength={5} />
        </Field>
        <p className="text-xs text-gray-500">The daily report's time and email list are under Home → Reports.</p>
      </Card>

      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </Button>

      <Backups />
    </form>
  );
}
