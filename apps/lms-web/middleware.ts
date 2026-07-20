import { createProductMiddleware } from '@platform/ui-kit/middleware';

// LMS product app (lms.app.com). The shared factory verifies the .app.com
// session cookie (RS256/HS256) and bounces unauthenticated users to the auth
// origin, preserving the full URL so login returns them here — the shared
// cookie makes a product switch a no-login hop.
export const middleware = createProductMiddleware();

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
};
