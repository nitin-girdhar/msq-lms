import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenAnalytics } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { AnalyticsClient } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session } = result;
  if (!canOpenAnalytics(session)) redirect(fallbackPathForActor(session));
  return <AnalyticsClient actorRank={session.rank} orgId={session.org_id} />;
}
