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
  transpilePackages: ['@platform/ui-kit', '@lms/web', '@hr/web', '@task/web'],
  async rewrites() {
    const apiGateway = process.env['API_GATEWAY_INTERNAL_URL'] ?? 'http://localhost:4000';
    return [
      {
        source: '/api/:path*',
        destination: `${apiGateway}/:path*`,
      },
    ];
  },
};

module.exports = config;
