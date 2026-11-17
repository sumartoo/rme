'use client';
import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type Trend = { date: string; visits: number; cash: string }[];
const short = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt` : n >= 1000 ? `${Math.round(n / 1000)} rb` : String(n));

/**
 * Grafik tren 14 hari (Recharts, DEC-016/OD-046). Digambar hanya di browser (setelah mount): markup SVG Recharts memakai atribut style
 * yang ditolak CSP ketat bila ikut dirender di server. Tabel ringkas di bawah grafik untuk pembaca layar.
 */
export function TrendCharts({ trend }: { trend: Trend }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const data = trend.map((t) => ({ label: short(t.date), visits: t.visits, cash: Number(t.cash) }));
  return (
    <div className="grid gap-4" data-testid="dashboard-trend">
      <div className="grid gap-4 lg:grid-cols-2">
        <figure className="h-56" aria-label="Grafik kunjungan 14 hari">
          <figcaption className="mb-1 text-xs text-muted-foreground">Kunjungan per hari</figcaption>
          {mounted ? (
            <ResponsiveContainer width="100%" height="90%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [v as number, 'Kunjungan']} />
                <Bar dataKey="visits" fill="#2563eb" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          ) : null}
        </figure>
        <figure className="h-56" aria-label="Grafik penerimaan kas 14 hari">
          <figcaption className="mb-1 text-xs text-muted-foreground">Penerimaan kas bersih per hari</figcaption>
          {mounted ? (
            <ResponsiveContainer width="100%" height="90%">
              <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={1} />
                <YAxis tickFormatter={compact} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => [rupiah(v as number), 'Kas']} />
                <Line type="monotone" dataKey="cash" stroke="#059669" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : null}
        </figure>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Angka tren (tabel)</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead><tr><th>Tanggal</th><th className="text-right">Kunjungan</th><th className="text-right">Kas</th></tr></thead>
          <tbody>{trend.map((t) => <tr key={t.date} data-testid="trend-row"><td>{t.date}</td><td className="text-right">{t.visits}</td><td className="text-right">{rupiah(Number(t.cash))}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  );
}
