'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { AuthSession, api, errorText } from '../../lib/api';
import { nextStep } from '../../lib/session';

const Schema = z.object({ email: z.string().email('Format email tidak valid'), password: z.string().min(1, 'Password wajib diisi') });

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [clinic, setClinic] = useState<string | null>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof Schema>>({ resolver: zodResolver(Schema) });
  // Klinik ditentukan dari subdomain (demo.localhost, klinik-a.clinicrme.id). Tanpa subdomain → tidak ada klinik.
  useEffect(() => {
    const parts = window.location.hostname.split('.');
    setClinic(parts.length >= 2 && !/^\d+$/.test(parts[parts.length - 1]) ? parts[0] : null);
  }, []);

  const onSubmit = handleSubmit(async (v) => {
    setError(undefined);
    try {
      await api('/auth/login', { method: 'POST', body: v });
      router.replace(nextStep(await api<AuthSession>('/auth/session')));
    } catch (e) {
      setError(errorText(e, 'Tidak dapat terhubung ke server'));
    }
  });

  if (clinic === undefined) return null;
  if (clinic === null) {
    const port = window.location.port ? `:${window.location.port}` : '';
    return (
      <main className="grid min-h-screen place-items-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Buka alamat klinik Anda</CardTitle>
            <CardDescription>Setiap klinik punya alamat sendiri berupa subdomain.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm" data-testid="no-clinic">
            <p>Contoh: <code className="rounded bg-muted px-1">klinik-anda.{window.location.hostname}{port}</code></p>
            {window.location.hostname === 'localhost' ? (
              <p>Lingkungan pengembangan: <a className="font-medium underline" href={`${window.location.protocol}//demo.localhost${port}/login`}>demo.localhost{port}</a></p>
            ) : null}
            <p className="text-muted-foreground">Alamat klinik ada di email undangan dari ClinicRME.</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Masuk ke ClinicRME</CardTitle>
          <CardDescription>Klinik: <span className="font-mono" data-testid="clinic-code">{clinic}</span></CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {/* Navigasi penuh (bukan fetch): API mengarahkan ke Google lalu kembali ke klinik ini */}
          <a href="/api/v1/auth/google"
             className="inline-flex h-10 items-center justify-center rounded-md border bg-card px-4 text-sm font-medium hover:bg-muted">
            Masuk dengan Google
          </a>
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px grow bg-border" />atau<span className="h-px grow bg-border" /></div>
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <Field id="email" label="Email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="username" aria-invalid={!!errors.email}
                     aria-describedby={errors.email ? 'email-error' : undefined} {...register('email')} />
            </Field>
            <Field id="password" label="Password" error={errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password}
                     aria-describedby={errors.password ? 'password-error' : undefined} {...register('password')} />
            </Field>
            <Button type="submit" loading={isSubmitting}>Masuk</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
