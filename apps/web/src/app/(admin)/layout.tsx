'use client';
import { Building2, Download, LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, cn } from '@clinicrme/ui';
import { ApiError, AuthSession, Me, api } from '../../lib/api';
import { Session, SessionContext, can } from '../../lib/session';

const NAV = [
  { href: '/admin/profile', label: 'Profil klinik', icon: Building2, permission: 'tenant.profile.read' },
  { href: '/admin/exports', label: 'Ekspor data', icon: Download, permission: 'tenant.data.export' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [s, setS] = useState<Session>();
  const [blocked, setBlocked] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        const auth = await api<AuthSession>('/auth/session');
        if (auth.mfaRequired && !auth.mfaVerified) { router.replace('/mfa'); return; }
        setS({ auth, me: await api<Me>('/me') });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TEN-403-SUSPENDED') { setBlocked(e.message); return; }
        router.replace('/login');
      }
    })();
  }, [router]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  if (blocked) return <p className="p-8 text-sm" role="status">{blocked}</p>;
  if (!s) return <p className="p-8 text-sm text-muted-foreground" role="status">Memuat…</p>;
  const nav = NAV.filter((n) => can(s, n.permission));
  return (
    <SessionContext.Provider value={s}>
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
          <Link href="/admin" className="font-semibold">{s.auth.tenant.name} <span className="font-normal text-muted-foreground">· ClinicRME</span></Link>
          <nav className="flex gap-4 text-sm">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} className={cn('flex items-center gap-1.5 hover:text-primary', path === href && 'text-primary')}>
                <Icon className="size-4" aria-hidden />{label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span data-testid="me-email">{s.auth.email}</span>
            <Button variant="ghost" size="sm" onClick={logout}><LogOut className="size-4" aria-hidden />Keluar</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 md:p-6">{children}</main>
    </SessionContext.Provider>
  );
}
