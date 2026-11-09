'use client';
import { useEffect, useState } from 'react';
import { Button, Field, Input } from '@clinicrme/ui';
import { Drug, Page, api } from '../../../lib/api';

/** Pencarian obat (master obat aktif) untuk formulir farmasi. */
export function DrugPicker({ id, value, error, onChange }: { id: string; value?: Drug; error?: string; onChange: (d?: Drug) => void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState<Drug[]>([]);
  useEffect(() => {
    if (value || q.trim().length < 2) { setOpts([]); return; }
    const t = setTimeout(() => void api<Page<Drug>>(`/drugs?limit=10&q=${encodeURIComponent(q.trim())}`).then((p) => setOpts(p.data)).catch(() => setOpts([])), 250);
    return () => clearTimeout(t);
  }, [q, value]);
  if (value) {
    return (
      <Field id={id} label="Obat *" error={error}>
        <div className="flex items-center gap-2 text-sm" id={id}>
          <span className="font-medium">{value.genericName}</span><span className="text-xs text-muted-foreground">satuan dasar {value.uomName}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => { onChange(undefined); setQ(''); }}>Ganti</Button>
        </div>
      </Field>
    );
  }
  return (
    <Field id={id} label="Obat *" error={error}>
      <div className="relative">
        <Input id={id} placeholder="Ketik nama/kode obat" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        {opts.length ? (
          <ul className="absolute z-10 mt-1 w-full rounded-md border bg-background shadow" role="listbox">
            {opts.map((d) => (
              <li key={d.id}><button type="button" role="option" aria-selected={false} className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => onChange(d)}>{d.genericName} <span className="text-xs text-muted-foreground">{d.code}</span></button></li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}
