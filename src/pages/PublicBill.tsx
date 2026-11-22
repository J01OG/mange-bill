import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PrintableReceipt } from '../components/BillActions';
import { Alert, Spinner } from '../components/ui';
import { fetchReceipt, type Receipt } from '../lib/receipt';

/** The page a customer opens from the WhatsApp link. No login needed. */
export function PublicBill() {
  const { token } = useParams();
  const [r, setR] = useState<Receipt | null | undefined>(undefined);

  useEffect(() => {
    fetchReceipt(token ?? '').then(setR, () => setR(null));
  }, [token]);

  return (
    <div className="mx-auto max-w-md p-4">
      {r === undefined ? <Spinner /> : r === null ? <Alert>This bill link is not valid.</Alert> : <PrintableReceipt r={r} />}
    </div>
  );
}
