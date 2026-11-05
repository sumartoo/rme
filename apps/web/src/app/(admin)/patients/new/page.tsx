'use client';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinicrme/ui';
import { PatientForm } from '../patient-form';

/** Registrasi pasien baru (REG-FR-001). Sistem memeriksa duplikat saat menyimpan. */
export default function NewPatientPage() {
  const router = useRouter();
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Daftar pasien baru</CardTitle>
        <CardDescription>Nomor rekam medis dibuat otomatis. NIK & nomor identitas disimpan terenkripsi dan hanya tampil tersamar.</CardDescription>
      </CardHeader>
      <CardContent>
        <PatientForm onCancel={() => router.push('/patients')} onDone={(p) => router.push(`/patients/${p.id}?created=1`)} />
      </CardContent>
    </Card>
  );
}
