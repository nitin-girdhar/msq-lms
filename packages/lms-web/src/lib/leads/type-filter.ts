import { can, CAPABILITY } from '@platform/rbac';
import type { SessionUser } from '@platform/types';

// The Leads page campaign-type ("Type") filter lives in the LMS navbar, not on
// the page, so the two talk through the URL: the navbar writes ?types=<id,id>,
// LeadDashboardShell reads it. No shared provider between layout and page, and a
// filtered view survives a reload or a pasted link.
export const LEAD_TYPES_PARAM = 'types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Capability-driven: the filter exists only for a holder of
 * lms.leads.view.all_types — someone who can see more than one department's
 * pool. Everyone else already sees exactly their department's leads (RLS,
 * lms.fn_user_sees_campaign_type), so there is nothing to filter. leads-service
 * applies the same check and ignores campaign_type_ids from anyone else.
 */
export function canFilterLeadTypes(actor: SessionUser): boolean {
  return can(actor, CAPABILITY.LMS_LEADS_VIEW_ALL_TYPES);
}

/** The selected type ids from ?types=. Non-UUID tokens are dropped so a
 *  hand-edited URL can never turn into a 400 from the list endpoints. */
export function parseLeadTypesParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').filter((t) => UUID_RE.test(t));
}
