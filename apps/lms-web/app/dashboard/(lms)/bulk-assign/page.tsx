import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenBulkAssign } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { BulkAssignClient } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function BulkAssignPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session } = result;
  if (!canOpenBulkAssign(session)) redirect(fallbackPathForActor(session));

  return <BulkAssignClient actor={session} />;
}
