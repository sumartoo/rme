'use client';
import { useEffect, useState } from 'react';
import { Button, Input } from '@clinicrme/ui';
import { Page, PatientSummary, api } from '../lib/api';
import { SEX_LABEL, fmtAge, fmtDate } from '../lib/format';

/** Baris ringkas pasien: MRN, nama, tanggal lahir/umur, identitas tersamar. */
export function PatientLine({ p }: { p: PatientSummary }) {
  return (
    <span className="grid gap-0.5 text-left">
      <span className="font-medium">{p.fullName} <span className="font-mono text-xs text-muted-foreground">{p.mrn}</span></span>
      <span className="text-xs text-muted-foreground">
        {SEX_LABEL[p.sex]} · {fmtDate(p.birthDate)} ({fmtAge(p.birthDate)}){p.nikMasked ? ` · NIK ${p.nikMasked}` : p.identityMasked ? ` · ${p.identityMasked}` : ''}
        {p.phone ? ` · ${p.phone}` : ''}
      </span>
    </span>
  );
}

/** Cari & pilih satu pasien (pasien ibu, tujuan penggabungan). `exclude` tidak ditampilkan. */
export function PatientPicker({ id, onPick, exclude, label = 'Cari pasien' }: {
  id: string; onPick: (p: PatientSummary) => void; exclude?: string; label?: string;
}) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PatientSummary[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const t = setTimeout(() => {
      void api<Page<PatientSummary>>(`/patients?limit=8&q=${encodeURIComponent(q.trim())}`)
        .then((r) => setItems(r.data.filter((p) => p.id !== exclude))).catch(() => setItems([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, exclude]);
  return (
    <div className="grid gap-2">
      <Input id={id} aria-label={label} placeholder="Nama, No. RM, NIK, atau telepon…" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {items.length > 0 ? (
        <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-1" aria-label="Hasil pencarian pasien">
          {items.map((p) => (
            <li key={p.id}>
              <Button type="button" variant="ghost" className="h-auto w-full justify-start py-1.5" onClick={() => { onPick(p); setQ(''); setItems([]); }}>
                <PatientLine p={p} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
