import { serviceDb } from '@crm/db';
import { connectionManager } from '../connections/manager.js';
import { config } from '../config/index.js';

interface FollowUpLead {
  id: string;
  assigned_user_id: string;
  scheduled_at: string;
  org_id: string;
  tenant_id: string;
  lead_name: string;
}

// crm.marketing_leads.scheduled_at is the single source of truth for a lead's next follow-up
// due time (kept in sync on every create/reschedule/complete). This poller only ever reads it —
// overdue vs. due-soon is a pure comparison against NOW(), never a row mutation.
const notifiedDueKeys = new Set<string>();
const notifiedMissedKeys = new Set<string>();
let lastResetDate = '';

function resetIfNewDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastResetDate) {
    notifiedDueKeys.clear();
    notifiedMissedKeys.clear();
    lastResetDate = today;
  }
}

async function checkFollowUps(): Promise<void> {
  resetIfNewDay();

  const clientCount = connectionManager.getClientCount();
  if (clientCount === 0) return;

  try {
    const db = serviceDb();
    const rows = await db`
      SELECT
        ml.id,
        ml.assigned_user_id,
        ml.scheduled_at,
        ml.org_id,
        COALESCE(o.tenant_id::text, '') AS tenant_id,
        COALESCE(ml.full_name, ml.first_name || ' ' || ml.last_name, 'Unknown') AS lead_name
      FROM crm.marketing_leads ml
      JOIN crm.lead_stage lstg ON lstg.id = ml.stage_id
      JOIN entity.organizations o ON o.id = ml.org_id
      WHERE lstg.followup_required
        AND ml.scheduled_at IS NOT NULL
        AND ml.scheduled_at <= NOW() + make_interval(mins => ${config.followupLookaheadMinutes})
        AND ml.assigned_user_id IS NOT NULL
        AND ml.is_deleted = false
    ` as unknown as FollowUpLead[];

    console.log(`[followup-checker] Found ${rows.length} due/overdue follow-ups, ${clientCount} clients connected`);

    for (const row of rows) {
      const scheduledIso = new Date(row.scheduled_at).toISOString();
      const key = `${row.id}:${scheduledIso}`;
      const isOverdue = new Date(row.scheduled_at).getTime() < Date.now();
      const seen = isOverdue ? notifiedMissedKeys : notifiedDueKeys;
      if (seen.has(key)) continue;

      const eventType = isOverdue ? 'followup:missed' : 'followup:due';
      const message = isOverdue
        ? `Follow-up overdue for ${row.lead_name}`
        : `Follow-up due for ${row.lead_name}`;

      console.log(`[followup-checker] Notifying user=${row.assigned_user_id} for lead="${row.lead_name}" event=${eventType}`);

      const sent = connectionManager.sendToUser(row.assigned_user_id, eventType, {
        lead_id: row.id,
        message,
        scheduled_at: row.scheduled_at,
      });

      if (sent) seen.add(key);
    }
  } catch (err) {
    console.error('[followup-checker] Error checking follow-ups:', err);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startFollowUpChecker(): void {
  checkFollowUps();
  intervalHandle = setInterval(checkFollowUps, config.followupCheckIntervalMs);
}

export function stopFollowUpChecker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
