'use client';
import { useEffect, useState } from 'react';
import { Field, Select } from '@clinicrme/ui';
import { Region, api } from '../lib/api';

const LEVELS = ['Provinsi', 'Kabupaten/kota', 'Kecamatan', 'Kelurahan/desa'];
/** Wilayah berjenjang (MST-FR-011, Kepmendagri): nilai = kode terdalam yang dipilih (boleh berhenti di tingkat mana pun). */
export function RegionPicker({ value, onChange, idPrefix = 'md-region' }: { value: string; onChange: (code: string) => void; idPrefix?: string }) {
  const parts = value ? value.split('.') : [];
  const chosen = parts.map((_, i) => parts.slice(0, i + 1).join('.'));      // kode tiap tingkat yang sudah dipilih
  const [lists, setLists] = useState<Region[][]>([]);
  const key = chosen.join('|');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const parents = [undefined, ...chosen].slice(0, 4);
      const out = await Promise.all(parents.map((p) => api<Region[]>(p ? `/regions?parent=${p}` : '/regions').catch(() => [])));
      if (alive) setLists(out);
    })();
    return () => { alive = false; };
  }, [key]);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {LEVELS.map((label, i) => (i === 0 || chosen[i - 1]) && (lists[i]?.length ?? 0) > 0 ? (
        <Field key={label} id={`${idPrefix}-${i}`} label={label}>
          <Select id={`${idPrefix}-${i}`} value={chosen[i] ?? ''} onChange={(e) => onChange(e.target.value || (chosen[i - 1] ?? ''))}>
            <option value="">— pilih —</option>
            {lists[i].map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </Select>
        </Field>
      ) : null)}
    </div>
  );
}
