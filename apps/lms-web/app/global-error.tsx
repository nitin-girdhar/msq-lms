'use client';

// Last-resort boundary: catches errors thrown by the ROOT LAYOUT itself, which
// `error.tsx` cannot — at that point the layout has failed, so this file
// replaces it entirely and must render its own <html>/<body>.
//
// Deliberately dependency-free with inline styles: it has to work when the app
// shell, its providers, and even global CSS may be what failed. Sharing the
// ui-kit component here would reintroduce exactly the dependency that might be
// broken.
export default function GlobalError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif', background: '#fff' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
          <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#0f172a', margin: 0 }}>
              Something went wrong
            </h1>
            <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: '#64748b', lineHeight: 1.6 }}>
              The application failed to start. Please reload the page — if this keeps
              happening, quote the reference below.
            </p>
            {error.digest && (
              <p style={{ marginTop: '1.5rem', fontSize: '0.75rem', color: '#94a3b8' }}>
                Reference: <code>{error.digest}</code>
              </p>
            )}
            <a
              href="/dashboard/leads"
              style={{ display: 'inline-block', marginTop: '2rem', padding: '0.5rem 1rem', borderRadius: '0.5rem', background: '#0f172a', color: '#fff', fontSize: '0.875rem', fontWeight: 500, textDecoration: 'none' }}
            >
              Reload
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
