/** Turns "98765 43210", "+91 98765-43210" etc. into "919876543210", or null if invalid. */
export function normalisePhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const p = digits.length === 10 ? `91${digits}` : digits;
  return /^91[6-9]\d{9}$/.test(p) ? p : null;
}

/** Login email hidden behind the phone-number screen. */
export function phoneToEmail(phone: string): string {
  return `${phone}@farm.local`;
}

/** "919876543210" -> "98765 43210" */
export function displayPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const local = phone.startsWith('91') ? phone.slice(2) : phone;
  return `${local.slice(0, 5)} ${local.slice(5)}`;
}
