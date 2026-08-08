// ── CRM page authority (Tier C3: capability-driven) ─────────────────────────
//
// One helper per routed CRM page, each naming the SAME capability its nav entry
// names in apps/lms-web/src/config/navigation.ts — and asking the SAME question
// about it, via holdsUsableNode() rather than a plain can().
//
// The predicate choice is the point, not an implementation detail. filterNav()
// hides an item whose node has nothing granted BENEATH it, because a page you
// can open but whose every operation is denied is a blank screen, not access.
// A guard using can() alone would be looser than the sidebar: the link would be
// hidden while the URL still opened, which is the render-then-403 bug this whole
// model exists to remove. Same predicate on both sides means "visible in the
// nav" and "openable by URL" cannot drift apart.
//
// These replaced rank redirects (`session.rank < RANKS.ADMIN`, etc). A rank
// threshold can only describe the ladder the platform ships with, so a
// tenant-defined role — which iam.user_roles now allows — was granted the
// capability, got the nav item, and was then bounced by the guard behind it.
// It also cut the other way: org_admin sits at 980 and so passed every one of
// those gates no matter what its capability grants said, which is why denying
// lms.analytics hid the tab but left /dashboard/analytics wide open.
import { can, holdsUsableNode, CAPABILITY, type CapabilityHolder } from '@platform/rbac';

export function canOpenLeads(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_LEADS);
}

export function canOpenFollowUps(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_FOLLOWUPS);
}

export function canOpenLeadsHistory(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_HISTORY);
}

export function canOpenAssignments(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_ASSIGNMENTS);
}

/**
 * Bulk Lead Assignment has no page node of its own — it's an operation scope
 * under lms.leads, gated the same way canOpenTeam gates a scope: a plain
 * can() check rather than holdsUsableNode(), since there's no sub-tree of
 * operations beneath it to require being "usable".
 */
export function canOpenBulkAssign(actor: CapabilityHolder): boolean {
  return can(actor, CAPABILITY.LMS_LEADS_ASSIGN_BULK);
}

export function canOpenAnalytics(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_ANALYTICS);
}

export function canOpenUsers(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_USERS);
}

/**
 * /dashboard/team has no nav entry and no page node of its own — it is the
 * team-scoped slice of the people directory.
 *
 * Gated on the SCOPE rather than a nav node, deliberately: a scope always needs
 * its own grant row and never inherits, so this fails closed instead of
 * switching itself on the moment someone is granted the `lms` tool.
 */
export function canOpenTeam(actor: CapabilityHolder): boolean {
  return can(actor, CAPABILITY.LMS_USERS_VIEW_TEAM);
}
