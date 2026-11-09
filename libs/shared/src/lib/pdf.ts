/**
 * Render PDF server-side (pdfmake, MIT — OD-093) dengan font standar PDF saja: tidak ada berkas font eksternal dan
 * tidak ada akses URL. Dipakai dokumen medis (Stage 9) dan etiket obat (Stage 10).
 */
/* pdfmake (MIT, OD-093) tidak menyertakan tipe; dipakai di server dengan font standar PDF (tanpa berkas font eksternal). */
interface PdfMake {
  setFonts(f: object): void; setUrlAccessPolicy(fn: (u: string) => boolean): void; setLocalAccessPolicy(fn: (p: string) => boolean): void;
  createPdf(doc: object): { getBuffer(): Promise<Buffer> };
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake') as PdfMake;
const STANDARD = new Set(['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique']);
pdfmake.setFonts({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } });
pdfmake.setUrlAccessPolicy(() => false);                 // tidak pernah mengunduh sumber eksternal
pdfmake.setLocalAccessPolicy((p) => STANDARD.has(p));     // hanya font standar bawaan

export type Content = string | Record<string, unknown> | Content[];

/** PDF deterministik (tanggal pembuatan tetap = waktu terbit) dengan font standar. */
export function renderPdf(content: Content[], meta: { title: string; issuedAt: Date; pageSize?: string | { width: number; height: number | 'auto' };
  pageMargins?: [number, number, number, number]; fontSize?: number }): Promise<Buffer> {
  return pdfmake.createPdf({
    info: { title: meta.title, creator: 'ClinicRME', producer: 'ClinicRME', creationDate: meta.issuedAt },
    pageSize: meta.pageSize ?? 'A4', pageMargins: meta.pageMargins ?? [48, 40, 48, 48],
    defaultStyle: { font: 'Helvetica', fontSize: meta.fontSize ?? 10, lineHeight: 1.25 },
    styles: { title: { fontSize: 13, bold: true, alignment: 'center', margin: [0, 8, 0, 2] }, small: { fontSize: 8, color: '#555555' },
      label: { bold: true }, clinic: { fontSize: 12, bold: true } },
    content,
  }).getBuffer();
}

