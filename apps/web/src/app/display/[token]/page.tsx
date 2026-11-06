'use client';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Board {
  branch: { id: string; name: string }; generatedAt: string;
  units: { unitId: string; unitName: string; waiting: number; next: string[];
           calling: { displayCode: string; practitionerName: string | null; calledAt: string | null; callCount: number; initials?: string }[] }[];
  recentlyCalled: { displayCode: string; unitName: string; calledAt: string }[];
}

/**
 * Layar TV ruang tunggu (SCH-FR-008, OD-088/089): tanpa login, dibuka dengan tautan dari admin klinik. Data datang
 * lewat Server-Sent Events; bila stream terputus, peramban menyambung ulang otomatis. Tidak menampilkan nama pasien
 * (paling jauh inisial bila klinik mengaktifkannya).
 */
export default function QueueDisplayPage() {
  const { token } = useParams<{ token: string }>();
  const [board, setBoard] = useState<Board>();
  const [state, setState] = useState<'connecting' | 'live' | 'offline' | 'revoked'>('connecting');
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const es = new EventSource(`/api/v1/public/queue-display/${encodeURIComponent(token)}/stream`);
    es.addEventListener('board', (e) => { setBoard(JSON.parse((e as MessageEvent<string>).data) as Board); setState('live'); });
    es.addEventListener('revoked', () => { setState('revoked'); es.close(); });
    es.onerror = () => {
      // Token salah/dicabut: server menjawab 404 → EventSource berhenti (readyState CLOSED)
      setState(es.readyState === EventSource.CLOSED ? 'revoked' : 'offline');
    };
    return () => es.close();
  }, [token]);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);

  if (state === 'revoked' && !board) {
    return <main className="grid min-h-screen place-items-center bg-slate-950 text-2xl text-slate-200">Tautan layar antrean tidak berlaku. Hubungi admin klinik.</main>;
  }
  const clock = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  return (
    <main className="flex min-h-screen flex-col gap-6 bg-slate-950 p-8 text-slate-50" data-testid="queue-display">
      <header className="flex items-baseline justify-between">
        <h1 className="text-4xl font-bold">{board?.branch.name ?? 'Antrean'}</h1>
        <div className="text-right text-xl text-slate-300">
          {clock}
          {state !== 'live' ? <span className="ml-3 rounded bg-amber-500 px-2 py-0.5 text-base font-semibold text-slate-950">{state === 'revoked' ? 'Tautan dicabut' : 'Menyambung…'}</span> : null}
        </div>
      </header>
      {!board ? <p className="text-2xl text-slate-300" role="status">Memuat antrean…</p> : (
        <div className="grid flex-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <section className="grid content-start gap-4 sm:grid-cols-2" aria-label="Sedang dipanggil">
            {board.units.map((u) => (
              <div key={u.unitId} className="rounded-2xl bg-slate-900 p-6" data-testid="display-unit">
                <div className="text-2xl font-semibold text-slate-300">{u.unitName}</div>
                {u.calling[0] ? (
                  <div aria-live="polite">
                    <div className="font-mono text-8xl font-black tracking-tight text-amber-400" data-testid="display-calling">{u.calling[0].displayCode}</div>
                    <div className="text-xl text-slate-300">{u.calling[0].initials ? `${u.calling[0].initials} · ` : ''}{u.calling[0].practitionerName ?? ''}</div>
                  </div>
                ) : <div className="py-6 text-3xl text-slate-500">—</div>}
                <div className="mt-3 text-lg text-slate-400">Menunggu: {u.waiting}{u.next.length ? ` · Berikutnya: ${u.next.join(', ')}` : ''}</div>
              </div>
            ))}
          </section>
          <section className="rounded-2xl bg-slate-900 p-6" aria-label="Panggilan terakhir">
            <h2 className="mb-3 text-2xl font-semibold text-slate-300">Panggilan terakhir</h2>
            <ul className="grid gap-2">
              {board.recentlyCalled.map((r) => (
                <li key={`${r.displayCode}-${r.calledAt}`} className="flex justify-between text-2xl">
                  <span className="font-mono font-bold">{r.displayCode}</span><span className="text-slate-400">{r.unitName}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </main>
  );
}
