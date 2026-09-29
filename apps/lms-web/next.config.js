// @platform/ui-kit and the per-product `@<product>/web` feature packages all
// ship TypeScript source (no build step) — Next.js transpiles them as part
// of the app build, same as first-party source. Chosen over a plain-tsc ESM
// build (like @crm/types) because these are React/JSX + DOM-hook code,
// which is what apps/web already knows how to compile.
//
// Plain .js (not .ts): `next start` re-reads this file at runtime, which
// requires the `typescript` package to be present — but production images
// are deployed with `pnpm deploy --prod`, which excludes devDependencies.
/** @type {import('next').NextConfig} */
const config = {
  // Single-origin topology: all six web apps sit behind ONE host so the
  // platform installs as one PWA holding one push subscription
  // (see docs/Architecture.md → Web push & PWA). auth-web owns the root; this app owns /lms.
  //
  // Compiled into the image, NOT read from env — changing this prefix is a
  // rebuild and redeploy of this product, never an env flip. Must stay in
  // lockstep with LMS_URL (`http://app.localhost/lms`) and the matching
  // `handle /lms/*` block in infra/Caddyfile.
  basePath: '/lms',
  transpilePackages: ['@platform/ui-kit', '@lms/web'],
  async rewrites() {
    const apiGateway = process.env['API_GATEWAY_INTERNAL_URL'] ?? 'http://localhost:4000';
    return [
      {
        // `source` is auto-prefixed with basePath by Next, so this matches the
        // browser's `/lms/api/*`. `destination` is an ABSOLUTE (external) URL,
        // which Next deliberately leaves un-prefixed — so the gateway receives
        // `/leads`, not `/lms/api/leads`. Verified against next@15.5.20
        // (dist/lib/load-custom-routes.js: `destBasePath` is '' when the
        // destination does not start with '/'). Do not strip the prefix by
        // hand here; that would double-strip.
        source: '/api/:path*',
        destination: `${apiGateway}/:path*`,
      },
    ];
  },
};

module.exports = config;
