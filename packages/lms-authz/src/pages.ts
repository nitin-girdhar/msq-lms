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
 * under lms.leads, so it takes a plain can() check rather than
 * holdsUsableNode(): there is no sub-tree of operations beneath it that could
 * make it "usable".
 */
export function canOpenBulkAssign(actor: CapabilityHolder): boolean {
  return can(actor, CAPABILITY.LMS_LEADS_ASSIGN_BULK);
}

export function canOpenAnalytics(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.LMS_ANALYTICS);
}

/**
 * The Team screen — the people directory, scoped to whatever slice of the roster
 * the actor's `admin.team.view.*` rung allows.
 *
 * Gated on the OPERATION, not on the `team` scope. Asking for `.view.team`
 * specifically locked out a role granted `.view.org` and not `.view.team`,
 * despite that role having strictly WIDER reach. holdsUsableNode() asks the
 * question that actually matters — the operation is granted, and some scope
 * beneath it is too — and still fails closed, because a scope never inherits
 * and always needs its own grant row. resolveScope() then decides whose rows
 * they see.
 *
 * Duplicated as a one-liner rather than imported from @platform/team-web, which
 * owns the canonical copy: this package is authz, and taking a dependency on a
 * UI package to answer a capability question would invert the layering. If the
 * two ever need to disagree, that is the bug.
 */
export function canOpenTeam(actor: CapabilityHolder): boolean {
  return holdsUsableNode(actor, CAPABILITY.ADMIN_TEAM_VIEW);
}
