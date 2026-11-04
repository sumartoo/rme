'use client';
import { useEffect, useState } from 'react';
import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle, TBody, TD, TH, THead, TR, Table } from '@clinicrme/ui';
import { ApiError, SupportGrant, api } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/labels';
import { can, useMe } from '../../../lib/session';
import { GrantBadge } from '../../../lib/support';
import Link from 'next/link';

/** Daftar akses dukungan: support melihat miliknya, admin platform melihat semua (PLT-FR-009). */
export default function SupportListPage() {
  const me = useMe();
  const [grants, setGrants] = useState<SupportGrant[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<SupportGrant[]>('/support-access').then(setGrants).catch((e) => setError(e instanceof ApiError ? e.message : 'Gagal memuat'));
  }, []);

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Akses dukungan</h1>
      <Card>
        <CardHeader>
          <CardTitle>{can(me, 'platform.tenant.manage') ? 'Semua akses dukungan' : 'Akses dukungan saya'}</CardTitle>
          <CardDescription>
            Akses baru diminta dari halaman detail tenant. Akses berlaku paling lama 8 jam, dapat dicabut kapan saja, dan setiap
            pembukaan/penutupan dikirim lewat email ke semua admin klinik.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? <Alert tone="error">{error}</Alert> : !grants ? <p className="text-sm text-muted-foreground" role="status">Memuat…</p>
            : grants.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada akses dukungan.</p> : (
            <Table>
              <THead><TR><TH>Tenant</TH><TH>Support</TH><TH>Alasan</TH><TH>Berlaku</TH><TH>Status</TH></TR></THead>
              <TBody>
                {grants.map((g) => (
                  <TR key={g.id} data-testid="grant-row">
                    <TD><Link href={`/support/${g.id}`} className="font-mono hover:text-primary">{g.tenantCode}</Link></TD>
                    <TD>{g.supportName}</TD>
                    <TD className="max-w-xs truncate" title={g.reason}>{g.reason}</TD>
                    <TD className="whitespace-nowrap text-xs">{fmtDateTime(g.startsAt)}<br />s.d. {fmtDateTime(g.expiresAt)}</TD>
                    <TD><GrantBadge g={g} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
