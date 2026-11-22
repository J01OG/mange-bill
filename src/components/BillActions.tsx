import { useState } from 'react';
import { PrintArea, ReceiptView } from './ReceiptView';
import { Button } from './ui';
import { PAPER_LABEL, printReceipt, savedPaper, type Paper, type Receipt } from '../lib/receipt';

/** Bill on screen + paper-size choice + Print button. */
export function PrintableReceipt({ r }: { r: Receipt }) {
  const [paper, setPaper] = useState<Paper>(savedPaper);

  return (
    <div className="space-y-3">
      <div className="mx-auto max-w-sm rounded-xl bg-white p-4 shadow ring-1 ring-gray-200">
        <ReceiptView r={r} paper={paper} />
      </div>

      <div className="mx-auto flex max-w-sm gap-2">
        {(Object.keys(PAPER_LABEL) as Paper[]).map((p) => (
          <button
            key={p}
            onClick={() => setPaper(p)}
            className={`min-h-11 flex-1 rounded-xl text-sm font-semibold ring-1 ${
              paper === p ? 'bg-brand-800 text-white ring-brand-800' : 'bg-white text-gray-700 ring-gray-300'
            }`}
          >
            {PAPER_LABEL[p]}
          </button>
        ))}
      </div>
      <Button className="mx-auto block w-full max-w-sm" variant="secondary" onClick={() => printReceipt(paper)}>
        🖨️ Print ({PAPER_LABEL[paper]})
      </Button>

      <PrintArea r={r} paper={paper} />
    </div>
  );
}
