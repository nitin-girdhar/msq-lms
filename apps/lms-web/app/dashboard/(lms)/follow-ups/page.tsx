import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { getServerSession } from '@platform/ui-kit/server';
import { FollowUpsShell } from '@lms/web';

export const dynamic = 'force-dynamic';

export default async function FollowUpsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  return <FollowUpsShell actor={result.session} />;
}
