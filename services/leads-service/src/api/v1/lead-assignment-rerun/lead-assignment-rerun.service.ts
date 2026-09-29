import { logActivity } from '@platform/audit-log';
import * as repo from './lead-assignment-rerun.repository.js';
import type { RerunBody } from './lead-assignment-rerun.schema.js';

export async function rerunAutoAssignment(
  scope: repo.RerunScope,
  filters: RerunBody,
  dryRun: boolean,
): Promise<repo.RerunResult> {
  const result = await repo.rerunAutoAssignment(scope, filters, dryRun);

  // A preview changes nothing and is not an activity. A real run is: counts
  // only (no lead data), plus the filters it ran with.
  if (!dryRun) {
    await logActivity({
      action_type: 'lead_assignment_rerun',
      performed_by: scope.actorUserId,
      new_value: {
        tenant_id: scope.tenantId,
        org_ids: filters.org_ids,
        campaign_type_ids: filters.campaign_type_ids,
        candidates: result.candidates,
        assigned: result.assigned,
        left_unassigned: result.left_unassigned,
      },
    });
  }

  return result;
}
