// File uji aturan .semgrep/clinicrme.yml (semgrep --test). Bukan kode aplikasi.
declare const html: string;
// ruleid: crme-no-dangerously-set-inner-html
export const A = () => <div dangerouslySetInnerHTML={{ __html: html }} />;
// ok: crme-no-dangerously-set-inner-html
export const B = () => <div>{html}</div>;
