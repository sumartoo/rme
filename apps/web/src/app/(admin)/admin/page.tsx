'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinicrme/ui';
import { can, useSession } from '../../../lib/session';

/** Beranda sementara: admin klinik diarahkan ke profil. Menu dinamis per role dibangun di Stage 6. */
export default function AdminHome() {
  const s = useSession();
  const router = useRouter();
  const admin = can(s, 'tenant.profile.read');
  useEffect(() => { if (admin) router.replace('/admin/profile'); }, [admin, router]);
  if (admin) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Selamat datang, {s.auth.fullName}</CardTitle>
        <CardDescription>Menu untuk peran Anda (pendaftaran, pemeriksaan, kasir, dll.) tersedia mulai tahap berikutnya.</CardDescription>
      </CardHeader>
      <CardContent><p className="text-sm text-muted-foreground">Halaman pengaturan klinik hanya untuk admin klinik.</p></CardContent>
    </Card>
  );
}
