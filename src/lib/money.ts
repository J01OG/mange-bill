const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

/** 1250 paise -> "₹12.50" */
export function formatPaise(paise: number): string {
  return inr.format((paise || 0) / 100); // `|| 0` also turns −0 into 0, so it never shows "−₹0.00"
}

/** "12.5" -> 1250. Returns null for bad input. */
export function rupeesToPaise(input: string): number | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Current date/time shown in India time. */
export function formatIST(iso: string, withTime = true): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}
