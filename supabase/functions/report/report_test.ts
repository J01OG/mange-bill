// Local check of the Excel builder (not deployed). Run from the project folder:
//   npm run test:report
// Uses sample-report-data.json, written by `npm run test:db`.
import * as XLSX from 'npm:xlsx@0.18.5';
Deno.env.set('REPORT_TEST', '1'); // stops index.ts from starting its web server
const { buildWorkbook, emailHtml, SHEETS, backupWorkbook, BACKUP_TABLES } = await import('./index.ts');

Deno.test('backup has one sheet per table, JSON for lists, row counts', () => {
  const bytes = backupWorkbook(
    {
      app_settings: [{ id: true, farm_name: 'Farm', report_emails: ['a@b.co', 'c@d.co'] }],
      bills: [{ id: 'b1', bill_no: 'MF/26-27/000001', total_paise: 6000 }, { id: 'b2', bill_no: 'MF/26-27/000002', total_paise: 5000 }],
    },
    '2026-11-21T20:30:00Z',
  );
  const wb = XLSX.read(bytes, { type: 'array' });
  if (wb.SheetNames.length !== BACKUP_TABLES.length + 1) throw new Error(`sheets: ${wb.SheetNames.length}`);
  const settings = XLSX.utils.sheet_to_json(wb.Sheets['app_settings']) as Record<string, unknown>[];
  if (settings[0].report_emails !== '["a@b.co","c@d.co"]') throw new Error(`list not kept: ${settings[0].report_emails}`);
  const about = XLSX.utils.sheet_to_json(wb.Sheets['About this backup']) as Record<string, unknown>[];
  if (about.find((r) => r.Item === 'Rows in bills')?.Value !== 2) throw new Error('row count wrong');
});

const data = JSON.parse(await Deno.readTextFile(new URL('./sample-report-data.json', import.meta.url)));

Deno.test('workbook has all sheets with headings and rows', () => {
  const bytes = buildWorkbook(data);
  if (bytes.length < 2000) throw new Error(`file too small: ${bytes.length} bytes`);
  const wb = XLSX.read(bytes, { type: 'array' });
  if (wb.SheetNames.join('|') !== SHEETS.join('|')) throw new Error(`sheets: ${wb.SheetNames.join(', ')}`);
  type R = Record<string, unknown>;
  const bills = XLSX.utils.sheet_to_json(wb.Sheets['Bills']) as R[];
  if (bills.length !== data.Bills.length) throw new Error('bill count mismatch');
  if (!('Bill no' in bills[0]) || !('Total ₹' in bills[0])) throw new Error('missing columns');
  const summary = XLSX.utils.sheet_to_json(wb.Sheets['Summary']) as R[];
  const sales = summary.find((r) => r.Item === 'Sales ₹');
  if (typeof sales?.Value !== 'number') throw new Error('Sales should be a number Excel can add up');
  const cash = XLSX.utils.sheet_to_json(wb.Sheets['Cash']) as R[];
  if (!cash.length || !('Cash from orders ₹' in cash[0]) || !('Cash in hand ₹' in cash[0])) throw new Error('Cash sheet missing columns');
  const changes = XLSX.utils.sheet_to_json(wb.Sheets['Bill changes']) as R[];
  if (!changes.length || !('Reason' in changes[0])) throw new Error('Bill changes sheet empty');
  Deno.writeFileSync(new URL('./sample-report.xlsx', import.meta.url), bytes);
});

Deno.test('a new section from the database becomes its own sheet', () => {
  const wb = XLSX.read(buildWorkbook({ Summary: [], 'Something new': [{ A: 1 }] }), { type: 'array' });
  if (wb.SheetNames.at(-1) !== 'Something new') throw new Error(wb.SheetNames.join(', '));
});

Deno.test('empty period still gives a readable file', () => {
  const wb = XLSX.read(buildWorkbook({}), { type: 'array' });
  if (wb.SheetNames.length !== SHEETS.length) throw new Error('missing sheets');
});

Deno.test('email body escapes text', () => {
  const html = emailHtml('A & B <Farm>', '1 Jan', { Summary: [{ Item: 'Sales ₹', Value: 10 }] });
  if (!html.includes('A &amp; B &lt;Farm&gt;') || !html.includes('Sales ₹')) throw new Error(html);
});
