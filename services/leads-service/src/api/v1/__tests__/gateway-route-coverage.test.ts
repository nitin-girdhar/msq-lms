// ─────────────────────────────────────────────────────────────────────────────
// Gateway route coverage — the drift guard, LMS edition.
//
// The API gateway (msq-core/services/api-gateway/src/server.ts) is a flat
// ALLOWLIST of proxy routes with no catch-all. A route added here but not there
// is not "unreachable in some edge case": it is a hard 404 that never reaches
// this service. Adapted from the hr-service original, which exists because
// exactly that shipped broken.
//
// Two differences from the HR version:
//   * LMS routes are NOT namespaced. hr-service's /attendance becomes /hr/... at
//     the gateway; leads-service's /leads is /leads. So toGatewayPath is identity.
//   * /internal/* is exempt by prefix. Those routes are service-to-service, gated
//     by requireInternalSecret, and deliberately NOT gateway-exposed — exposing
//     one would put an unauthenticated-by-user endpoint on the public edge.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// __dirname, not import.meta.dirname: this service compiles to CommonJS, where
// import.meta is a hard TS error (TS1470). The hr-service original gets away with
// import.meta only because that service excludes its tests from tsc entirely.
const ROUTERS_DIR = resolve(__dirname, '..');
// __tests__ → v1 → api → src → leads-service → services → msq-lms → repo root
const REPO_ROOT = resolve(__dirname, '../../../../../../..');
const GATEWAY = join(REPO_ROOT, 'msq-core/services/api-gateway/src/server.ts');

/**
 * Route paths deliberately not exposed at the gateway.
 *
 * `/internal/` is a PREFIX rule, not a list: every route under it is
 * service-to-service by construction.
 */
const EXEMPT_PREFIXES = ['/internal/'];

/**
 * Individual routes with no matching gateway registration, each with the reason.
 *
 * All three below were found when this test was first written. None is broken, but
 * two are only incidentally reachable — recorded here rather than silently
 * widened, because adding a gateway route changes the public access surface.
 */
const EXEMPT: Record<string, string> = {
  // Exposed under a DIFFERENT name: the gateway registers POST /public/v1/leads
  // behind publicApiKeyAuth('leads:write') and proxies it here
  // (api-gateway/src/server.ts:173). The rename is the point — this route takes
  // the partner API key path, not a user session.
  '/intake/public': 'gateway exposes it as POST /public/v1/leads with publicApiKeyAuth',

  // INCIDENTAL COVERAGE, not a designed route. The gateway has no static
  // /campaigns/platforms, so the request falls through to its /campaigns/:id
  // handler, which rebuilds `/api/v1/campaigns/platforms` — and upstream Fastify
  // prefers this service's static route over its own /campaigns/:id. So it works,
  // and the capability gate (LMS_CAMPAIGNS_VIEW) is identical either way.
  //
  // It is fragile: it breaks the moment the gateway's :id route gains uuid
  // validation, and it would silently 404 rather than fail loudly. Worth a real
  // static registration next time that file is touched.
  '/campaigns/platforms': 'incidentally served by the gateway /campaigns/:id route — see note',
  '/campaigns/statuses': 'incidentally served by the gateway /campaigns/:id route — see note',
};

type Route = { method: string; path: string };

/** ':id' vs ':key' is not a difference the gateway can get wrong — only position is. */
function normalize(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, ':p');
}

function key(r: Route): string {
  return `${r.method.toUpperCase()} ${normalize(r.path)}`;
}

/** All `app.<method>('<path>'` registrations in a source file. */
function extractRoutes(source: string): Route[] {
  const out: Route[] = [];
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    out.push({ method: m[1]!, path: m[2]! });
  }
  return out;
}

function serviceRouterFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(ROUTERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ROUTERS_DIR, entry.name);
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.router.ts')) files.push(join(dir, file));
    }
  }
  return files;
}

/** Gateway routes: literal registrations plus the ones the lookup loop generates. */
function gatewayRouteKeys(source: string): Set<string> {
  const keys = new Set(extractRoutes(source).map(key));
  const map = /const TENANT_LOOKUP_TARGETS[^{]*\{([\s\S]*?)\n\};/.exec(source)?.[1] ?? '';
  for (const m of map.matchAll(/'([a-z0-9-]+)'\s*:/g)) {
    const slug = m[1]!;
    keys.add(`GET /lookups/${slug}`);
    keys.add(`POST /lookups/${slug}`);
    keys.add(`PATCH /lookups/${slug}/:p`);
  }
  return keys;
}

function isExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path.startsWith(p)) || EXEMPT[path] !== undefined;
}

const gatewayMissing = (missing: string[]) =>
  `Missing from msq-core/services/api-gateway/src/server.ts:\n\n${missing
    .map((k) => {
      const [method, path] = k.split(' ') as [string, string];
      return `app.${method.toLowerCase()}('${path}', { ...withAuth }, async (req, reply) => {\n  return proxyTo(config.leadsServiceUrl, '/api/v1${path}', req, reply, req.userCtx);\n});`;
    })
    .join('\n')}\n`;

describe.skipIf(!existsSync(GATEWAY))('gateway route coverage', () => {
  const gatewaySource = existsSync(GATEWAY) ? readFileSync(GATEWAY, 'utf8') : '';
  const exposed = gatewayRouteKeys(gatewaySource);

  it('exposes every report route', () => {
    // Scoped to the reports resource. The service-wide assertion below is the
    // broader guard; this one names the feature so a reports regression is
    // unambiguous in the failure output.
    const reportRoutes = extractRoutes(
      readFileSync(join(ROUTERS_DIR, 'reports', 'reports.router.ts'), 'utf8'),
    );
    expect(reportRoutes.length).toBeGreaterThan(0);
    const missing = reportRoutes.map(key).filter((k) => !exposed.has(k));
    expect(missing, gatewayMissing(missing)).toEqual([]);
  });

  it('exposes every leads-service route', () => {
    const missing: string[] = [];
    for (const file of serviceRouterFiles()) {
      for (const route of extractRoutes(readFileSync(file, 'utf8'))) {
        if (isExempt(route.path)) continue;
        const wanted = key(route);
        if (!exposed.has(wanted)) missing.push(wanted);
      }
    }
    expect(missing, gatewayMissing([...new Set(missing)].sort())).toEqual([]);
  });
});
