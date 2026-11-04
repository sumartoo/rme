'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinicrme/ui';
import { SessionItem, api, errorText } from '../../../../lib/api';
import { fmtDateTime } from '../../../../lib/format';

/** Ringkas user agent untuk dibaca manusia (tanpa pustaka; cukup untuk mengenali perangkat). */
function device(ua: string | null): string {
  if (!ua) return 'Perangkat tidak dikenal';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' di ');
}

/** IAM-FR-013: sesi & perangkat saya — cabut sesi yang tidak dikenal (mis. lupa keluar di komputer klinik). */
export default function SessionsPage() {
  const router = useRouter();
  const [list, setList] = useState<SessionItem[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api<SessionItem[]>('/me/sessions').then(setList).catch((e) => setError(errorText(e, 'Gagal memuat sesi'))), []);
  useEffect(() => { void load(); }, [load]);

  async function revoke(s: SessionItem) {
    setError(undefined);
    try {
      await api(`/me/sessions/${s.id}`, { method: 'DELETE' });
      if (s.current) { router.replace('/login'); return; }
      await load();
    } catch (e) { setError(errorText(e, 'Gagal mencabut sesi')); }
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Sesi &amp; perangkat</h1>
      <Card>
        <CardHeader>
          <CardTitle>Sesi aktif</CardTitle>
          <CardDescription>Cabut sesi yang tidak Anda kenali. Bila curiga akun dipakai orang lain, ganti password juga.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {!list ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p> : (
            <ul className="divide-y rounded-md border">
              {list.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm" data-testid="session-row">
                  <span className="grid">
                    <span className="font-medium">{device(s.userAgent)} {s.current ? <Badge tone="success">Sesi ini</Badge> : null}</span>
                    <span className="text-xs text-muted-foreground">IP {s.ip ?? '—'} · masuk {fmtDateTime(s.createdAt)} · aktif {fmtDateTime(s.lastSeenAt)}</span>
                  </span>
                  <Button size="sm" variant={s.current ? 'outline' : 'destructive'} onClick={() => revoke(s)}>{s.current ? 'Keluar' : 'Cabut'}</Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
