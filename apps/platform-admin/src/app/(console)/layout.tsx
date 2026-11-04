'use client';
import { Building2, LifeBuoy, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@clinicrme/ui';
import { Me, api } from '../../lib/api';
import { MeContext } from '../../lib/session';

const ROLE_LABEL: Record<string, string> = { PLATFORM_ADMIN: 'Admin platform', PLATFORM_SUPPORT: 'Support platform' };

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me>();

  useEffect(() => {
    api<Me>('/me')
      .then((m) => (m.mfaVerified ? setMe(m) : router.replace('/mfa')))
      .catch(() => router.replace('/login'));
  }, [router]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  if (!me) return <p className="p-8 text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <MeContext.Provider value={me}>
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/tenants" className="font-semibold">ClinicRME <span className="font-normal text-muted-foreground">· Konsol Platform</span></Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/tenants" className="flex items-center gap-1.5 hover:text-primary"><Building2 className="size-4" aria-hidden />Tenant</Link>
            <Link href="/support" className="flex items-center gap-1.5 hover:text-primary"><LifeBuoy className="size-4" aria-hidden />Akses dukungan</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-right leading-tight">
              <span className="block" data-testid="me-email">{me.email}</span>
              <span className="block text-xs text-muted-foreground">{me.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="size-4" aria-hidden />Keluar</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
    </MeContext.Provider>
  );
}
