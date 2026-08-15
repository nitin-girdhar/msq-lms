import { can, CAPABILITY, type CapabilityHolder } from '@platform/rbac';
import { LMS_RANKS } from './ranks.js';

// Who a lead can be assigned to is a capability-scope question, not a rank
// comparison: db_scripts/reference_data/02_capabilities.sql seeds a
// reports < peers < any ladder under lms.leads.assign. Reading rank/id
// directly here (as this used to) drifts from that seeded intent — e.g. it
// blocked self-assignment for every actor even though senior_sales_executive
// and above are granted lms.leads.assign.peers precisely to allow it.
//
// Claiming a lead for YOURSELF needs no assign grant. Taking work is not the
// same act as handing it to someone else, and the rest of the product already
// assumes so: iam.can_assign_to() (the PATCH /leads/:id path) has always
// returned TRUE for self, and LeadEditModal auto-assigns an unassigned lead to
// whoever marks it rejected — a flow plain sales_representatives rely on. The
// ladder below therefore governs only assignment to OTHERS; keeping self
// behind it would both break that flow and leave this function disagreeing
// with the database function guarding the very same operation.
export function canAssignToUser(
  actor: CapabilityHolder,
  actor_rank: number,
  target_rank: number,
  actor_id: string,
  target_user_id: string,
): boolean {
  if (target_rank >= LMS_RANKS.ADMIN) return false;
  if (actor_id === target_user_id) return true;

  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_ANY)) return true;
  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_PEERS)) return target_rank <= actor_rank;
  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_REPORTS)) return target_rank < actor_rank;
  return false;
}
