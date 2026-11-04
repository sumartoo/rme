import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_CENSOR, REDACT_PATHS } from './logging';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
  return { log: pino({ redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } }, stream), lines };
}

describe('redaksi log (SC-LOG-01)', () => {
  it('header sensitif, password, NIK, token, dan isi SOAP diganti [REDACTED]', () => {
    const { log, lines } = capture();
    log.info({
      req: { headers: { cookie: 'crme_session=abc', authorization: 'Bearer xyz', 'x-csrf-token': 'csrf1' } },
      res: { headers: { 'set-cookie': 'crme_session=def' } },
      body: { password: 'P@ss-123', nik: '3171012345678901', token: 't1', soap: { subjective: 'nyeri dada' } }, // pragma: allowlist secret — nilai uji sintetis
      password: 'top-level', // pragma: allowlist secret — nilai uji sintetis
    }, 'uji');
    const out = lines.join('');
    for (const secret of ['abc', 'Bearer xyz', 'csrf1', 'def', 'P@ss-123', '3171012345678901', 't1', 'nyeri dada', 'top-level']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(REDACT_CENSOR);
  });
});
