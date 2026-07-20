import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { RANKS } from '@platform/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { AnalyticsClient } from '@lms/web';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session } = result;
  if (session.rank < RANKS.ADMIN) redirect('/dashboard/leads');
  return <AnalyticsClient actorRank={session.rank} orgId={session.org_id} />;
}
