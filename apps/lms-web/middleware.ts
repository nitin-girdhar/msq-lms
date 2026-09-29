import { createProductMiddleware, productOrigins } from '@platform/ui-kit/middleware';

// LMS product app, served at /lms under the shared host. The factory verifies
// the session cookie (RS256/HS256) and bounces unauthenticated users to the
// auth app, preserving the full URL so login returns them here — one origin
// means the cookie is already present, so a product switch is a no-login hop.
//
// `selfOrigin` is required in the split topology: without it the factory falls
// back to nextUrl, which reports the address the CONTAINER is reached on, not
// the public one. Behind a reverse proxy that produced
// `callbackUrl=http://localhost:3001/...`, so login sent users to localhost.
export const middleware = createProductMiddleware({
  selfOrigin: productOrigins().lms,
});

// `config.matcher` below is deliberately APP-RELATIVE. Next prepends this app's
// `basePath` to every matcher at build time, so writing the prefix here would
// produce a doubled `/lms/lms/...` that matches nothing — leaving these routes
// unauthenticated. Same for `protectedPrefixes`: `request.nextUrl.pathname`
// reaches middleware with the prefix already stripped. See the long note on
// DEFAULT_PROTECTED in @platform/ui-kit/middleware for the empirical evidence.
export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
