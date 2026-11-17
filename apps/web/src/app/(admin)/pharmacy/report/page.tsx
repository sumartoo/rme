import { redirect } from 'next/navigation';

/** Dipindah ke menu Laporan (Stage 14 batch 3). */
export default function Moved() {
  redirect('/reports/stock');
}
