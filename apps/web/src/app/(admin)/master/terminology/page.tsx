'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, Input, Select, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { CodeSystem, CodeSystemCode, Concept, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';
import { can, useSession } from '../../../../lib/session';

const SYSTEM_LABEL: Record<CodeSystemCode, string> = { ICD10: 'ICD-10 (diagnosis)', ICD9CM: 'ICD-9-CM (tindakan)' };

/**
 * Diagnosis & tindakan (TRM-FR-001–004): cari kode ICD versi berlaku, tandai favorit klinik, validasi favorit oleh
 * dokter (OD-084). Hanya favorit tervalidasi yang nanti muncul sebagai pilihan cepat di rekam medis (Stage 9).
 */
export default function TerminologyPage() {
  const s = useSession();
  const manage = can(s, 'terminology.favorite.manage');
  const [system, setSystem] = useState<CodeSystemCode>('ICD10');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'' | 'all' | 'validated'>('');
  const [items, setItems] = useState<Concept[]>();
  const [systems, setSystems] = useState<CodeSystem[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ system, limit: '50' });
      if (q.trim()) p.set('q', q.trim());
      if (mode) p.set('favorites', mode);
      setItems(await api<Concept[]>(`/terminology/concepts?${p}`));
    } catch (e) { setError(errorText(e, 'Gagal mencari kode')); }
  }, [system, q, mode]);
  useEffect(() => { const t = setTimeout(() => void load(), 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { void api<CodeSystem[]>('/terminology/code-systems').then(setSystems).catch(() => undefined); }, []);
  const current = systems.find((x) => x.code === system && x.isCurrent);

  async function act(c: Concept, fn: () => Promise<unknown>, msg: string) {
    setBusy(c.id); setError(undefined); setNotice(undefined);
    try { await fn(); await load(); setNotice(msg); } catch (e) { setError(errorText(e, 'Aksi gagal')); }
    finally { setBusy(undefined); }
  }
  const fav = (c: Concept, body: object) => api(`/terminology/favorites/${c.id}`, { method: 'PUT', body });

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Diagnosis & tindakan</h1>
      {current ? (
        <Alert tone="info" data-testid="code-system-info">
          {current.isSample ? <Badge tone="warning" className="mr-2">CONTOH</Badge> : null}
          <span className="font-medium">{current.code} versi {current.version}</span> · {current.conceptCount} kode. {current.source}
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Sistem kode" className="w-56" value={system} onChange={(e) => setSystem(e.target.value as CodeSystemCode)}>
          {Object.entries(SYSTEM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input aria-label="Cari kode atau kata kunci" placeholder="Kode, nama, atau sinonim (mis. I10, darah tinggi)…" className="w-80" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select aria-label="Tampilkan" className="w-52" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="">Semua kode</option>
          <option value="all">Favorit klinik</option>
          <option value="validated">Favorit tervalidasi</option>
        </Select>
      </div>
      <Card>
        <CardContent className="pt-6">
          {!items ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Tidak ada kode yang cocok.</p>
          ) : (
            <Table>
              <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Favorit</TH>{manage ? <TH /> : null}</TR></THead>
              <TBody>
                {items.map((c) => (
                  <TR key={c.id} data-testid="concept-row">
                    <TD className="font-mono text-xs">{c.code}</TD>
                    <TD>{c.display}{c.synonyms.length ? <div className="text-xs text-muted-foreground">{c.synonyms.join(', ')}</div> : null}</TD>
                    <TD className="text-xs">
                      {!c.favorite ? '—' : c.favorite.validated
                        ? <span><Badge tone="success">tervalidasi</Badge> <span className="text-muted-foreground">{c.favorite.validatedBy} · {fmtDateTime(c.favorite.validatedAt)}</span></span>
                        : <Badge tone="warning">belum divalidasi</Badge>}
                    </TD>
                    {manage ? (
                      <TD className="text-right"><span className="inline-flex gap-2">
                        {!c.isFavorite
                          ? <Button size="sm" variant="outline" loading={busy === c.id} onClick={() => act(c, () => fav(c, {}), `${c.code} ditambahkan ke favorit (perlu validasi dokter).`)}>Jadikan favorit</Button>
                          : (<>
                            {!c.favorite?.validated ? <Button size="sm" loading={busy === c.id} onClick={() => act(c, () => fav(c, { validated: true }), `${c.code} divalidasi.`)}>Validasi</Button> : null}
                            <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => act(c, () => api(`/terminology/favorites/${c.id}`, { method: 'DELETE' }), `${c.code} dihapus dari favorit.`)}>Hapus favorit</Button>
                          </>)}
                      </span></TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Validasi favorit hanya oleh dokter yang akunnya tertaut ke data tenaga kesehatan dengan SIP berlaku.</p>
        </CardContent>
      </Card>
    </div>
  );
}
