import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { getServerSession } from '@platform/ui-kit/server';
import { LeadsHistoryShell } from '@lms/web';

export const dynamic = 'force-dynamic';

export default async function LeadsHistoryPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  return <LeadsHistoryShell actor={result.session} />;
}
