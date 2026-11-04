'use client';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { InvitationItem, api, errorText } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/format';

/** Terima undangan (IAM-FR-001, OD-078): masuk dengan Google memakai email undangan, atau buat password. */
export default function InvitationPage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [inv, setInv] = useState<InvitationItem | null>();
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => { api<InvitationItem>(`/invitations/${encodeURIComponent(token)}`).then(setInv).catch(() => setInv(null)); }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: { fullName: fullName.trim(), password } });
      router.replace('/login?accepted=1');
    } catch (err) { setError(errorText(err, 'Gagal menerima undangan')); }
    finally { setBusy(false); }
  }

  if (inv === undefined) return <p className="p-8 text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-md">
        {inv === null ? (
          <CardHeader>
            <CardTitle>Undangan tidak berlaku</CardTitle>
            <CardDescription>Tautan sudah dipakai, kedaluwarsa, atau salah. Minta undangan baru ke admin klinik.</CardDescription>
          </CardHeader>
        ) : <>
          <CardHeader>
            <CardTitle>Undangan ke {inv.clinicName}</CardTitle>
            <CardDescription>
              Untuk <strong data-testid="invite-email">{inv.email}</strong> sebagai {inv.roles?.join(', ')}. Berlaku sampai {fmtDateTime(inv.expiresAt)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <a href="/api/v1/auth/google" className="inline-flex h-10 items-center justify-center rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted">
              Masuk dengan Google ({inv.email})
            </a>
            <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px grow bg-border" />atau buat password<span className="h-px grow bg-border" /></div>
            <form className="grid gap-3" onSubmit={submit} noValidate>
              {error ? <Alert tone="error">{error}</Alert> : null}
              <Field id="inv-fullname" label="Nama lengkap"><Input id="inv-fullname" value={fullName} maxLength={200} autoComplete="name" onChange={(e) => setFullName(e.target.value)} /></Field>
              <Field id="inv-password" label="Password" hint="Minimal 10 karakter; hindari password umum & nama email Anda.">
                <Input id="inv-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field id="inv-confirm" label="Ulangi password" error={confirm && confirm !== password ? 'Password tidak sama' : undefined}>
                <Input id="inv-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
              <Button type="submit" loading={busy} disabled={fullName.trim().length < 2 || password.length < 10 || confirm !== password}>Buat akun</Button>
            </form>
          </CardContent>
        </>}
      </Card>
    </main>
  );
}
