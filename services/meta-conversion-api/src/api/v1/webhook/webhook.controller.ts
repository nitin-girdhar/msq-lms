import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getIntegrationById, getGlobalIntegration, type MetaIntegration } from '../../../services/integration.service.js';
import { fetchLeadFromMeta } from '../../../services/meta-api.service.js';
import { syncLeadToDatabase, resolveLeadPlatform, isMetaTestLead } from '../../../services/lead-sync.service.js';
import { resolveOrgId, resolveTenantAndOrg } from '../../../services/page-org-map.service.js';
import { verifyHmacSignature } from '../../../lib/hmac.js';
import { pgNotify } from '@platform/db';
import { config } from '../../../config/index.js';

const MetaWebhookBodySchema = z.object({
  object: z.literal('page'),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            leadgen_id: z.string(),
            page_id: z.string(),
            form_id: z.string().optional(),
            adgroup_id: z.string().optional(),
            ad_id: z.string().optional(),
            created_time: z.number().optional(),
          }),
        }),
      ),
    }),
  ),
});

// Resolves the Meta app credentials for a request: a specific tenant's app
// when the URL carries :integrationId, or the shared cross-tenant app
// (tenant_id IS NULL) when the callback URL omits it.
async function resolveIntegration(integrationId: string | undefined): Promise<MetaIntegration | null> {
  return integrationId ? getIntegrationById(integrationId) : getGlobalIntegration();
}

export async function handleWebhookChallenge(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { integrationId } = request.params as { integrationId?: string };
  const qs = request.query as Record<string, string>;

  const mode = qs['hub.mode'];
  const token = qs['hub.verify_token'];
  const challenge = qs['hub.challenge'];

  if (!mode || !token || !challenge) {
    return reply.status(400).send({ error: 'Missing hub.mode, hub.verify_token, or hub.challenge' });
  }

  const integration = await resolveIntegration(integrationId);
  if (!integration) {
    return reply.status(404).send({ error: 'Integration not found' });
  }

  if (mode === 'subscribe' && token === integration.verify_token) {
    return reply.status(200).send(challenge);
  }

  return reply.status(403).send({ error: 'Webhook verification failed' });
}

export async function handleWebhookPost(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { integrationId } = request.params as { integrationId?: string };

  const integration = await resolveIntegration(integrationId);
  if (!integration) {
    return reply.status(404).send({ error: 'Integration not found' });
  }

  // HMAC verification
  const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    return reply.status(400).send({ error: 'Raw body unavailable for signature verification' });
  }

  const signatureHeader = request.headers['x-hub-signature-256'] as string | undefined;
  const hmacResult = verifyHmacSignature(
    rawBody,
    signatureHeader,
    integration.app_secret,
    config.allowUnsignedWebhooks,
  );

  if (!hmacResult.valid) {
    // Previously a bare 401 with no log at all, which made the two very
    // different causes indistinguishable: a rotated app_secret (our problem,
    // every lead is being dropped) and a forged request (not our problem).
    request.log.warn(
      {
        evt: 'webhook.hmac_failed',
        integrationId: integration.id,
        signaturePresent: Boolean(signatureHeader),
        reason: hmacResult.error,
      },
      'Webhook signature verification failed',
    );
    return reply.status(401).send({ error: hmacResult.error });
  }

  const body = MetaWebhookBodySchema.parse(hmacResult.parsedBody);
  const results: Array<{ leadId: string; status: string }> = [];

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'leadgen') continue;

      const leadId = change.value.leadgen_id;

      try {
        const rawLead = await fetchLeadFromMeta(
          leadId,
          integration.access_token,
          integration.graph_api_version,
        );

        rawLead.field_data = rawLead.field_data ?? [];

        // form_id is the routing key, but the webhook event doesn't
        // guarantee it — the Graph API lead-detail fetch above is the
        // reliable source. Resolve the owning org only after that fetch.
        const formId = rawLead.form_id ?? change.value.form_id;

        // Per-tenant app: tenant is already known, scope the org lookup to
        // it. Shared app (integration.tenant_id is null): tenant isn't
        // known yet either — resolve both from the page/form mapping,
        // which is globally unique.
        const mapping = integration.tenant_id
          ? await resolveOrgId(integration.tenant_id, change.value.page_id, formId)
          : await resolveTenantAndOrg(change.value.page_id, formId);

        if (!mapping) {
          request.log.warn(
            {
              evt: 'webhook.lead_unmapped',
              metaLeadId: leadId,
              pageId: change.value.page_id,
              formId: formId ?? null,
              integrationId: integration.id,
            },
            'No org mapping for Meta lead — skipping',
          );
          results.push({ leadId, status: 'unmapped' });
          continue;
        }

        const tenantId = integration.tenant_id ?? ('tenantId' in mapping ? mapping.tenantId : undefined);

        if (isMetaTestLead(rawLead.field_data)) {
          request.log.info(
            {
              evt: 'webhook.lead_skipped_test_lead',
              metaLeadId: leadId,
              orgId: mapping.orgId,
              tenantId,
              pageId: change.value.page_id,
              formId: formId ?? null,
              integrationId: integration.id,
            },
            'Skipped Meta test lead (placeholder field data)',
          );
          results.push({ leadId, status: 'skipped_test_lead' });
          continue;
        }

        // Meta Graph API returns created_time as an ISO string; the
        // webhook change event carries it as a unix timestamp number.
        // Prefer the webhook value (already a number) and fall back to
        // parsing the Graph API string into epoch seconds.
        let createdTime: number | undefined = change.value.created_time;
        if (createdTime === undefined && rawLead.created_time) {
          const parsed = typeof rawLead.created_time === 'number'
            ? rawLead.created_time
            : Math.floor(new Date(rawLead.created_time).getTime() / 1000);
          if (!Number.isNaN(parsed)) createdTime = parsed;
        }

        // Meta returns `platform` per-lead (a single form/campaign can run across
        // Facebook, Instagram, and WhatsApp placements at once) — prefer that over
        // the static per-(page,form) mapping.platform config value, which is now
        // only a fallback for when Meta omits the field or returns an unrecognized
        // value (never crash/drop the lead over an unexpected platform string).
        const platform = resolveLeadPlatform(rawLead.platform, mapping.platform, (rawValue) => {
          request.log.warn({ evt: 'webhook.unknown_platform', leadId, rawValue }, 'Unrecognized Meta lead platform');
        });

        const syncResult = await syncLeadToDatabase(mapping.orgId, {
          id: rawLead.id,
          form_id: formId ?? 'unknown',
          page_id: change.value.page_id,
          platform,
          ...(createdTime !== undefined ? { created_time: createdTime } : {}),
          ...(rawLead.ad_id !== undefined || change.value.ad_id !== undefined
            ? { ad_id: rawLead.ad_id ?? change.value.ad_id }
            : {}),
          ...(rawLead.adset_id !== undefined ? { adset_id: rawLead.adset_id } : {}),
          ...(rawLead.campaign_id !== undefined ? { campaign_id: rawLead.campaign_id } : {}),
          field_data: rawLead.field_data,
        }, integration.field_mappings);

        request.log.info(
          {
            evt: 'webhook.lead_synced',
            metaLeadId: leadId,
            marketingLeadId: syncResult.marketingLeadId,
            orgId: mapping.orgId,
            duplicate: syncResult.isDuplicate,
          },
          'Lead synced',
        );

        if (!syncResult.isDuplicate) {
          pgNotify('crm_events', {
            type: 'lead:created',
            lead_id: syncResult.marketingLeadId,
            org_id: mapping.orgId,
            tenant_id: tenantId,
            assigned_user_id: null,
            actor_id: 'system',
            ts: Date.now(),
          }).catch((err: unknown) => {
            // Fire-and-forget by design — a failed notify must not fail the
            // webhook, since Meta would retry the whole delivery. But swallowing
            // it silently meant a broken realtime feed looked identical to a
            // healthy one.
            request.log.error(
              { evt: 'pgnotify.failed', err, channel: 'crm_events', marketingLeadId: syncResult.marketingLeadId },
              'Failed to publish crm_events notification',
            );
          });
        }

        results.push({ leadId, status: syncResult.isDuplicate ? 'duplicate' : 'synced' });
      } catch (leadError) {
        // Pass the error through as `err` rather than pre-stringifying it. The
        // shared serializer strips the axios request config (which carries the
        // Meta access token) and truncates + scrubs the upstream response body,
        // which is where lead PII used to arrive: leads-service echoes the
        // rejected fields back, and that message was being logged verbatim.
        request.log.error(
          { evt: 'webhook.lead_sync_failed', err: leadError, metaLeadId: leadId, integrationId: integration.id },
          'Failed to sync Meta lead',
        );
        results.push({ leadId, status: 'error' });
      }
    }
  }

  return reply.status(200).send({ received: true, processed: results.length, results });
}
