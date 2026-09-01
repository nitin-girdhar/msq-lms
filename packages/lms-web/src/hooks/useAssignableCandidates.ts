'use client';

import { useEffect, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { users as usersApi } from '@platform/ui-kit';
import { can, CAPABILITY } from '@platform/rbac';
import { toAssignableUsers } from '../lib/users/assignable';

interface UseAssignableCandidatesReturn {
  candidates: SessionUser[];
}

/**
 * The people this actor may hand a lead to **in one branch**.
 *
 * `leadOrgId` is the branch of the lead in context, and it is the whole point of
 * this hook: iam.can_assign_to judges the write against the LEAD's org, so a
 * candidate from anywhere else is a name the picker offers and the server then
 * refuses. The server returns candidates across every branch the actor covers,
 * which for a Wingman mapped to six branches is a list where five sixths of the
 * choices fail — the shape users reported as "names from the wrong branch".
 *
 * Omitting `leadOrgId` deliberately falls back to full coverage, for the callers
 * with no single lead in context; pass it whenever there is one.
 *
 * Returns `[]` — not a stale list — for an actor without the assign capability,
 * and on a failed fetch. Ordering comes from toAssignableUsers (alphabetical).
 */
export function useAssignableCandidates(
  actor: SessionUser,
  leadOrgId?: string,
): UseAssignableCandidatesReturn {
  const [candidates, setCandidates] = useState<SessionUser[]>([]);
  // Capability, not a role-name allowlist: a tenant-defined role never matches a
  // list of built-in role names, and the pickers behind those roles came up empty.
  const canAssign = can(actor, CAPABILITY.LMS_LEADS_ASSIGN);

  useEffect(() => {
    if (!canAssign) { setCandidates([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const json = await usersApi.assignable(
          leadOrgId ? { product: 'lms', orgId: leadOrgId } : { product: 'lms' },
        );
        if (cancelled) return;
        setCandidates(toAssignableUsers(json.data));
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => { cancelled = true; };
  }, [canAssign, leadOrgId]);

  return { candidates };
}
