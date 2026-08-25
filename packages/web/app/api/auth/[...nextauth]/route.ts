import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { withCorrectedOrigin } from '@/lib/request-origin';

// Auth.js builds every absolute URL it emits (redirects, error pages, the Entra redirect_uri)
// from this request's URL. Under the standalone server that URL carries the bind address, not the
// browser's, so it is corrected here before Auth.js reads it — see lib/request-origin.ts and #49.
export const GET = (req: NextRequest) => handlers.GET(withCorrectedOrigin(req));
export const POST = (req: NextRequest) => handlers.POST(withCorrectedOrigin(req));
