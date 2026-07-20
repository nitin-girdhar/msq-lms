// ── LMS product rank scale (P1.3) ───────────────────────────────────────────
// The LMS sales ladder, owned by @lms/authz. Ranks are only comparable WITHIN
// LMS. Mirrors lms.roles.rank in db_scripts/17_init-per-product-roles.sql:
//   read_only 0 · sales_representative 20 · senior_sales_executive 40 ·
//   org_manager 60 · org_sr_manager 70 · lms_admin 80
// (numerically identical to the former shared sales ladder, so LMS behavior is
// preserved). Cross-org / tenant-wide capabilities are NOT expressible on this
// scale — they are platform concerns keyed on platform_role (see business-rules).
export const LMS_RANKS = {
  READ_ONLY: 0,
  SE: 20,
  SSE: 40,
  MANAGER: 60,
  SR_MANAGER: 70,
  ADMIN: 80,
} as const;
