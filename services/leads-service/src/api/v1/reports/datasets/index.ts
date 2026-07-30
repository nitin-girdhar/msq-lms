// ── The LMS dataset registry ──────────────────────────────────────────────────
// Built once at module load. createDatasetRegistry validates each definition's
// internal consistency here, so a malformed dataset crashes the service on boot
// with a stack trace rather than 500-ing one user's report later.
//
// This registry is LMS-only by design. leads-service runs as lms_svc, which has no
// USAGE on the hr or task schemas (db_scripts/04_roles_and_grants.sql:529-553), so
// the grant model stays a real boundary even if the whitelist were bypassed. HR
// datasets live in hr-service's own registry.
//
// Adding a dataset should be an edit to THIS folder and nothing else. If it turns
// out to need a change anywhere in @platform/reporting, that is a design bug in
// the engine — fix the abstraction rather than special-casing the dataset.

import { createDatasetRegistry } from '@platform/reporting/sql';
import { leadsDataset } from './leads.dataset.js';

export const lmsDatasets = createDatasetRegistry([leadsDataset]);
