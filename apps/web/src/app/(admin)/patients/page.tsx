'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Input, Switch, TBody, TD, TH, THead, TR, Table, buttonVariants } from '@clinicrme/ui';
import { Page, PatientSummary, api, errorText } from '../../../lib/api';
import { SEX_LABEL, fmtAge, fmtDate } from '../../../lib/format';
import { can, useSession } from '../../../lib/session';

/**
 * Cari pasien (REG-FR-003): satu kotak untuk nama (toleran salah ketik), No. RM, NIK 16 digit, atau telepon, plus
 * tanggal lahir. Cari dulu sebelum mendaftarkan pasien baru agar tidak terjadi data ganda (REG-FR-004).
 */
export default function PatientsPage() {
  const s = useSession();
  const [q, setQ] = useState('');
  const [dob, setDob] = useState('');
  const [merged, setMerged] = useState(false);
  const [items, setItems] = useState<PatientSummary[]>();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const query = useCallback((cursor?: string) => {
    const p = new URLSearchParams({ limit: '25' });
    if (q.trim()) p.set('q', q.trim());
    if (dob) p.set('birthDate', dob);
    if (merged) p.set('includeMerged', 'true');
    if (cursor) p.set('cursor', cursor);
    return `/patients?${p}`;
  }, [q, dob, merged]);
  const load = useCallback(async () => {
    try {
      const r = await api<Page<PatientSummary>>(query());
      setItems(r.data); setNext(r.page.nextCursor); setError(undefined);
    } catch (e) { setError(errorText(e, 'Gagal mencari pasien')); }
  }, [query]);
  useEffect(() => { const t = setTimeout(() => void load(), 300); return () => clearTimeout(t); }, [load]);
  async function more() {
    if (!next) return;
    try { const r = await api<Page<PatientSummary>>(query(next)); setItems((x) => [...(x ?? []), ...r.data]); setNext(r.page.nextCursor); }
    catch (e) { setError(errorText(e, 'Gagal memuat')); }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Pasien</h1>
        {can(s, 'patient.create') ? <Link href="/patients/new" className={buttonVariants({ className: 'ml-auto' })}>Daftar pasien baru</Link> : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Cari pasien" placeholder="Nama, No. RM, NIK, atau telepon…" className="w-80" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <label className="flex items-center gap-2 text-sm">Tgl lahir
          <Input type="date" aria-label="Tanggal lahir" className="w-44" value={dob} onChange={(e) => setDob(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={merged} onChange={(e) => setMerged(e.target.checked)} aria-label="Tampilkan yang sudah digabung" /> Tampilkan yang sudah digabung</label>
      </div>
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Pasien tidak ditemukan. {can(s, 'patient.create') ? 'Periksa ejaan, atau daftarkan sebagai pasien baru.' : ''}</p>
          ) : (
            <Table>
              <THead><TR><TH>No. RM</TH><TH>Nama</TH><TH>Tgl lahir</TH><TH>Jenis kelamin</TH><TH>Identitas</TH><TH>Telepon</TH><TH /></TR></THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id} data-testid="patient-row">
                    <TD className="font-mono text-xs">{p.mrn}</TD>
                    <TD>
                      <Link className="font-medium hover:underline" href={`/patients/${p.id}`}>{p.fullName}</Link>
                      {p.status === 'MERGED' ? <Badge tone="neutral" className="ml-2">Digabung</Badge> : null}
                    </TD>
                    <TD className="whitespace-nowrap text-xs">{fmtDate(p.birthDate)} <span className="text-muted-foreground">({fmtAge(p.birthDate)})</span></TD>
                    <TD className="text-xs">{SEX_LABEL[p.sex]}</TD>
                    <TD className="font-mono text-xs">{p.nikMasked ?? p.identityMasked ?? '—'}</TD>
                    <TD className="text-xs">{p.phone ?? '—'}</TD>
                    <TD className="text-right"><Link href={`/patients/${p.id}`} className={buttonVariants({ size: 'sm', variant: 'outline' })} aria-label={`Buka ${p.fullName}`}>Buka</Link></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          {next ? <div className="mt-3 flex justify-center"><Button variant="outline" size="sm" onClick={more}>Muat lebih banyak</Button></div> : null}
        </CardContent>
      </Card>
    </div>
  );
}
