// ── LMS product rank scale (P1.3) ───────────────────────────────────────────
// The LMS sales ladder, owned by @lms/authz. Ranks are only comparable WITHIN
// LMS. Mirrors lms.roles.rank in db_scripts/17_init-per-product-roles.sql:
//   read_only 0 · sales_representative 20 · senior_sales_executive 40 ·
//   org_manager 60 · org_sr_manager 70 · lms_admin 80
// (numerically identical to the former shared sales ladder, so LMS behavior is
// preserved). Cross-org / tenant-wide capabilities are NOT expressible on this
// scale — they are platform concerns keyed on platform_role (see business-rules).
import { ANCHOR_RANK, DEFAULT_ROLE_RANK } from '@platform/rbac';

export const LMS_RANKS = {
  READ_ONLY:  ANCHOR_RANK.READ_ONLY,
  SE:         DEFAULT_ROLE_RANK.SALES_REPRESENTATIVE,
  SSE:        DEFAULT_ROLE_RANK.SENIOR_SALES_EXECUTIVE,
  MANAGER:    DEFAULT_ROLE_RANK.ORG_MANAGER,
  SR_MANAGER: DEFAULT_ROLE_RANK.ORG_SR_MANAGER,
  ADMIN:      ANCHOR_RANK.ORG_ADMIN,
} as const;
