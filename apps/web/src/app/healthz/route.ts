/** Probe Cloud Run / Compose untuk web. */
export const dynamic = 'force-dynamic';
export function GET() {
  return Response.json({ status: 'ok' });
}
