import { createLogger } from '@platform/logger';
import { config } from '../config/index.js';

const INTERNAL_SECRET = process.env['INTERNAL_SERVICE_SECRET'] ?? '';

// Fired from the service layer, which has no request-scoped logger, so this
// helper carries its own. Previously it used console.error, which bypasses
// levels, redaction and JSON structure — the output could not be queried at all.
const log = createLogger({ service: 'leads-service', nodeEnv: config.nodeEnv });

/**
 * lms.lead_sources.name values for leads that Meta itself captured.
 *
 * Only these leads may have conversion feedback sent back to Meta — a lead that
 * came from the website form, a walk-in or a referral is not Meta's to hear
 * about, and firing the auto-trigger for one only burns a round-trip to
 * meta-conversion-api to be told SKIPPED. Gating here keeps the call from
 * happening at all; meta-conversion-api re-checks the same rule for the manual
 * POST /meta/crm-event path.
 *
 * Mirrors META_LEAD_SOURCE_NAMES in meta-conversion-api's lead-sync.service.ts
 * (a separate service, so it cannot be imported). Both match the source rows
 * seeded by db_scripts/reference_data/04_lms_catalog_templates.sql.
 */
export const META_LEAD_SOURCE_NAMES: readonly string[] = ['facebook', 'instagram', 'whatsapp'];

interface AutoTriggerResponse {
  success?: boolean;
  status?: string;
  reason?: string;
  reasonCode?: string;
  logId?: string;
}

/**
 * Notifies meta-conversion-api that a lead changed stage, so it can send the
 * mapped Conversions API event back to Meta.
 *
 * Deliberately not awaited: a lead's stage update must not fail or slow down
 * because Meta feedback is unavailable. But "not awaited" previously meant
 * "unobservable" — the response was discarded, so a 401 from a mismatched
 * INTERNAL_SERVICE_SECRET, or a SKIPPED outcome because no CAPI event is mapped
 * to the stage, produced no signal on either side of the call. The outcome is
 * now logged here as well as in meta-conversion-api.
 */
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
  })
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as AutoTriggerResponse;

      if (!response.ok) {
        log.error(
          {
            evt: 'capi.auto_trigger.rejected',
            httpStatus: response.status,
            marketingLeadId,
            orgId,
            newStageId,
          },
          'meta-conversion-api rejected the auto-trigger',
        );
        return;
      }

      // A 200 means "handled", not "sent" — the endpoint answers 200 for
      // SUCCESS, SKIPPED and FAILED alike, so the body is the only signal.
      const level = body.status === 'SUCCESS' ? 'debug' : 'info';
      log[level](
        {
          evt: 'capi.auto_trigger.result',
          outcome: body.status,
          reason_code: body.reasonCode,
          marketingLeadId,
          orgId,
          newStageId,
        },
        'CAPI auto-trigger result',
      );
    })
    .catch((err: unknown) => {
      log.error(
        { evt: 'capi.auto_trigger.failed', err, marketingLeadId, orgId, newStageId },
        'Failed to fire CAPI auto-trigger',
      );
    });
}
