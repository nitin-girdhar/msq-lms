// ── The lms.leads dataset ─────────────────────────────────────────────────────
// @platform/reporting has its own 257-test suite against a synthetic fixture
// dataset. These tests are about THIS dataset: that it is internally consistent,
// that it compiles to the SQL we intend against the real view, and that its
// scoping behaves for a rep vs a manager vs an analyst.
//
// The engine's own tests cannot catch a wrong column name here, and neither can
// tsc — `sql\`stage_lable\`` is a perfectly valid fragment. The compile assertions
// below are the cheapest guard short of a live database.

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CAPABILITY, type CapabilityHolder } from '@platform/rbac';
import { assertDatasetValid, buildReportQuery, toDatasetMeta } from '@platform/reporting/sql';
import { parseReportSpec, specForDataset, type ReportSpec } from '@platform/reporting';
import { leadsDataset } from '../datasets/leads.dataset.js';
import { lmsDatasets } from '../datasets/index.js';

const dialect = new PgDialect();
const render = (q: SQL) => {
  const out = dialect.sqlToQuery(q);
  return { text: out.sql, params: [...out.params] };
};

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const actor = (...capabilities: string[]): CapabilityHolder => ({ capabilities });

const analyst = actor(
  CAPABILITY.LMS_REPORTS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW_ORG,
);
const rep = actor(
  CAPABILITY.LMS_REPORTS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW_OWN,
);
const manager = actor(
  CAPABILITY.LMS_REPORTS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW,
  CAPABILITY.LMS_LEADS_VIEW_TEAM,
);

const ctx = (who: CapabilityHolder) => ({
  actor: who,
  role: 'org_admin',
  orgId: ORG,
  tenantId: TENANT,
  userId: USER,
  orgTimezone: 'Asia/Kolkata',
});

/** A valid spec against this dataset. The date filter is mandatory here. */
function spec(overrides: Partial<ReportSpec> = {}): ReportSpec {
  return {
    version: 1,
    dataset: 'lms.leads',
    rows: [{ field: 'stage' }],
    columns: [],
    measures: [{ id: 'm1', field: '*', agg: 'count' }],
    filters: [{ field: 'created_at', op: 'last_n_days', values: [90] }],
    chart: { type: 'bar', encoding: { measures: ['m1'] } },
    ...overrides,
  };
}

describe('registry', () => {
  it('boots and registers lms.leads', () => {
    // createDatasetRegistry validates at module load, so importing it at all is
    // most of this assertion.
    expect(lmsDatasets.keys()).toEqual(['lms.leads']);
  });

  it('passes internal consistency validation', () => {
    expect(() => assertDatasetValid(leadsDataset)).not.toThrow();
  });

  it('is hidden from an actor without the reports capability', () => {
    expect(lmsDatasets.listFor(actor(CAPABILITY.LMS_LEADS_VIEW))).toEqual([]);
    expect(lmsDatasets.listFor(analyst).map((d) => d.key)).toEqual(['lms.leads']);
  });
});

describe('dataset metadata', () => {
  const meta = toDatasetMeta(leadsDataset, analyst);

  it('leaks no SQL fragments or scope columns to the client', () => {
    const json = JSON.stringify(meta);
    // The relation, the base predicate, and the scope columns are all internal.
    // `assigned_user_id` is deliberately absent from this list: it is a PUBLIC
    // dimension key (the filter-only field for telling apart two reps with the
    // same display name), not a leaked column reference.
    expect(json).not.toContain('vw_dashboard_leads');
    expect(json).not.toContain('is_deleted');
    expect(json).not.toContain('org_id');

    // And no SQL-carrying property survived onto any field.
    for (const field of [...meta.dimensions, ...meta.measures]) {
      for (const prop of ['expr', 'labelExpr', 'sortExpr']) {
        expect(prop in field).toBe(false);
      }
    }
  });

  it('declares the mandatory 90-day window so the UI can pre-fill it', () => {
    expect(meta).toMatchObject({
      requiresDateRange: true,
      dateField: 'created_at',
      defaultWindowDays: 90,
    });
  });

  it('marks contact fields filter-only', () => {
    for (const key of ['email', 'phone', 'full_name', 'assigned_user_id']) {
      expect(meta.dimensions.find((d) => d.key === key)).toMatchObject({
        groupable: false,
        filterable: true,
      });
    }
  });

  it('offers only count aggregations — the view carries no numeric fact', () => {
    // If a deal-value column is ever added to the view, this is the test that
    // should be updated deliberately rather than a sum quietly appearing.
    expect(meta.measures.map((m) => ({ key: m.key, aggs: [...m.aggs] }))).toEqual([
      { key: '*', aggs: ['count'] },
      { key: 'lead_id', aggs: ['count_distinct'] },
    ]);
  });

  it('produces a default spec that validates', () => {
    const seeded = specForDataset(meta);
    expect(parseReportSpec(seeded).ok).toBe(true);
  });
});

describe('compiled SQL', () => {
  it('selects from the view and excludes deleted rows', () => {
    const { text, params } = render(buildReportQuery(leadsDataset, spec(), ctx(analyst)).query);
    expect(text).toContain('FROM lms.vw_dashboard_leads');
    // The view exposes is_deleted as a COLUMN rather than filtering it, so a
    // report that omitted this would disagree with every other read path.
    expect(text).toContain('NOT is_deleted');
    expect(text).toContain('org_id = $1::uuid');
    expect(params[0]).toBe(ORG);
  });

  it('resolves stage to its label column, not a surrogate id', () => {
    const { text } = render(buildReportQuery(leadsDataset, spec(), ctx(analyst)).query);
    expect(text).toContain('stage AS d0');
    expect(text).toContain('stage_label AS d0_label');
  });

  it('buckets created_at in the org timezone', () => {
    const { text, params } = render(
      buildReportQuery(
        leadsDataset,
        spec({ rows: [{ field: 'created_at', bucket: 'month' }] }),
        ctx(analyst),
      ).query,
    );
    expect(text).toContain("date_trunc('month', created_at AT TIME ZONE $");
    expect(params).toContain('Asia/Kolkata');
  });

  it('builds the stacked leads-over-time report the default spec describes', () => {
    const { text } = render(
      buildReportQuery(
        leadsDataset,
        spec({
          rows: [{ field: 'created_at', bucket: 'month' }],
          columns: [{ field: 'stage' }],
          chart: { type: 'bar_stacked', encoding: { measures: ['m1'], stacked: true } },
        }),
        ctx(analyst),
      ).query,
    );
    expect(text).toContain('date_trunc');
    expect(text).toContain('stage AS c0');
    expect(text).toContain('COUNT(*)::int AS m0');
  });
});

describe('required date range', () => {
  it('rejects a spec with no date filter', () => {
    // The guard that keeps an unbounded GROUP BY off a nine-way-join view.
    expect(() => buildReportQuery(leadsDataset, spec({ filters: [] }), ctx(analyst))).toThrow(
      /needs a date range/,
    );
  });

  it('accepts an absolute from/to range', () => {
    expect(() =>
      buildReportQuery(
        leadsDataset,
        spec({ filters: [{ field: 'created_at', op: 'between', values: ['2026-01-01', '2026-04-01'] }] }),
        ctx(analyst),
      ),
    ).not.toThrow();
  });
});

describe('row scoping rides the existing leads ladder', () => {
  it('a rep sees only their own leads', () => {
    const built = buildReportQuery(leadsDataset, spec(), ctx(rep));
    const { text, params } = render(built.query);
    expect(built.appliedScope).toBe('own');
    expect(text).toContain('assigned_user_id = $');
    expect(params).toContain(USER);
  });

  it('a manager sees their team', () => {
    const built = buildReportQuery(leadsDataset, spec(), ctx(manager));
    const { text } = render(built.query);
    expect(built.appliedScope).toBe('team');
    expect(text).toContain('iam.vw_user_team_members');
  });

  it('an analyst sees the whole org and no extra predicate', () => {
    const built = buildReportQuery(leadsDataset, spec(), ctx(analyst));
    expect(built.appliedScope).toBe('org');
    expect(render(built.query).text).not.toContain('vw_user_team_members');
  });

  it('the three scopes produce genuinely different SQL', () => {
    // The assertion that matters for scheduled email later: if these ever
    // converge, one recipient is seeing another's rows.
    const sqlFor = (who: CapabilityHolder) => render(buildReportQuery(leadsDataset, spec(), ctx(who)).query).text;
    const [own, team, org] = [sqlFor(rep), sqlFor(manager), sqlFor(analyst)];
    expect(new Set([own, team, org]).size).toBe(3);
  });

  it('refuses tenant-wide reporting — the view has no tenant_id', () => {
    expect(() =>
      buildReportQuery(leadsDataset, spec(), {
        ...ctx(analyst),
        role: 'tenant_admin',
        tenantWide: true,
      }),
    ).toThrow(/no tenant column/);
  });

  it('403s an actor holding no scope under lms.leads.view', () => {
    expect(() =>
      buildReportQuery(leadsDataset, spec(), ctx(actor(CAPABILITY.LMS_REPORTS_VIEW, CAPABILITY.LMS_LEADS_VIEW))),
    ).toThrow(/do not hold any scope/);
  });
});
