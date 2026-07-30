// ── Dataset: lms.leads ───────────────────────────────────────────────────────
// Over lms.vw_dashboard_leads (db_scripts/02_schema.sql). That view is
// security_invoker, so lms.marketing_leads' org/tenant RLS policies filter rows
// for the caller — layer 1 of the four in @platform/reporting/sql/scope.ts.
//
// The view already denormalises every label we need (stage + stage_label,
// campaign_name, assigned_rep_name, city_name/state_name), so no dimension here
// needs a join. That is the whole reason to report over the view rather than the
// table.
//
// Grants: lms_svc holds SELECT on lms.vw_dashboard_leads and on
// iam.vw_user_team_members (db_scripts/04_roles_and_grants.sql:597), which the
// 'team' scope predicate needs. Adding a dataset over a NEW relation requires an
// explicit GRANT there — the grants are enumerated per login, not wildcarded.
//
// See the authoring rules at the top of @platform/reporting/sql/dataset.ts before
// editing. In short: every fragment is authored here, nothing is interpolated
// from a request, and `sql.raw` is never used.

import { sql } from 'drizzle-orm';
import { CAPABILITY } from '@platform/rbac';
import type { DatasetDef } from '@platform/reporting/sql';

export const leadsDataset: DatasetDef = {
  key: 'lms.leads',
  label: 'Leads',
  description: 'Every lead, with its stage, source, campaign, owner and location.',
  product: 'lms',
  from: sql`lms.vw_dashboard_leads`,

  dimensions: [
    // ── Pipeline ──
    {
      key: 'stage',
      label: 'Stage',
      kind: 'string',
      expr: sql`stage`,
      labelExpr: sql`stage_label`,
      cardinality: 'low',
      description: 'Where the lead sits in the pipeline.',
    },
    {
      key: 'outcome',
      label: 'Outcome',
      kind: 'string',
      expr: sql`outcome`,
      labelExpr: sql`outcome_label`,
      cardinality: 'low',
      description: 'Why a lead left the pipeline. Null while still open.',
    },
    // Boolean stage flags, useful as both a breakdown and a filter.
    { key: 'is_rejected', label: 'Rejected', kind: 'boolean', expr: sql`is_rejected`, cardinality: 'low' },
    { key: 'is_terminated', label: 'Closed', kind: 'boolean', expr: sql`is_terminated`, cardinality: 'low' },
    {
      key: 'is_followup_overdue',
      label: 'Follow-up overdue',
      kind: 'boolean',
      expr: sql`is_followup_overdue`,
      cardinality: 'low',
    },

    // ── Acquisition ──
    { key: 'source', label: 'Source', kind: 'string', expr: sql`source`, cardinality: 'low' },
    { key: 'platform', label: 'Ad platform', kind: 'string', expr: sql`platform`, cardinality: 'low' },
    {
      key: 'campaign',
      label: 'Campaign',
      kind: 'string',
      expr: sql`campaign_name`,
      // Campaigns accumulate; a long-lived org has hundreds, so the UI should
      // push a topN rather than charting every one.
      cardinality: 'high',
    },

    // ── People ──
    {
      key: 'assigned_rep',
      label: 'Assigned to',
      kind: 'string',
      // Grouped by NAME, not by assigned_user_id: the id would need a label join
      // and every axis tick would be a uuid. Two reps sharing a full name would
      // merge — accepted, because the alternative is an unreadable chart. Filter
      // by `assigned_user_id` below when identity matters.
      expr: sql`assigned_rep_name`,
      cardinality: 'high',
    },
    {
      key: 'assigned_user_id',
      label: 'Assigned user',
      kind: 'uuid',
      expr: sql`assigned_user_id`,
      // Filter-only: grouping by uuid produces a chart no one can read. This is
      // the field to filter on when two reps share a name.
      groupable: false,
      cardinality: 'high',
    },

    // ── Location ──
    { key: 'city', label: 'City', kind: 'string', expr: sql`city_name`, cardinality: 'high' },
    { key: 'state', label: 'State', kind: 'string', expr: sql`state_name`, cardinality: 'low' },
    { key: 'country', label: 'Country', kind: 'string', expr: sql`country_name`, cardinality: 'low' },
    { key: 'org_name', label: 'Branch', kind: 'string', expr: sql`org_name`, cardinality: 'low' },

    // ── Time ──
    {
      key: 'created_at',
      label: 'Created',
      kind: 'timestamp',
      expr: sql`created_at`,
      buckets: ['day', 'week', 'month', 'quarter', 'year'],
      description: 'When the lead entered the system.',
    },
    {
      key: 'updated_at',
      label: 'Last updated',
      kind: 'timestamp',
      expr: sql`updated_at`,
      buckets: ['day', 'week', 'month', 'quarter', 'year'],
    },
    {
      key: 'scheduled_at',
      label: 'Follow-up due',
      kind: 'timestamp',
      expr: sql`scheduled_at`,
      buckets: ['day', 'week', 'month', 'quarter', 'year'],
    },

    // ── Contact details: filter-only ──
    // Reportable as a filter ("leads whose email contains acme") but never as a
    // breakdown — one group per lead.
    { key: 'email', label: 'Email', kind: 'string', expr: sql`email`, groupable: false, cardinality: 'high' },
    { key: 'phone', label: 'Phone', kind: 'string', expr: sql`phone`, groupable: false, cardinality: 'high' },
    {
      key: 'full_name',
      label: 'Lead name',
      kind: 'string',
      expr: sql`full_name`,
      groupable: false,
      cardinality: 'high',
    },
  ],

  measures: [
    // The reserved row-count measure every dataset exposes.
    { key: '*', label: 'Leads', expr: sql`1`, aggs: ['count'], kind: 'number' },
    {
      key: 'lead_id',
      label: 'Distinct leads',
      expr: sql`lead_id`,
      aggs: ['count_distinct'],
      kind: 'uuid',
      // Differs from the row count only when a future dataset revision joins
      // something one-to-many. Kept so that difference stays visible.
      description: 'Unique leads, ignoring duplicate rows.',
    },
    // NOTE: no sum/avg measures. vw_dashboard_leads carries no numeric fact —
    // there is no deal value on a lead today. Adding SUM over a surrogate id
    // would produce a number that looks like data and is noise, which is what
    // the per-measure `aggs` allowlist exists to prevent.
  ],

  scope: {
    org: sql`org_id`,
    // The view has no tenant_id column, so tenant-wide reporting is rejected for
    // this dataset rather than silently narrowed to one org. A tenant-wide leads
    // dataset needs the view to expose tenant_id first.
    owner: sql`assigned_user_id`,
    teamMember: sql`assigned_user_id`,
    // The view does NOT filter deleted rows — it selects ml.is_deleted as a
    // column. Every other read path excludes them, so a report that counted them
    // would disagree with the leads list.
    basePredicate: sql`NOT is_deleted`,
  },

  capability: CAPABILITY.LMS_REPORTS_VIEW,
  // Row scoping rides on the EXISTING leads ladder rather than a new one: a rep
  // who can only see their own leads in the list sees only their own leads in a
  // report. Reusing this key is what keeps the two consistent for free.
  scopeOperation: CAPABILITY.LMS_LEADS_VIEW,

  // marketing_leads grows without bound and the view is a nine-way join, so an
  // unbounded GROUP BY will seq-scan. Required range + statement_timeout is what
  // keeps that from becoming a production incident on the first large org.
  requiresDateRange: true,
  dateField: 'created_at',
  defaultWindowDays: 90,

  defaultSpec: {
    rows: [{ field: 'created_at', bucket: 'month' }],
    columns: [{ field: 'stage' }],
    chart: { type: 'bar_stacked', encoding: { measures: ['m1'], stacked: true, showLegend: true } },
  },
};
