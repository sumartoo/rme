'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select } from '@clinicrme/ui';
import { ApiError, Plan, Tenant, api } from '../../../../lib/api';
import { TENANT_TYPE_LABEL } from '../../../../lib/labels';
import { can, useMe } from '../../../../lib/session';

/** Validasi di UI hanya untuk umpan balik cepat; aturan yang mengikat ada di API & database. */
const Schema = z.object({
  code: z.string().regex(/^[a-z0-9-]{3,40}$/, '3–40 karakter: huruf kecil, angka, tanda minus'),
  legalName: z.string().trim().min(3, 'Minimal 3 karakter').max(200),
  displayName: z.string().trim().max(200).optional(),
  tenantType: z.enum(['KLINIK_UTAMA', 'KLINIK_PRATAMA', 'PRAKTIK_MANDIRI']),
  planId: z.string().uuid('Pilih paket'),
  adminEmail: z.string().email('Format email tidak valid'),
  trialDays: z.coerce.number().int().min(0, '0–90 hari').max(90, '0–90 hari'),
});
type Form = z.input<typeof Schema>;

export default function NewTenantPage() {
  const me = useMe();
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form, unknown, z.output<typeof Schema>>({
    resolver: zodResolver(Schema), defaultValues: { tenantType: 'KLINIK_PRATAMA', trialDays: 14 },
  });
  useEffect(() => { api<Plan[]>('/plans').then(setPlans).catch(() => setError('Gagal memuat paket')); }, []);

  if (!can(me, 'platform.tenant.manage')) return <Alert tone="error">Anda tidak memiliki izin membuat tenant.</Alert>;

  const onSubmit = handleSubmit(async (v) => {
    setError(undefined);
    try {
      const t = await api<Tenant>('/tenants', { method: 'POST', body: { ...v, displayName: v.displayName || undefined } });
      router.push(`/tenants/${t.id}?created=${encodeURIComponent(v.adminEmail)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal membuat tenant');
    }
  });
  const err = (k: keyof Form) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `${k}-error` : undefined });

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Tenant baru</CardTitle>
        <CardDescription>Membuat klinik, langganan, 8 role template, dan undangan untuk admin klinik pertama — dalam satu langkah.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" noValidate>
          {error ? <Alert tone="error" className="md:col-span-2">{error}</Alert> : null}
          <Field id="code" label="Kode (subdomain)" hint="Dipakai sebagai alamat klinik, tidak dapat diubah." error={errors.code?.message}>
            <Input id="code" placeholder="klinik-sehat" autoComplete="off" {...err('code')} {...register('code')} />
          </Field>
          <Field id="tenantType" label="Jenis fasilitas" error={errors.tenantType?.message}>
            <Select id="tenantType" {...register('tenantType')}>
              {Object.entries(TENANT_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field id="legalName" label="Nama badan usaha" error={errors.legalName?.message}>
            <Input id="legalName" placeholder="PT Klinik Sehat Sejahtera" {...err('legalName')} {...register('legalName')} />
          </Field>
          <Field id="displayName" label="Nama tampilan" hint="Opsional; default = nama badan usaha.">
            <Input id="displayName" placeholder="Klinik Sehat" {...register('displayName')} />
          </Field>
          <Field id="planId" label="Paket" error={errors.planId?.message}>
            <Select id="planId" defaultValue="" {...err('planId')} {...register('planId')}>
              <option value="" disabled>Pilih paket…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.maxUsers} user, {p.maxBranches} cabang</option>)}
            </Select>
          </Field>
          <Field id="trialDays" label="Masa uji coba (hari)" hint="0 = langsung aktif." error={errors.trialDays?.message}>
            <Input id="trialDays" type="number" min={0} max={90} {...err('trialDays')} {...register('trialDays')} />
          </Field>
          <div className="md:col-span-2">
            <Field id="adminEmail" label="Email admin klinik" hint="Admin klinik masuk dengan akun Google memakai email ini (undangan berlaku 7 hari)."
                   error={errors.adminEmail?.message}>
              <Input id="adminEmail" type="email" placeholder="admin@kliniksehat.co.id" {...err('adminEmail')} {...register('adminEmail')} />
            </Field>
          </div>
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" loading={isSubmitting}>Buat tenant</Button>
            <Link href="/tenants" className="inline-flex h-9 items-center px-4 text-sm hover:underline">Batal</Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
