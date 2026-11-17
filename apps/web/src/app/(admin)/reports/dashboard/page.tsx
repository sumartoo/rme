'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Select } from '@clinicrme/ui';
import { api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime, fmtRupiah } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';
import { TrendCharts } from './trend-charts';

export interface DashboardData {
  date: string; timezone: string; allBranches: boolean; generatedAt: string;
  visits: { total: number; waiting: number; inService: number; finished: number };
  queue: { unitId: string; unitName: string; branchName: string; waiting: number }[];
  cash: { payments: string; receivableSettlements: string; refunds: string; net: string };
  unpaid: { invoices: number; amount: string };
  stock: { lowStock: number; expiringSoon: number; expired: number; low: { code: string; drugName: string; usable: number; minStock: number; uomName: string }[] };
  satusehat: { needsAction: number; error: number; dead: number; blocked: number };
  trend: { date: string; visits: number; cash: string }[];
}
const REFRESH_MS = 60_000;

function Tile({ label, value, sub, testId, href }: { label: string; value: React.ReactNode; sub?: React.ReactNode; testId: string; href?: string }) {
  const body = (
    <Card className="h-full" data-testid={testId}>
      <CardContent className="grid gap-1 pt-5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

/**
 * Dashboard manajer hari ini (RPT-FR-009, OD-131): kunjungan per status, antrean menunggu per poli, kas & tagihan belum lunas, stok kritis,
 * SATUSEHAT perlu tindakan, tren 14 hari. Dimuat ulang tiap 60 detik saat halaman terbuka. Tanpa identitas pasien.
 */
export default function DashboardPage() {
  const s = useSession();
  const [branchId, setBranchId] = useState('');
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { setData(await api<DashboardData>(`/dashboard/today${branchId ? `?branchId=${branchId}` : ''}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat dashboard')); }
  }, [branchId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  const d = data;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Dashboard manajer</h1>
          {d ? <p className="text-xs text-muted-foreground" data-testid="dashboard-meta">Hari ini {fmtDate(d.date)} · diperbarui {fmtDateTime(d.generatedAt)} · otomatis tiap 60 detik
            {!d.allBranches ? ' · hanya cabang dalam akses Anda' : ''}</p> : null}
        </div>
        <div className="flex items-end gap-2">
          {s.me.branches.length > 1 ? (
            <label className="grid gap-1 text-xs">Cabang
              <Select aria-label="Cabang" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                <option value="">Semua cabang (sesuai akses)</option>
                {s.me.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </label>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void load()}>Muat ulang</Button>
        </div>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!d ? <p role="status" className="text-sm text-muted-foreground">Memuat…</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile testId="tile-visits" label="Kunjungan hari ini" value={d.visits.total}
              sub={`Menunggu ${d.visits.waiting} · Dilayani ${d.visits.inService} · Selesai ${d.visits.finished}`}
              href={can(s, 'report.operational.read') ? '/reports/visits' : undefined} />
            <Tile testId="tile-cash" label="Penerimaan kas hari ini" value={fmtRupiah(d.cash.net)}
              sub={`Bayar ${fmtRupiah(d.cash.payments)} · Piutang ${fmtRupiah(d.cash.receivableSettlements)} · Refund ${fmtRupiah(d.cash.refunds)}`}
              href={can(s, 'report.finance.read') ? '/reports/revenue' : undefined} />
            <Tile testId="tile-unpaid" label="Tagihan belum lunas (porsi pasien)" value={fmtRupiah(d.unpaid.amount)} sub={`${d.unpaid.invoices} tagihan`} />
            <Tile testId="tile-satusehat" label="SATUSEHAT perlu tindakan" value={d.satusehat.needsAction}
              sub={`Ditolak ${d.satusehat.error} · Gagal ${d.satusehat.dead} · Tertahan ${d.satusehat.blocked}`}
              href={can(s, 'integration.read') ? '/integrations/satusehat/monitoring' : undefined} />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Antrean menunggu per poli</CardTitle></CardHeader>
              <CardContent>
                {d.queue.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada antrean menunggu.</p> : (
                  <ul className="grid gap-1 text-sm" data-testid="dashboard-queue">
                    {d.queue.map((q) => (
                      <li key={q.unitId} className="flex justify-between"><span>{q.unitName} <span className="text-xs text-muted-foreground">· {q.branchName}</span></span>
                        <b className="tabular-nums">{q.waiting}</b></li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card data-testid="dashboard-stock">
              <CardHeader><CardTitle className="text-base">Stok kritis</CardTitle></CardHeader>
              <CardContent className="grid gap-2 text-sm">
                <p>Di bawah stok minimum <b>{d.stock.lowStock}</b> obat · kedaluwarsa ≤ 30 hari <b>{d.stock.expiringSoon}</b> batch ·
                  sudah kedaluwarsa <b className={d.stock.expired ? 'text-destructive' : ''}>{d.stock.expired}</b> batch</p>
                {d.stock.low.length ? (
                  <ul className="grid gap-1">
                    {d.stock.low.map((l) => <li key={l.code} className="flex justify-between"><span>{l.drugName} <span className="text-xs text-muted-foreground">{l.code}</span></span>
                      <span className="tabular-nums">{l.usable} / min {l.minStock} {l.uomName}</span></li>)}
                  </ul>
                ) : null}
                {can(s, 'report.pharmacy.read') ? <Link className="text-xs underline" href="/reports/near-expiry">Lihat obat mendekati kedaluwarsa</Link> : null}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Tren 14 hari</CardTitle></CardHeader>
            <CardContent><TrendCharts trend={d.trend} /></CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
