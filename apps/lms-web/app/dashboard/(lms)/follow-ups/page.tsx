import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenFollowUps } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { FollowUpsShell } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function FollowUpsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (!canOpenFollowUps(result.session)) redirect(fallbackPathForActor(result.session));
  return <FollowUpsShell actor={result.session} />;
}
