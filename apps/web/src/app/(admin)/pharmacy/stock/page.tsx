'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Dialog, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { StockDetail, StockLevel, StockList, StockLocation, api, errorText } from '../../../../lib/api';
import { fmtDate, fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

type Filter = 'ALL' | 'LOW' | 'EXPIRING' | 'EXPIRED';
const FILTER_LABEL: Record<Filter, string> = { ALL: 'Semua obat', LOW: 'Stok menipis', EXPIRING: 'Akan kedaluwarsa', EXPIRED: 'Sudah kedaluwarsa' };
const MOVE_LABEL: Record<string, string> = {
  RECEIPT: 'Penerimaan', DISPENSE: 'Dispensing', OTC_SALE: 'Penjualan bebas', RETURN_IN: 'Retur masuk', RETURN_OUT: 'Retur keluar',
  ADJUSTMENT: 'Penyesuaian', OPNAME: 'Opname', TRANSFER_IN: 'Transfer masuk', TRANSFER_OUT: 'Transfer keluar',
};
const qty = (n: number) => n.toLocaleString('id-ID', { maximumFractionDigits: 4 });

/**
 * Posisi stok per obat di cabang aktif (PHM-FR-004, 014): saldo layak pakai, kedaluwarsa terdekat, peringatan stok
 * minimum & kedaluwarsa. Saldo berasal dari ledger mutasi; rincian menampilkan batch per lokasi & mutasi terakhir.
 */
export default function StockPage() {
  const s = useSession();
  const branchId = s.me.activeBranchId ?? '';
  const [locations, setLocations] = useState<StockLocation[]>([]);
  const [locationId, setLocationId] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [q, setQ] = useState('');
  const [data, setData] = useState<StockList>();
  const [error, setError] = useState<string>();
  const [detail, setDetail] = useState<StockLevel>();
  useEffect(() => {
    if (!can(s, 'master.facility.read')) return;
    void api<StockLocation[]>(branchId ? `/stock-locations?branchId=${branchId}` : '/stock-locations').then(setLocations).catch(() => undefined);
  }, [branchId, s]);
  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ filter, limit: '200' });
      if (branchId) p.set('branchId', branchId);
      if (locationId) p.set('locationId', locationId);
      if (q.trim()) p.set('q', q.trim());
      setData(await api<StockList>(`/stock?${p}`)); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal memuat stok')); }
  }, [branchId, locationId, filter, q]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Stok obat</h1>
        <Input aria-label="Cari obat" placeholder="Cari nama atau kode" className="w-64" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Filter stok" className="w-48" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {Object.entries(FILTER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {locations.length > 1 ? (
          <Select aria-label="Lokasi stok" className="w-48" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Semua lokasi</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{branchId ? '' : ` · ${l.branchName}`}{l.isActive ? '' : ' (nonaktif)'}</option>)}
          </Select>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <CardContent className="pt-6">
          {!data ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : data.data.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada obat untuk filter ini.</p> : (
            <>
              <Table>
                <THead><TR><TH>Obat</TH><TH className="text-right">Layak pakai</TH><TH className="text-right">Minimum</TH><TH>Kedaluwarsa terdekat</TH><TH>Peringatan</TH><TH /></TR></THead>
                <TBody>
                  {data.data.map((d) => (
                    <TR key={d.drugItemId} data-testid="stock-row">
                      <TD><span className="font-medium">{d.genericName}</span> <span className="font-mono text-xs text-muted-foreground">{d.code}</span>
                        {d.isActive ? null : <span className="block text-xs text-muted-foreground">Nonaktif</span>}</TD>
                      <TD className="text-right tabular-nums">{qty(d.usable)} <span className="text-xs text-muted-foreground">{d.uomName}</span></TD>
                      <TD className="text-right tabular-nums text-xs">{d.minStock ? qty(d.minStock) : '—'}</TD>
                      <TD className="text-xs">{d.nearestExpiry ? fmtDate(d.nearestExpiry) : '—'}</TD>
                      <TD className="flex flex-wrap gap-1">
                        {d.low ? <Badge tone="warning">Menipis</Badge> : null}
                        {d.expiringQty ? <Badge tone="warning">{qty(d.expiringQty)} akan ED</Badge> : null}
                        {d.expiredQty ? <Badge tone="danger">{qty(d.expiredQty)} sudah ED</Badge> : null}
                      </TD>
                      <TD className="text-right"><Button size="sm" variant="ghost" onClick={() => setDetail(d)}>Rincian</Button></TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="mt-3 text-xs text-muted-foreground">
                “Akan kedaluwarsa” = dalam {data.expiryWarningDays} hari. Batch yang sudah kedaluwarsa tidak dihitung layak pakai dan tidak dapat dikeluarkan.
              </p>
            </>
          )}
        </CardContent>
      </Card>
      {detail ? <DetailDialog item={detail} branchId={branchId} onClose={() => setDetail(undefined)} /> : null}
    </div>
  );
}

function DetailDialog({ item, branchId, onClose }: { item: StockLevel; branchId: string; onClose: () => void }) {
  const [d, setD] = useState<StockDetail>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void api<StockDetail>(`/stock/${item.drugItemId}${branchId ? `?branchId=${branchId}` : ''}`).then(setD).catch((e) => setError(errorText(e, 'Gagal memuat rincian')));
  }, [item.drugItemId, branchId]);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  return (
    <Dialog open onClose={onClose} title={`Stok — ${item.genericName}`}>
      <div className="grid gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}
        {!d ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
          <>
            <section>
              <h3 className="mb-2 text-sm font-medium">Batch per lokasi</h3>
              {d.batches.length === 0 ? <p className="text-sm text-muted-foreground">Tidak ada saldo.</p> : (
                <Table>
                  <THead><TR><TH>Batch</TH><TH>Kedaluwarsa</TH><TH>Lokasi</TH><TH className="text-right">Saldo</TH></TR></THead>
                  <TBody>
                    {d.batches.map((b) => (
                      <TR key={`${b.batchId}-${b.locationId}`} data-testid="batch-row">
                        <TD className="font-mono text-xs">{b.batchNo}</TD>
                        <TD className="text-xs">{fmtDate(b.expiryDate)} {b.expiryDate < today ? <Badge tone="danger">ED</Badge> : null}</TD>
                        <TD className="text-xs">{b.locationName}</TD>
                        <TD className="text-right tabular-nums">{qty(b.qtyOnHand)} {d.uomName}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-sm font-medium">Mutasi terakhir</h3>
              {d.movements.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada mutasi.</p> : (
                <Table>
                  <THead><TR><TH>Waktu</TH><TH>Jenis</TH><TH>Batch · lokasi</TH><TH className="text-right">Jumlah</TH><TH>Oleh</TH></TR></THead>
                  <TBody>
                    {d.movements.map((m) => (
                      <TR key={m.id}>
                        <TD className="text-xs">{fmtDateTime(m.occurredAt)}</TD>
                        <TD className="text-xs">{MOVE_LABEL[m.type] ?? m.type}</TD>
                        <TD className="text-xs">{m.batchNo} · {m.locationName}</TD>
                        <TD className={`text-right tabular-nums ${m.qty < 0 ? 'text-destructive' : ''}`}>{m.qty > 0 ? '+' : ''}{qty(m.qty)}</TD>
                        <TD className="text-xs">{m.actorName ?? '—'}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </section>
          </>
        )}
        <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Tutup</Button></div>
      </div>
    </Dialog>
  );
}
