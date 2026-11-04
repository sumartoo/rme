/**
 * Anti-replay TOTP (RSK-024, SC-AUTH-05/09). `delta` = hasil `authenticator.checkDelta` (null bila kode salah).
 * Mengembalikan langkah waktu (periode 30 detik) kode itu bila LEBIH BARU dari langkah terakhir yang diterima,
 * selain itu null — kode yang sama tidak dapat dipakai dua kali, juga kode lama dalam jendela toleransi.
 */
export function acceptTotpStep(delta: number | null, lastStep: string | number | null, now = Date.now(), periodSeconds = 30): number | null {
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / periodSeconds) + delta;
  return lastStep !== null && step <= Number(lastStep) ? null : step;
}
