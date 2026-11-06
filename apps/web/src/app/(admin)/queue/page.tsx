'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { QueueTicket, ServiceUnit, api, errorText } from '../../../lib/api';
import { TICKET_STATUS, fmtDateTime } from '../../../lib/format';

const UNIT_KEY = 'crme.queue.unit';
const read = () => { try { return localStorage.getItem(UNIT_KEY) ?? ''; } catch { return ''; } };
const save = (v: string) => { try { localStorage.setItem(UNIT_KEY, v); } catch { /* penyimpanan peramban tidak tersedia */ } };

/**
 * Panggil antrean poli (SCH-FR-008): panggil berikutnya (urutan layanan: walk-in & terlambat = waktu datang, janji
 * tepat waktu = jam slot — OD-087), panggil ulang, lewati. Daftar diperbarui tiap 10 detik (layar TV realtime di batch 4).
 */
export default function QueuePage() {
  const [units, setUnits] = useState<ServiceUnit[]>([]);
  const [unit, setUnit] = useState('');
  const [items, setItems] = useState<QueueTicket[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<ServiceUnit[]>('/service-units').then((u) => {
      const list = u.filter((x) => x.unitType !== 'FARMASI' && x.unitType !== 'KASIR');
      setUnits(list);
      const last = read();
      setUnit(list.some((x) => x.id === last) ? last : list[0]?.id ?? '');
    }).catch((e) => setError(errorText(e, 'Gagal memuat poli')));
  }, []);
  const load = useCallback(async () => {
    if (!unit) return;
    try { setItems(await api<QueueTicket[]>(`/queue?unitId=${unit}`)); setError(undefined); }
    catch (e) { setError(errorText(e, 'Gagal memuat antrean')); }
  }, [unit]);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 10_000); return () => clearInterval(t); }, [load]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await fn(); await load(); } catch (e) { setError(errorText(e, 'Gagal')); await load(); } finally { setBusy(false); }
  }
  const called = items?.filter((t) => t.status === 'CALLED') ?? [];
  const waiting = items?.filter((t) => t.status === 'WAITING').length ?? 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Antrean</h1>
        <Select aria-label="Poli" className="w-56" value={unit} onChange={(e) => { setUnit(e.target.value); save(e.target.value); }}>
          {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </Select>
        <span className="text-sm text-muted-foreground">{waiting} menunggu</span>
        <Button className="ml-auto" size="lg" loading={busy} disabled={!unit || waiting === 0}
                onClick={() => void act(() => api('/queue/call-next', { method: 'POST', body: { unitId: unit } }))}>Panggil berikutnya</Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {called.length > 0 ? (
        <div className="flex flex-wrap gap-3" data-testid="now-calling">
          {called.slice(0, 3).map((t) => (
            <Card key={t.id} className="min-w-56 border-amber-300">
              <CardContent className="pt-4">
                <div className="font-mono text-4xl font-bold">{t.displayCode}</div>
                <div className="text-sm">{t.patient.fullName}</div>
                <div className="text-xs text-muted-foreground">{t.practitionerName} · dipanggil {t.callCount}×</div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Belum ada antrean hari ini di poli ini.</p>
          ) : (
            <Table>
              <THead><TR><TH>Nomor</TH><TH>Pasien</TH><TH>Dokter</TH><TH>Jenis</TH><TH>Status</TH><TH /></TR></THead>
              <TBody>
                {items.map((t) => (
                  <TR key={t.id} data-testid="queue-row">
                    <TD className="font-mono text-lg font-semibold">{t.displayCode}</TD>
                    <TD>{t.patient.fullName} <span className="font-mono text-xs text-muted-foreground">{t.patient.mrn}</span></TD>
                    <TD className="text-xs">{t.practitionerName ?? '—'}</TD>
                    <TD className="text-xs">{t.arrivalType === 'WALK_IN' ? 'Walk-in' : 'Janji temu'}{t.arrivedLate ? ' · terlambat' : ''}</TD>
                    <TD><Badge tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</Badge>
                      {t.calledAt ? <span className="block text-xs text-muted-foreground">{fmtDateTime(t.calledAt)}</span> : null}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {['WAITING', 'SKIPPED', 'CALLED'].includes(t.status) ? (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => api(`/queue/${t.id}/call`, { method: 'POST' }))}>
                          {t.status === 'CALLED' ? 'Panggil ulang' : 'Panggil'}
                        </Button>
                      ) : null}{' '}
                      {['WAITING', 'CALLED'].includes(t.status) ? (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`/queue/${t.id}/skip`, { method: 'POST' }))}>Lewati</Button>
                      ) : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
