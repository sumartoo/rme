import { headers } from 'next/headers';
import './global.css';

export const metadata = {
  title: 'ClinicRME',
  description: 'Rekam medis elektronik untuk klinik',
  robots: { index: false, follow: false },
};

/**
 * Render dinamis untuk SEMUA halaman: CSP bernonce (src/proxy.ts) hanya bisa disisipkan Next.js ke script
 * pada render per request — halaman statis akan diblokir CSP. Membaca headers() memaksa render dinamis.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="id">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
