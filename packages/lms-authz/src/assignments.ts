import { can, CAPABILITY, type CapabilityHolder } from '@platform/rbac';
import { LMS_RANKS } from './ranks.js';

// Who a lead can be assigned to is a capability-scope question, not a rank
// comparison: db_scripts/reference_data/02_capabilities.sql seeds a
// reports < peers < any ladder under lms.leads.assign, where "peers" is
// explicitly documented as including the actor themselves. Reading rank/id
// directly here (as this used to) drifts from that seeded intent — e.g. it
// blocked self-assignment for every actor even though senior_sales_executive
// and above are granted lms.leads.assign.peers precisely to allow it.
export function canAssignToUser(
  actor: CapabilityHolder,
  actor_rank: number,
  target_rank: number,
  actor_id: string,
  target_user_id: string,
): boolean {
  if (target_rank >= LMS_RANKS.ADMIN) return false;

  const isSelf = actor_id === target_user_id;

  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_ANY)) return true;
  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_PEERS)) return target_rank <= actor_rank;
  if (can(actor, CAPABILITY.LMS_LEADS_ASSIGN_REPORTS)) return !isSelf && target_rank < actor_rank;
  return false;
}
