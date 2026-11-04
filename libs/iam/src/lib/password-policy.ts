import { COMMON_PASSWORDS } from './common-passwords.generated';

/**
 * Kebijakan password klinik (AC-IAM-FR-003-1, SC-AUTH-03): ≥ 10 karakter, ≤ 200, bukan password umum (OD-079),
 * tidak memuat bagian email pengguna, tidak satu karakter berulang. Mengembalikan pesan untuk pengguna, atau null bila lolos.
 */
export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 10) return 'Password minimal 10 karakter';
  if (password.length > 200) return 'Password maksimal 200 karakter';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'Password ini terlalu umum. Pilih yang lain.';
  if (/^(.)\1+$/.test(password)) return 'Password tidak boleh satu karakter berulang';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Password tidak boleh memuat nama email Anda';
  return null;
}
