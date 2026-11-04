'use client';
import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { ApiError, Me, api } from '../../lib/api';

interface Enrollment { otpauthUrl: string; recoveryCodes: string[]; secret: string; qr: string }

/** TOTP wajib untuk semua pengguna platform (CR-0001): daftar bila belum, lalu verifikasi. */
export default function MfaPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [enroll, setEnroll] = useState<Enrollment>();
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Me>('/me').then((m) => (m.mfaVerified ? router.replace('/tenants') : setMe(m)))
      .catch(() => router.replace('/login'));
  }, [router]);

  async function startEnroll() {
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ otpauthUrl: string; recoveryCodes: string[] }>('/auth/mfa/enroll', { method: 'POST' });
      const secret = new URL(r.otpauthUrl).searchParams.get('secret') ?? '';
      const svg = await QRCode.toString(r.otpauthUrl, { type: 'svg', margin: 1, width: 192 });
      setEnroll({ ...r, secret, qr: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memulai pendaftaran');
    } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/auth/mfa/verify', { method: 'POST', body: { code: code.trim() } });
      router.replace('/tenants');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH-401-SESSION') { router.replace('/login'); return; }
      setError(err instanceof ApiError ? err.message : 'Verifikasi gagal');
      setCode('');
    } finally { setBusy(false); }
  }

  if (!me) return null;
  const needsEnroll = !me.mfaEnrolled && !enroll;
  const canVerify = me.mfaEnrolled || (enroll && saved);

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Verifikasi dua langkah</CardTitle>
          <CardDescription>
            {me.mfaEnrolled ? 'Masukkan kode 6 digit dari aplikasi authenticator Anda, atau salah satu recovery code.'
                            : 'Akun platform wajib memakai aplikasi authenticator (Google Authenticator, Microsoft Authenticator, dll.).'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {needsEnroll ? <Button onClick={startEnroll} loading={busy}>Daftarkan authenticator</Button> : null}
          {enroll ? (
            <div className="grid gap-4">
              <div className="flex flex-col items-center gap-2">
                <img src={enroll.qr} alt="Kode QR untuk aplikasi authenticator" width={192} height={192} className="rounded-md border bg-white" />
                <p className="text-xs text-muted-foreground">Tidak bisa memindai? Masukkan kunci penyiapan ini:</p>
                <code data-testid="totp-secret" className="break-all rounded bg-muted px-2 py-1 text-sm">{enroll.secret}</code>
              </div>
              <div className="grid gap-2">
                <p className="text-sm font-medium">Recovery code (masing-masing sekali pakai)</p>
                <ul className="grid grid-cols-2 gap-1 rounded-md border bg-muted p-3 font-mono text-sm" data-testid="recovery-codes">
                  {enroll.recoveryCodes.map((c) => <li key={c}>{c}</li>)}
                </ul>
                <p className="text-xs text-muted-foreground">Simpan di tempat aman. Kode ini hanya ditampilkan sekali; tanpa authenticator
                  dan recovery code, akun hanya dapat dipulihkan oleh admin platform lain.</p>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Recovery code sudah saya simpan
                </label>
              </div>
            </div>
          ) : null}
          {canVerify ? (
            <form onSubmit={verify} className="grid gap-3">
              <Field id="code" label="Kode verifikasi">
                <Input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={20} value={code}
                       onChange={(e) => setCode(e.target.value)} />
              </Field>
              <Button type="submit" loading={busy} disabled={code.trim().length < 6}>Verifikasi</Button>
            </form>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
