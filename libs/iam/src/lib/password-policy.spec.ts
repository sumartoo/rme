import { passwordProblem } from './password-policy';

describe('kebijakan password (AC-IAM-FR-003-1, OD-079)', () => {
  it('panjang minimal 10', () => expect(passwordProblem('Pendek1!')).toMatch(/minimal 10/));
  it('password umum ditolak tanpa memandang huruf besar', () => {
    expect(passwordProblem('1234567890')).toMatch(/terlalu umum/);
    expect(passwordProblem('BasketBall')).toMatch(/terlalu umum/);
  });
  it('tidak boleh memuat nama email atau satu karakter berulang', () => {
    expect(passwordProblem('dr.ani-rahasia-2026', 'dr.ani@klinik.test')).toMatch(/nama email/);
    expect(passwordProblem('z'.repeat(19))).toMatch(/berulang/);
  });
  it('password kuat lolos', () => expect(passwordProblem('kopi-pagi-di-klinik-77', 'dr.ani@klinik.test')).toBeNull());
});
