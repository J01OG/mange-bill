import { useEffect, useState } from 'react';

/** Scan-to-pay QR that any UPI app (GPay, PhonePe, Paytm…) can read. Amount is pre-filled. */
export function UpiQr({ upiId, payee, amountPaise, note }: { upiId: string; payee: string; amountPaise: number; note: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      pa: upiId,
      pn: payee,
      am: (amountPaise / 100).toFixed(2),
      cu: 'INR',
      tn: note,
    });
    // The QR library loads only the first time a QR is needed.
    import('qrcode')
      .then((m) => m.default.toDataURL(`upi://pay?${params.toString()}`, { margin: 1, width: 240 }))
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [upiId, payee, amountPaise, note]);

  if (!src) return null;
  return (
    <div className="flex flex-col items-center gap-1">
      <img src={src} alt="UPI QR code" width={200} height={200} className="rounded-lg ring-1 ring-gray-200" />
      <span className="text-xs text-gray-500">Customer scans with any UPI app · {upiId}</span>
    </div>
  );
}
