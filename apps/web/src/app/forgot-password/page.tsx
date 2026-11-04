'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { api, errorText } from '../../lib/api';

/** IAM-FR-004: minta tautan reset. Pesan selalu sama — tidak membocorkan apakah email terdaftar. */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try { await api('/auth/password-reset', { method: 'POST', body: { email: email.trim() } }); setDone(true); }
    catch (err) { setError(errorText(err, 'Tidak dapat terhubung ke server')); }
    finally { setBusy(false); }
  }
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Lupa password</CardTitle>
          <CardDescription>Kami kirim tautan untuk membuat password baru (berlaku 30 menit).</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {done ? (
            <Alert tone="success">Bila email itu terdaftar di klinik ini, tautan reset sudah dikirim. Periksa kotak masuk (dan folder spam).</Alert>
          ) : (
            <form className="grid gap-3" onSubmit={submit} noValidate>
              {error ? <Alert tone="error">{error}</Alert> : null}
              <Field id="fp-email" label="Email"><Input id="fp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Button type="submit" loading={busy} disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>Kirim tautan</Button>
            </form>
          )}
          <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">Kembali ke halaman masuk</Link>
        </CardContent>
      </Card>
    </main>
  );
}
