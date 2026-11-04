'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from '@clinicrme/ui';
import { ApiError, api } from '../../lib/api';

const Schema = z.object({ email: z.string().email('Format email tidak valid'), password: z.string().min(1, 'Password wajib diisi') });

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof Schema>>({ resolver: zodResolver(Schema) });

  const onSubmit = handleSubmit(async (v) => {
    setError(undefined);
    try {
      await api('/auth/login', { method: 'POST', body: v });
      router.replace('/mfa');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Tidak dapat terhubung ke server');
    }
  });

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Konsol Platform ClinicRME</CardTitle>
          <CardDescription>Khusus staf platform. Akun klinik tidak dapat masuk di sini.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            {error ? <Alert tone="error">{error}</Alert> : null}
            <Field id="email" label="Email" error={errors.email?.message}>
              <Input id="email" type="email" autoComplete="username" autoFocus aria-invalid={!!errors.email}
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
