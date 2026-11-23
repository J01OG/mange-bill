import { createPortal } from 'react-dom';
import { formatQty } from '../lib/data';
import { formatIST, formatPaise } from '../lib/money';
import { MODE_LABEL, type Paper, type Receipt } from '../lib/receipt';

/**
 * The bill itself. The same layout is used on screen, in the print-out and on the share page.
 * Thermal paper (58/80 mm) uses a narrow two-line layout; A4 uses a table.
 */
export function ReceiptView({ r, paper }: { r: Receipt; paper: Paper }) {
  const thermal = paper !== 'a4';
  const gstLabel =
    r.tax_paise === 0 ? 'GST' : r.farm.prices_include_gst ? 'GST (included)' : 'GST';

  return (
    <div className="receipt" data-paper={paper}>
      <div className="text-center">
        <div className="r-title">{r.farm.name}</div>
        {r.farm.address && <div>{r.farm.address}</div>}
        {r.farm.phone && <div>Ph: {r.farm.phone}</div>}
        {r.farm.gstin && <div>GSTIN: {r.farm.gstin}</div>}
      </div>
      <hr />
      {r.status === 'void' && <div className="r-void">*** CANCELLED (VOID) ***</div>}
      <div className="r-row">
        <span>Bill: {r.bill_no}</span>
      </div>
      <div>{formatIST(r.created_at)}</div>
      {r.customer_name && <div>Customer: {r.customer_name}</div>}
      <hr />

      {thermal ? (
        <div>
          {r.items.map((i, n) => (
            <div key={n} className="r-item">
              <div className="r-name">{i.name}</div>
              <div className="r-row">
                <span>
                  {formatQty(i.qty, i.unit)} × {formatPaise(i.price_paise)}
                  {i.unit === 'kg' ? '/kg' : ''}
                </span>
                <span>{formatPaise(i.line_total_paise)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="r-table">
          <thead>
            <tr>
              <th className="text-left">Item</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>GST</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {r.items.map((i, n) => (
              <tr key={n}>
                <td className="text-left">{i.name}</td>
                <td>{formatQty(i.qty, i.unit)}</td>
                <td>{formatPaise(i.price_paise)}</td>
                <td>{i.gst_rate_bp / 100}%</td>
                <td>{formatPaise(i.line_total_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <hr />

      <div className="r-row">
        <span>Subtotal</span>
        <span>{formatPaise(r.subtotal_paise)}</span>
      </div>
      {r.discount_paise > 0 && (
        <div className="r-row">
          <span>Discount{r.coupon_code ? ` (${r.coupon_code})` : ''}</span>
          <span>−{formatPaise(r.discount_paise)}</span>
        </div>
      )}
      <div className="r-row">
        <span>{gstLabel}</span>
        <span>{r.tax_paise === 0 ? 'Nil' : formatPaise(r.tax_paise)}</span>
      </div>
      <div className="r-row r-total">
        <span>TOTAL</span>
        <span>{formatPaise(r.total_paise)}</span>
      </div>
      {r.payments.map((p, n) => (
        <div key={n} className="r-row">
          <span>Paid by {MODE_LABEL[p.mode]}</span>
          <span>{formatPaise(p.amount_paise)}</span>
        </div>
      ))}
      {(r.returns ?? []).length > 0 && (
        <>
          <hr />
          {r.returns!.map((x) => (
            <div key={x.return_no} className="r-row">
              <span>
                Returned {x.return_no} ({MODE_LABEL[x.refund_mode]})
              </span>
              <span>−{formatPaise(x.amount_paise)}</span>
            </div>
          ))}
          <div className="r-row r-name">
            <span>Net after returns</span>
            <span>{formatPaise(r.total_paise - r.returns!.reduce((s, x) => s + x.amount_paise, 0))}</span>
          </div>
        </>
      )}
      <hr />
      <div className="text-center">{r.farm.footer}</div>
    </div>
  );
}

/** Renders the bill outside the app so only the bill is printed. */
export function PrintArea({ r, paper }: { r: Receipt; paper: Paper }) {
  return createPortal(
    <div id="print-root">
      <ReceiptView r={r} paper={paper} />
    </div>,
    document.body,
  );
}
