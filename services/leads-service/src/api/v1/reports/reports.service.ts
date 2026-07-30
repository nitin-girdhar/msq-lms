// ── Report orchestration ──────────────────────────────────────────────────────
// Resolves the dataset, re-validates the spec, resolves the org timezone, runs
// the query. All authorization decisions live either in the router's
// requireCapability gate (the endpoint) or inside @platform/reporting (the dataset,
// the fields, the row scope) — none are made here.

import { parseReportSpec, type DatasetMeta, type ReportResult } from '@platform/reporting';
import { ReportError, toDatasetMeta } from '@platform/reporting/sql';
import { lmsDatasets } from './datasets/index.js';
import * as repository from './reports.repository.js';
import type { ReportActor } from './reports.repository.js';

export function listDatasets(actor: ReportActor): DatasetMeta[] {
  // Filters by dataset capability AND strips capability-gated fields the actor
  // cannot use, so the builder palette can never offer something /query rejects.
  return lmsDatasets.listFor({ capabilities: actor.capabilities });
}

export function getDataset(key: string, actor: ReportActor): DatasetMeta {
  const def = lmsDatasets.require(key);
  return toDatasetMeta(def, { capabilities: actor.capabilities });
}

export async function runQuery(
  rawSpec: unknown,
  actor: ReportActor,
  options: { tenantWide?: boolean } = {},
): Promise<ReportResult> {
  // Re-validated here even though the controller's zod schema already parsed the
  // body. This is the single entry point that both the HTTP path and (from phase
  // 7) the scheduler path go through, and a spec loaded from
  // report_definitions.spec JSONB has not been through the request schema at all.
  const parsed = parseReportSpec(rawSpec);
  if (!parsed.ok) {
    throw new ReportError('invalid_spec', `Invalid report: ${parsed.errors.join('; ')}`);
  }
  const spec = parsed.spec;

  // Resolved before the dataset lookup so an unknown dataset still 404s fast.
  const def = lmsDatasets.require(spec.dataset);
  const orgTimezone = await repository.getOrgTimezone(actor.orgId);

  return repository.runReport(def, spec, actor, {
    ...(options.tenantWide === true && { tenantWide: true }),
    ...(orgTimezone !== undefined && { orgTimezone }),
  });
}
