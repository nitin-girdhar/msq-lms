import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenLeadsHistory } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { LeadsHistoryShell } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function LeadsHistoryPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (!canOpenLeadsHistory(result.session)) redirect(fallbackPathForActor(result.session));
  return <LeadsHistoryShell actor={result.session} />;
}
