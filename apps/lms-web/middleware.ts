import { createProductMiddleware, productOrigins } from '@platform/ui-kit/middleware';

// LMS product app (lms.app.com). The shared factory verifies the .app.com
// session cookie (RS256/HS256) and bounces unauthenticated users to the auth
// origin, preserving the full URL so login returns them here — the shared
// cookie makes a product switch a no-login hop.
//
// `selfOrigin` is required in the split topology: without it the factory falls
// back to nextUrl, which reports the address the CONTAINER is reached on, not
// the public one. Behind a reverse proxy that produced
// `callbackUrl=http://localhost:3001/...`, so login sent users to localhost.
export const middleware = createProductMiddleware({
  selfOrigin: productOrigins().lms,
});

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
