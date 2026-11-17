import ExcelJS from 'exceljs';
import { renderPdf } from '@clinicrme/shared/pdf';
import { type Column, type ReportResult, csvOf } from './common';

/**
 * Berkas ekspor laporan (OD-128 / DEC-047): XLSX (exceljs), CSV (UTF-8 BOM), PDF A4 lanskap (pdfmake).
 * Watermark di setiap ekspor: nama klinik, nama pengekspor, waktu ekspor, dan "Rahasia — untuk internal klinik".
 */
export type ExportFormat = 'XLSX' | 'CSV' | 'PDF';
export interface ExportMeta { title: string; clinicName: string; exportedBy: string; exportedAt: Date; timezone: string; filters: string }
export const CONTENT_TYPE: Record<ExportFormat, string> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', CSV: 'text/csv; charset=utf-8', PDF: 'application/pdf',
};
export const EXT: Record<ExportFormat, string> = { XLSX: 'xlsx', CSV: 'csv', PDF: 'pdf' };
export const CONFIDENTIAL = 'Rahasia — untuk internal klinik';

const stamp = (m: ExportMeta) =>
  `${new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: m.timezone }).format(m.exportedAt)} (${m.timezone})`;
export const watermarkLine = (m: ExportMeta) => `${CONFIDENTIAL} ${m.clinicName}. Diekspor oleh ${m.exportedBy} pada ${stamp(m)}.`;

function preamble(m: ExportMeta) {
  return [m.title, `Klinik: ${m.clinicName}`, ...(m.filters ? [`Filter: ${m.filters}`] : []), `Diekspor oleh: ${m.exportedBy} — ${stamp(m)}`, CONFIDENTIAL];
}
/** Baris total (kolom pertama "Total", nilai total untuk kolom yang punya total bernama sama). */
function totalRow(cols: Column[], r: ReportResult): Record<string, unknown> | null {
  if (!r.totals) return null;
  const hit = cols.filter((c, i) => i > 0 && r.totals![c.key] !== undefined);
  if (!hit.length) return null;
  return Object.fromEntries(cols.map((c, i) => [c.key, i === 0 ? 'Total' : r.totals![c.key] ?? '']));
}

export async function renderExport(format: ExportFormat, r: ReportResult, m: ExportMeta): Promise<Buffer> {
  const total = totalRow(r.columns, r);
  const data = total ? [...r.rows, total] : r.rows;
  if (format === 'CSV') {
    const esc = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const head = preamble(m).map(esc).join('\r\n');
    return Buffer.from(`\uFEFF${head}\r\n\r\n${csvOf(r.columns, data).replace(/^\uFEFF/, '')}`, 'utf8');
  }
  if (format === 'XLSX') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ClinicRME'; wb.created = m.exportedAt;
    const ws = wb.addWorksheet('Laporan', { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    // Watermark di kop & kaki setiap halaman cetak + di bagian atas lembar
    ws.headerFooter.oddHeader = `&L&8${CONFIDENTIAL}&R&8${m.clinicName}`;
    ws.headerFooter.oddFooter = `&L&8Diekspor oleh ${m.exportedBy} — ${stamp(m)}&R&8Hal. &P/&N`;
    preamble(m).forEach((line, i) => { const row = ws.addRow([line]); row.font = i === 0 ? { bold: true, size: 13 } : { size: 9, color: { argb: 'FF555555' } }; });
    ws.addRow([]);
    const header = ws.addRow(r.columns.map((c) => c.label));
    header.font = { bold: true };
    header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }; c.border = { bottom: { style: 'thin' } }; });
    const headerRow = header.number;
    for (const d of data) {
      const row = ws.addRow(r.columns.map((c) => {
        const v = d[c.key];
        if (v === null || v === undefined || v === '') return null;
        return c.type === 'money' || c.type === 'number' || c.type === 'percent' ? (Number.isFinite(Number(v)) ? Number(v) : v) : String(v);
      }));
      if (d === total) row.font = { bold: true };
    }
    r.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(48, Math.max(10, c.label.length + 2, ...data.slice(0, 200).map((d) => String(d[c.key] ?? '').length + 2)));
      if (c.type === 'money') col.numFmt = '#,##0.00';
      else if (c.type === 'number') col.numFmt = '#,##0.####';
      else if (c.type === 'percent') col.numFmt = '0.0';
    });
    ws.getColumn(1).width = Math.max(ws.getColumn(1).width ?? 10, 14);
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const fmt = (c: Column, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (c.type === 'money') return Number(v).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (c.type === 'number' && Number.isFinite(Number(v))) return Number(v).toLocaleString('id-ID', { maximumFractionDigits: 4 });
    return String(v);
  };
  const right = (c: Column) => c.type === 'money' || c.type === 'number' || c.type === 'percent';
  const small = r.columns.length > 9;
  return renderPdf([
    { text: m.title, style: 'title', alignment: 'left', margin: [0, 0, 0, 2] },
    { text: [`Klinik: ${m.clinicName}`, ...(m.filters ? [`   ·   ${m.filters}`] : [])].join(''), style: 'small', margin: [0, 0, 0, 2] },
    { text: watermarkLine(m), style: 'small', margin: [0, 0, 0, 8] },
    data.length === 0 ? { text: 'Tidak ada data.', italics: true } : {
      table: {
        headerRows: 1, widths: r.columns.map(() => 'auto'),
        body: [
          r.columns.map((c) => ({ text: c.label, bold: true, fillColor: '#e5e7eb', alignment: right(c) ? 'right' : 'left' })),
          ...data.map((d) => r.columns.map((c) => ({ text: fmt(c, d[c.key]), alignment: right(c) ? 'right' : 'left', bold: d === total }))),
        ],
      },
      layout: 'lightHorizontalLines', fontSize: small ? 7 : 8,
    },
  ], { title: m.title, issuedAt: m.exportedAt, pageOrientation: 'landscape', pageMargins: [28, 28, 28, 36], fontSize: small ? 7 : 8,
    watermark: CONFIDENTIAL, footer: `${m.clinicName} · Diekspor oleh ${m.exportedBy} — ${stamp(m)}` });
}
