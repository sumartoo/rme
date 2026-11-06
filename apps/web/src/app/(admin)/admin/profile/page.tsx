'use client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Switch, Textarea } from '@clinicrme/ui';
import { ApiError, TenantProfile, api, errorText } from '../../../../lib/api';
import { can, useSession } from '../../../../lib/session';

interface Form { displayName: string; name: string; address: string; phone: string; license: string;
                 pharmacyBeforeCashier: boolean; discountLimitPercent: string; noShowMinutes: string; lateToleranceMinutes: string; mrnPrefix: string }
const toForm = (p: TenantProfile): Form => ({
  displayName: p.displayName, name: p.letterhead?.name ?? '', address: p.letterhead?.address ?? '', phone: p.letterhead?.phone ?? '',
  license: p.letterhead?.license ?? '', pharmacyBeforeCashier: p.settings.pharmacyBeforeCashier ?? false,
  discountLimitPercent: p.settings.discountLimitPercent?.toString() ?? '', noShowMinutes: p.settings.noShowMinutes?.toString() ?? '',
  lateToleranceMinutes: p.settings.lateToleranceMinutes?.toString() ?? '',
  mrnPrefix: p.settings.mrnPrefix ?? '',
});

/** PLT-FR-007: profil & kop klinik (dipakai di cetakan dokumen). Simpan dengan If-Match agar perubahan orang lain tidak tertimpa. */
export default function ProfilePage() {
  const s = useSession();
  const manage = can(s, 'tenant.profile.manage');
  const [p, setP] = useState<TenantProfile>();
  const [f, setF] = useState<Form>();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<TenantProfile>('/tenant/profile');
      setP(r); setF(toForm(r)); setConflict(false);
    } catch (e) { setError(errorText(e, 'Gagal memuat profil')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => (x ? { ...x, [k]: v } : x));
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  const discount = f ? num(f.discountLimitPercent) : undefined;
  const noShow = f ? num(f.noShowMinutes) : undefined;
  const late = f ? num(f.lateToleranceMinutes) : undefined;
  const invalid = !f || f.displayName.trim().length < 2
    || (discount !== undefined && !(discount >= 0 && discount <= 100))
    || (noShow !== undefined && !(Number.isInteger(noShow) && noShow >= 5 && noShow <= 240))
    || (late !== undefined && !(Number.isInteger(late) && late >= 0 && late <= 120))
    || !/^[A-Za-z]{0,5}$/.test(f.mrnPrefix);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!f || !p || invalid) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    const letterhead = { name: f.name.trim(), address: f.address.trim(), phone: f.phone.trim(), license: f.license.trim() };
    try {
      const r = await api<TenantProfile>('/tenant/profile', {
        method: 'PUT', headers: { 'if-match': `"${p.version}"` },
        body: {
          displayName: f.displayName.trim(),
          letterhead: Object.values(letterhead).some(Boolean) ? letterhead : null,
          settings: { ...p.settings, pharmacyBeforeCashier: f.pharmacyBeforeCashier,
                      ...(discount !== undefined ? { discountLimitPercent: discount } : {}), ...(noShow !== undefined ? { noShowMinutes: noShow } : {}), ...(late !== undefined ? { lateToleranceMinutes: late } : {}), mrnPrefix: f.mrnPrefix.toUpperCase() },
        },
      });
      setP(r); setF(toForm(r)); setNotice('Profil klinik disimpan.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'GEN-412-VERSION') setConflict(true);
      else setError(errorText(err, 'Gagal menyimpan profil'));
    } finally { setBusy(false); }
  }

  if (error && !f) return <Alert tone="error">{error}</Alert>;
  if (!f) return <p className="text-sm text-muted-foreground" role="status">Memuat…</p>;
  return (
    <form className="grid gap-4" onSubmit={save} noValidate>
      <h1 className="text-xl font-semibold">Profil klinik</h1>
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {conflict ? (
        <Alert tone="error">
          Profil sudah diubah orang lain sejak halaman ini dibuka. Perubahan Anda belum disimpan.{' '}
          <button type="button" className="font-medium underline" onClick={load}>Muat versi terbaru</button>
        </Alert>
      ) : null}
      {!manage ? <Alert tone="info">Anda hanya dapat melihat profil klinik.</Alert> : null}
      <fieldset disabled={!manage} className="grid gap-4">
        <Card>
          <CardHeader><CardTitle>Identitas</CardTitle></CardHeader>
          <CardContent>
            <Field id="displayName" label="Nama tampilan" hint="Muncul di aplikasi dan email." error={f.displayName.trim().length < 2 ? 'Minimal 2 karakter' : undefined}>
              <Input id="displayName" value={f.displayName} maxLength={200} onChange={(e) => set('displayName', e.target.value)} />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Kop dokumen</CardTitle>
            <CardDescription>Dicetak di resep, surat keterangan, dan kuitansi. Logo dapat diunggah mulai tahap dokumen (Stage 9).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <Field id="lh-name" label="Nama di kop"><Input id="lh-name" value={f.name} maxLength={200} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field id="lh-phone" label="Telepon"><Input id="lh-phone" value={f.phone} maxLength={50} onChange={(e) => set('phone', e.target.value)} /></Field>
            <div className="md:col-span-2">
              <Field id="lh-address" label="Alamat"><Textarea id="lh-address" value={f.address} maxLength={500} onChange={(e) => set('address', e.target.value)} /></Field>
            </div>
            <Field id="lh-license" label="Nomor izin klinik"><Input id="lh-license" value={f.license} maxLength={100} onChange={(e) => set('license', e.target.value)} /></Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Pengaturan alur</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <label htmlFor="pharmacyBeforeCashier" className="flex items-center justify-between gap-3 text-sm md:col-span-2">
              Pasien ke farmasi sebelum kasir
              <Switch id="pharmacyBeforeCashier" checked={f.pharmacyBeforeCashier} onChange={(e) => set('pharmacyBeforeCashier', e.target.checked)} />
            </label>
            <Field id="discount" label="Batas diskon kasir (%)" hint="0–100; kosong = belum diatur."
                   error={discount !== undefined && !(discount >= 0 && discount <= 100) ? 'Harus 0–100' : undefined}>
              <Input id="discount" inputMode="decimal" value={f.discountLimitPercent} onChange={(e) => set('discountLimitPercent', e.target.value)} />
            </Field>
            <Field id="noShow" label="Batas tidak hadir (menit)" hint="5–240; antrean dianggap tidak hadir setelah ini."
                   error={noShow !== undefined && !(Number.isInteger(noShow) && noShow >= 5 && noShow <= 240) ? 'Bilangan bulat 5–240' : undefined}>
              <Input id="noShow" inputMode="numeric" value={f.noShowMinutes} onChange={(e) => set('noShowMinutes', e.target.value)} />
            </Field>
            <Field id="late" label="Toleransi terlambat janji temu (menit)" hint="0–120; bawaan 15. Lewat dari ini pasien masuk antrean paling belakang (OD-087)."
                   error={late !== undefined && !(Number.isInteger(late) && late >= 0 && late <= 120) ? 'Bilangan bulat 0–120' : undefined}>
              <Input id="late" inputMode="numeric" value={f.lateToleranceMinutes} onChange={(e) => set('lateToleranceMinutes', e.target.value)} />
            </Field>
            <Field id="mrnPrefix" label="Awalan nomor rekam medis" hint="0–5 huruf, mis. RM → RM00000123. Berlaku untuk pasien baru (OD-081)."
                   error={!/^[A-Za-z]{0,5}$/.test(f.mrnPrefix) ? 'Maksimal 5 huruf, tanpa angka/simbol' : undefined}>
              <Input id="mrnPrefix" maxLength={5} value={f.mrnPrefix} onChange={(e) => set('mrnPrefix', e.target.value.toUpperCase())} />
            </Field>
          </CardContent>
        </Card>
      </fieldset>
      {manage ? <Button type="submit" loading={busy} disabled={invalid} className="justify-self-start">Simpan profil</Button> : null}
    </form>
  );
}
