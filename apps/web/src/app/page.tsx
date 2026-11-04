'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AuthSession, api } from '../lib/api';
import { nextStep } from '../lib/session';

/** Pintu masuk: belum login → /login; sudah → MFA atau area admin. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api<AuthSession>('/auth/session').then((a) => router.replace(nextStep(a))).catch(() => router.replace('/login'));
  }, [router]);
  return <p className="p-8 text-sm text-muted-foreground" role="status">Memuat…</p>;
}
