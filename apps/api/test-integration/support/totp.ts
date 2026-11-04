import { authenticator } from 'otplib';

/**
 * Kode TOTP yang belum pernah diterima server. Server menolak kode dari periode 30 detik yang sama dua kali
 * (anti-replay, RSK-024), jadi bila periode ini sudah terpakai untuk secret yang sama, tunggu periode berikutnya —
 * persis seperti pengguna sungguhan. Juga menghindari ujung periode (kode bisa kedaluwarsa saat diperiksa).
 */
const lastStep = new Map<string, number>();
const step = () => Math.floor(Date.now() / 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function freshTotp(secret: string): Promise<string> {
  while (authenticator.timeRemaining() < 3 || step() <= (lastStep.get(secret) ?? -1)) await sleep(500);
  lastStep.set(secret, step());
  return authenticator.generate(secret);
}
