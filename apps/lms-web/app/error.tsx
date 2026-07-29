'use client';

import { AppErrorBoundary } from '@platform/ui-kit';

// Route-level error boundary. Catches a throw from anywhere in this app's tree
// and renders the shared surface instead of Next's stock error screen — which in
// production is a bare "Application error: a client-side exception has occurred"
// with no branding and no way back. Also detects an expired session and offers a
// sign-in link rather than a meaningless "Try again".
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppErrorBoundary error={error} reset={reset} homeHref="/dashboard/leads" homeLabel="Back to leads" />;
}
