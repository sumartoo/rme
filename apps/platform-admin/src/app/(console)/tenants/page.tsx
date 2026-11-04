'use client';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Table, TBody, TD, TH, THead, TR, buttonVariants } from '@clinicrme/ui';
import { ApiError, Tenant, api } from '../../../lib/api';
import { STATUS_LABEL, STATUS_TONE, TENANT_TYPE_LABEL, fmtDate } from '../../../lib/labels';
import { can, useMe } from '../../../lib/session';

interface Page { data: Tenant[]; page: { hasMore: boolean; nextCursor: string | null } }

export default function TenantListPage() {
  const me = useMe();
  const [rows, setRows] = useState<Tenant[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async (after: string | null) => {
    setLoading(true); setError(undefined);
    try {
      const r = await api<Page>(`/tenants?limit=25${after ? `&cursor=${encodeURIComponent(after)}` : ''}`);
      setRows((prev) => (after ? [...prev, ...r.data] : r.data));
      setCursor(r.page.nextCursor); setHasMore(r.page.hasMore);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Gagal memuat tenant');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Tenant</h1>
          <p className="text-sm text-muted-foreground">Klinik pelanggan ClinicRME. Data klinis tidak dapat dibuka dari konsol ini.</p>
        </div>
        {can(me, 'platform.tenant.manage') ? (
          <Link href="/tenants/new" className={buttonVariants()}><Plus className="size-4" aria-hidden />Tenant baru</Link>
        ) : null}
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Card>
        <Table>
          <THead><TR><TH>Kode</TH><TH>Nama</TH><TH>Jenis</TH><TH>Paket</TH><TH>Status</TH><TH>Trial berakhir</TH><TH>Dibuat</TH></TR></THead>
          <TBody>
            {rows.map((t) => (
              <TR key={t.id}>
                <TD><Link href={`/tenants/${t.id}`} className="font-medium text-primary hover:underline">{t.code}</Link></TD>
                <TD>{t.displayName}</TD>
                <TD>{TENANT_TYPE_LABEL[t.tenantType] ?? t.tenantType}</TD>
                <TD>{t.plan?.code ?? '—'}</TD>
                <TD><Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge></TD>
                <TD>{fmtDate(t.trialEndsAt)}</TD>
                <TD>{fmtDate(t.createdAt)}</TD>
              </TR>
            ))}
            {!loading && rows.length === 0 ? <TR><TD colSpan={7} className="py-8 text-center text-muted-foreground">Belum ada tenant.</TD></TR> : null}
          </TBody>
        </Table>
      </Card>
      {hasMore ? <Button variant="outline" className="justify-self-center" loading={loading} onClick={() => load(cursor)}>Muat lebih banyak</Button> : null}
    </div>
  );
}
