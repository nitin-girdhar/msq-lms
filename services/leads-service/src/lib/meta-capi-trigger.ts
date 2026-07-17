import { config } from '../config/index.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'] ?? '';

export function fireCapiAutoTrigger(
  marketingLeadId: string,
  orgId: string,
  newStageId: string,
): void {
  fetch(`${config.metaServiceUrl}/api/v1/capi/auto-trigger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': INTERNAL_SECRET,
    },
    body: JSON.stringify({ marketingLeadId, orgId, newStageId }),
  }).catch((err) => {
    console.error('[meta-capi] Failed to fire auto-trigger:', (err as Error).message);
  });
}
