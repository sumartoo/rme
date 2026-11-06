//@ts-check

/** Header keamanan statis (SC-WEB-01). CSP bernonce dipasang per request di src/proxy.ts. */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'Cache-Control', value: 'no-store' },   // halaman berisi data klinik
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Kompresi diserahkan ke reverse proxy: kompresi Next.js menahan stream SSE layar antrean (OD-089)
  compress: false,
  transpilePackages: ['@clinicrme/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
