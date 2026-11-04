'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { api, errorText } from '../../../lib/api';

/** IAM-FR-004: password baru dari tautan email (sekali pakai). Semua sesi lama dicabut oleh API. */
export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/auth/password-reset/confirm', { method: 'POST', body: { token, password } });
      router.replace('/login?reset=1');
    } catch (err) { setError(errorText(err, 'Gagal menyimpan password')); }
    finally { setBusy(false); }
  }
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Buat password baru</CardTitle>
          <CardDescription>Setelah disimpan, semua sesi lama di perangkat lain otomatis keluar.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={submit} noValidate>
            {error ? <Alert tone="error">{error} {error.includes('Minta tautan baru') ? <Link href="/forgot-password" className="underline">Minta tautan baru</Link> : null}</Alert> : null}
            <Field id="rp-password" label="Password baru" hint="Minimal 10 karakter; hindari password umum & nama email Anda.">
              <Input id="rp-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field id="rp-confirm" label="Ulangi password" error={confirm && confirm !== password ? 'Password tidak sama' : undefined}>
              <Input id="rp-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <Button type="submit" loading={busy} disabled={password.length < 10 || confirm !== password}>Simpan password</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
