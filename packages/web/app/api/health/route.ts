import { NextResponse } from 'next/server';

// Unauthenticated on purpose (excluded in proxy.ts's matcher) — this answers "is the Next.js
// process alive and serving HTTP," nothing more. It must not open the database or call Azure: a
// container orchestrator's liveness probe should never restart-loop over a transient Azure hiccup
// or a slow disk. The deeper "can this instance actually reach Azure/the DB" question is what the
// admin-only /api/diagnostics/* routes answer, deliberately behind auth.
export async function GET() {
  return NextResponse.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
