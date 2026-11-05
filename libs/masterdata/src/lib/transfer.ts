import ExcelJS from 'exceljs';
import { parseCsvRows } from '@clinicrme/db/reference';
import { problem } from '@clinicrme/shared';

/** OD-083: CSV (UTF-8) atau XLSX, maks 5.000 baris data / 5 MB. */
export const MAX_ROWS = 5000;
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_TYPE = 'text/csv';

export interface Sheet { header: string[]; rows: { row: number; values: Record<string, string> }[] }

/** Nilai sel XLSX → teks: tanggal → YYYY-MM-DD, rumus → hasilnya, rich text → teks polos. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
    if ('text' in v) return String((v as ExcelJS.CellHyperlinkValue).text);
    if ('error' in v) return '';
  }
  return String(v);
}

export async function readSheet(body: Buffer, contentType: string): Promise<Sheet> {
  let grid: string[][];
  if (contentType.startsWith(XLSX_TYPE)) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(body as unknown as ArrayBuffer); } catch { throw problem(400, 'MST-400-FILE', 'Berkas Excel tidak dapat dibaca'); }
    const ws = wb.worksheets[0];
    if (!ws) throw problem(400, 'MST-400-FILE', 'Berkas Excel tidak berisi lembar kerja');
    if (ws.rowCount > MAX_ROWS + 1) throw problem(400, 'MST-400-ROWS', `Maksimal ${MAX_ROWS} baris data per impor`);
    grid = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(ws.columnCount, 50); c++) cells.push(cellText(r.getCell(c).value).trim());
      grid[n - 1] = cells;
    });
    grid = Array.from(grid, (r) => r ?? []);
  } else if (contentType.startsWith(CSV_TYPE)) {
    let text = body.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);                  // BOM dari Excel
    const nl = text.search(/\r?\n/);
    const first = nl < 0 ? text : text.slice(0, nl);
    const delimiter = first.includes(';') && !first.includes(',') ? ';' : ',';  // Excel lokal Indonesia memakai titik koma
    grid = parseCsvRows(text, delimiter).map((r) => r.map((c) => c.trim()));
  } else {
    throw problem(415, 'MST-415-TYPE', 'Format berkas harus CSV (text/csv) atau Excel (.xlsx)');
  }
  const [header = [], ...data] = grid;
  if (!header.some(Boolean)) throw problem(400, 'MST-400-HEADER', 'Baris pertama harus berisi nama kolom');
  const rows = data.map((cells, i) => ({ row: i + 2, values: Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ''])) }))
    .filter((r) => Object.values(r.values).some((v) => v !== ''));
  if (rows.length > MAX_ROWS) throw problem(400, 'MST-400-ROWS', `Maksimal ${MAX_ROWS} baris data per impor`);
  return { header: header.map((h) => h.trim()), rows };
}

/** CSV aman dibuka di Excel: BOM UTF-8; nilai yang diawali = + - @ diberi petik agar tidak dieksekusi sebagai rumus. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): Buffer {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

/** XLSX: semua nilai ditulis sebagai teks (tidak pernah sebagai rumus). */
export async function toXlsx(sheetName: string, columns: string[], rows: Record<string, unknown>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ClinicRME';
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.addRow(columns).font = { bold: true };
  for (const r of rows) ws.addRow(columns.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))));
  ws.columns.forEach((c) => { c.width = 18; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Boolean dari spreadsheet: kosong → undefined (pakai bawaan). */
export function parseBool(v: string): boolean | undefined {
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  if (['true', 'ya', 'y', '1', 'aktif'].includes(s)) return true;
  if (['false', 'tidak', 't', 'n', '0', 'nonaktif'].includes(s)) return false;
  throw new Error('Nilai harus ya/tidak');
}
