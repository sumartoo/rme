'use client';
import { Building2, Database, Download, LogOut, Monitor, Package, Receipt, Settings, Shield, ShieldCheck, Stethoscope, User, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, Select, cn } from '@clinicrme/ui';
import { ApiError, AuthSession, Me, MenuNode, api } from '../../lib/api';
import { Session, SessionContext } from '../../lib/session';

const ICONS: Record<string, LucideIcon> = { settings: Settings, building: Building2, 'building-2': Building2, users: Users, shield: Shield,
  download: Download, user: User, monitor: Monitor, database: Database, stethoscope: Stethoscope, receipt: Receipt, 'shield-check': ShieldCheck, package: Package };

/**
 * Shell aplikasi klinik: menu samping dari `GET /me/menu` (IAM-FR-010) dan pilihan cabang aktif (IAM-FR-009).
 * Menu hanya tampilan — setiap halaman tetap ditolak API bila permission tidak dimiliki (IAM-FR-011).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [s, setS] = useState<Session>();
  const [menu, setMenu] = useState<MenuNode[]>([]);
  const [blocked, setBlocked] = useState<string>();

  const load = useCallback(async () => {
    try {
      const auth = await api<AuthSession>('/auth/session');
      if (auth.mfaRequired && !auth.mfaVerified) { router.replace('/mfa'); return; }
      const [me, m] = await Promise.all([api<Me>('/me'), api<MenuNode[]>('/me/menu')]);
      setS({ auth, me }); setMenu(m);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TEN-403-SUSPENDED') { setBlocked(e.message); return; }
      router.replace('/login');
    }
  }, [router]);
  useEffect(() => { void load(); }, [load]);

  async function logout() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/login');
  }

  async function selectBranch(branchId: string) {
    await api('/me/branch', { method: 'POST', body: { branchId } });
    await load();                                          // permission & menu bisa berbeda per cabang
  }

  if (blocked) return <p className="p-8 text-sm" role="status">{blocked}</p>;
  if (!s) return <p className="p-8 text-sm text-muted-foreground" role="status">Memuat…</p>;
  const { branches, activeBranchId } = s.me;
  return (
    <SessionContext.Provider value={s}>
      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 border-r bg-card md:block">
          <div className="flex h-14 items-center border-b px-4 font-semibold" data-testid="clinic-name">{s.auth.tenant.name}</div>
          <nav className="grid gap-4 p-3 text-sm" aria-label="Menu utama" data-testid="side-menu">
            {menu.map((g) => (
              <div key={g.code} className="grid gap-1">
                {g.route ? <MenuLink node={g} active={path === g.route} /> : (
                  <p className="px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
                )}
                {g.children.map((c) => <MenuLink key={c.code} node={c} active={path === c.route} />)}
              </div>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 grow flex-col">
          <header className="flex h-14 items-center gap-3 border-b bg-card px-4">
            <span className="font-semibold md:hidden">{s.auth.tenant.name}</span>
            {branches.length > 1 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Cabang</span>
                <Select aria-label="Cabang aktif" className="h-8 w-48" value={activeBranchId ?? ''} onChange={(e) => selectBranch(e.target.value)}>
                  {activeBranchId ? null : <option value="" disabled>Pilih cabang…</option>}
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </label>
            ) : branches.length === 1 ? <span className="text-sm text-muted-foreground" data-testid="branch-name">{branches[0].name}</span> : null}
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span data-testid="me-email">{s.auth.email}</span>
              <Button variant="ghost" size="sm" onClick={logout}><LogOut className="size-4" aria-hidden />Keluar</Button>
            </div>
          </header>
          <nav className="flex gap-3 overflow-x-auto border-b bg-card px-4 py-2 text-sm md:hidden" aria-label="Menu">
            {menu.flatMap((g) => (g.route ? [g] : g.children)).map((n) => <MenuLink key={n.code} node={n} active={path === n.route} />)}
          </nav>
          <main className="mx-auto w-full max-w-5xl p-4 md:p-6">{children}</main>
        </div>
      </div>
    </SessionContext.Provider>
  );
}

function MenuLink({ node, active }: { node: MenuNode; active: boolean }) {
  const Icon = (node.icon && ICONS[node.icon]) || Settings;
  return (
    <Link href={node.route!} aria-current={active ? 'page' : undefined}
          className={cn('flex items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 hover:bg-muted', active && 'bg-muted font-medium text-primary')}>
      <Icon className="size-4" aria-hidden />{node.label}
    </Link>
  );
}
