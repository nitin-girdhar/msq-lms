import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import type { SessionUser } from '@crm/types';
import type { AssignmentView } from '@lms/web';
import { LMS_RANKS } from '@lms/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import { AssignmentsClient } from '@lms/web';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (session.rank < LMS_RANKS.SSE) redirect('/dashboard/leads');

  const [assignmentsRes, candidatesRes] = await Promise.all([
    fetch(`${GATEWAY_URL}/assignments`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/users/assignable`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
  ]);

  let assignments: AssignmentView[] = [];
  let candidates: SessionUser[] = [];
  if (assignmentsRes.ok) {
    const d = await assignmentsRes.json() as { data?: AssignmentView[] };
    assignments = Array.isArray(d.data) ? d.data : [];
  }
  if (candidatesRes.ok) {
    const d = await candidatesRes.json() as { data?: SessionUser[] };
    candidates = Array.isArray(d.data) ? d.data : [];
  }

  return (
    <AssignmentsClient
      actor={session}
      assignments={assignments}
      candidates={candidates}
    />
  );
}
