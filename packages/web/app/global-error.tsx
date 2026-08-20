'use client'; // Error boundaries must be Client Components

import { useEffect } from 'react';

/* Handles a fatal error in the root layout itself — replacing it entirely, so this file cannot
 * assume globals.css, the theme cookie, or next/font loaded correctly, since a root-layout
 * failure is exactly the moment those are least trustworthy. Defines its own <html>/<body> per the
 * global-error docs, system font stack, inline styles only, no metadata export (unsupported here). */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          background: '#f5f5f5',
          color: '#111111',
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 384, padding: '0 24px' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Something went wrong</h1>
          <p style={{ marginTop: 8, fontSize: 14, color: '#555555', lineHeight: 1.5 }}>
            RuleBeat hit an unexpected error and couldn&apos;t recover on its own. Reloading usually fixes this.
          </p>
          <button
            onClick={() => unstable_retry()}
            style={{
              marginTop: 20,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              color: '#ffffff',
              background: '#111111',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
