import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenFollowUps } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { FollowUpsShell } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

// `?leadId=` is the deep link the Web Push follow-up notification opens, so
// tapping it lands on that lead rather than the bare grid. It is a HINT ONLY:
// the shell resolves it against the follow-ups the API already returned for
// this actor, never by fetching the id directly, so an unknown or foreign id
// just renders the normal grid. searchParams is a Promise on Next 15.
export default async function FollowUpsPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (!canOpenFollowUps(result.session)) redirect(fallbackPathForActor(result.session));
  const { leadId } = await searchParams;
  return <FollowUpsShell actor={result.session} focusLeadId={leadId} />;
}
