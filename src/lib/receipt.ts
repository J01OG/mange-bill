import { supabase } from './supabase';
import { formatPaise, formatIST } from './money';
import { formatQty, local, type Unit } from './data';

export interface Receipt {
  bill_no: string;
  created_at: string;
  customer_name: string | null;
  subtotal_paise: number;
  discount_paise: number;
  tax_paise: number;
  total_paise: number;
  status: 'active' | 'void';
  coupon_code?: string | null;
  returns?: { return_no: string; created_at: string; amount_paise: number; refund_mode: 'cash' | 'upi' }[];
  items: {
    name: string;
    unit: Unit;
    qty: number;
    price_paise: number;
    gst_rate_bp: number;
    tax_paise: number;
    line_total_paise: number;
  }[];
  payments: { mode: 'cash' | 'upi' | 'advance'; amount_paise: number }[];
  farm: {
    name: string;
    address: string;
    phone: string;
    gstin: string | null;
    prices_include_gst: boolean;
    footer: string;
  };
}

export type Paper = '58' | '80' | 'a4';
export const PAPER_LABEL: Record<Paper, string> = { '58': '58 mm', '80': '80 mm', a4: 'A4' };

export async function fetchReceipt(token: string): Promise<Receipt | null> {
  const { data, error } = await supabase.rpc('get_public_bill', { p_token: token });
  if (error) throw error;
  return (data as Receipt | null) ?? null;
}

export const MODE_LABEL = { cash: 'Cash', upi: 'UPI', advance: 'Advance' } as const;

export function shareLink(token: string): string {
  return `${window.location.origin}/b/${token}`;
}

/** Text for WhatsApp. *stars* make bold text in WhatsApp. */
export function whatsappText(r: Receipt, link: string): string {
  const lines = [
    `*${r.farm.name}*`,
    `Bill ${r.bill_no} · ${formatIST(r.created_at)}`,
    '',
    ...r.items.map((i) => `${i.name} × ${formatQty(i.qty, i.unit)} = ${formatPaise(i.line_total_paise)}`),
    '',
  ];
  if (r.discount_paise > 0)
    lines.push(`Discount${r.coupon_code ? ` (${r.coupon_code})` : ''}: −${formatPaise(r.discount_paise)}`);
  lines.push(`*Total: ${formatPaise(r.total_paise)}*`);
  lines.push(`Paid: ${r.payments.map((p) => `${MODE_LABEL[p.mode]} ${formatPaise(p.amount_paise)}`).join(', ') || '—'}`);
  for (const x of r.returns ?? []) lines.push(`Returned ${x.return_no}: −${formatPaise(x.amount_paise)} (${MODE_LABEL[x.refund_mode]} refund)`);
  if (r.status === 'void') lines.push('*THIS BILL WAS CANCELLED*');
  lines.push('', `View / print: ${link}`, '', r.farm.footer);
  return lines.join('\n');
}

export function whatsappUrl(phone: string, text: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

export function savedPaper(): Paper {
  const p = local.get('paper');
  return p === '58' || p === '80' || p === 'a4' ? p : '58';
}

/** Sets the page size for the chosen paper, then opens the browser's print dialog. */
export function printReceipt(paper: Paper) {
  local.set('paper', paper);
  let style = document.getElementById('page-size') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'page-size';
    document.head.appendChild(style);
  }
  style.textContent =
    paper === 'a4' ? '@page { size: A4; margin: 12mm; }' : `@page { size: ${paper}mm auto; margin: 0; }`;
  document.documentElement.dataset.paper = paper;
  window.print();
}
