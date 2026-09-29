import { BadRequestError } from '../../../lib/errors.js';
import * as repo from './internal.repository.js';
import { reclassifyCampaign as runCampaignReclassify } from '../../../services/campaign-reclassify.service.js';
import type { ReclassifyParams, ReclassifyResult } from '../../../services/campaign-reclassify.service.js';
import type { ReassignOrgLeadsParams } from './internal.repository.js';

export async function reassignOrgLeads(params: ReassignOrgLeadsParams): Promise<{ reassigned_count: number }> {
  if (params.toUserId !== null && params.toUserId === params.fromUserId) {
    throw new BadRequestError('Cannot reassign leads to the user being changed');
  }
  const reassignedCount = await repo.reassignOrgLeads(params);
  return { reassigned_count: reassignedCount };
}

export async function findKnownContacts(
  tenantId: string,
  emails: string[],
  phoneKeys: string[],
): Promise<{ known_emails: string[]; known_phone_keys: string[] }> {
  const result = await repo.findKnownLeadContacts(tenantId, emails, phoneKeys);
  return { known_emails: result.emails, known_phone_keys: result.phoneKeys };
}

// Thin pass-through: the fan-out is its own service module because it is shared
// domain logic (relabel + conservative re-route), not an internal-API concern.
export async function reclassifyCampaign(params: ReclassifyParams): Promise<ReclassifyResult> {
  return runCampaignReclassify(params);
}
