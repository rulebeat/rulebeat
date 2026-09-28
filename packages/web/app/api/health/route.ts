import { NextResponse } from 'next/server';
import { isDemoEnv } from '@/lib/demo-env';
import { isDemoReady } from '@/lib/demo/readiness';

// Unauthenticated on purpose (excluded in proxy.ts's matcher) — this answers "is the Next.js
// process alive and serving HTTP," nothing more. It must not open the database or call Azure: a
// container orchestrator's liveness probe should never restart-loop over a transient Azure hiccup
// or a slow disk. The deeper "can this instance actually reach Azure/the DB" question is what the
// admin-only /api/diagnostics/* routes answer, deliberately behind auth.
//
// A Demo is not ready until its snapshot exists and the live database was restored from it
// (instrumentation.ts), so a platform never routes a Visitor to a Demo still generating its data.
export async function GET() {
  if (isDemoEnv() && !isDemoReady()) {
    return NextResponse.json(
      { status: 'starting', reason: 'The Demo is still generating its data.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return NextResponse.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
