import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import type { AssignmentView } from '@lms/web';
import { canOpenAssignments } from '@lms/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import { AssignmentsClient } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (!canOpenAssignments(session)) redirect(fallbackPathForActor(session));

  // Assignees are not fetched here. This page spans branches, and one list for
  // all of them is wrong for every row: the assignee modal fetches the roster of
  // the branch its own lead lives in, which is the set iam.can_assign_to will
  // actually accept.
  const assignmentsRes = await fetch(`${GATEWAY_URL}/assignments`, {
    headers: { cookie: cookieHeader },
    cache: 'no-store',
  });

  let assignments: AssignmentView[] = [];
  if (assignmentsRes.ok) {
    const d = await assignmentsRes.json() as { data?: AssignmentView[] };
    assignments = Array.isArray(d.data) ? d.data : [];
  }

  return <AssignmentsClient actor={session} assignments={assignments} />;
}
