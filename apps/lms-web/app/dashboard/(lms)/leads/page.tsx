import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { getServerSession, getEnabledModules } from '@platform/ui-kit/server';
import { LeadDashboardShell } from '@lms/web';

export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const enabledModules = await getEnabledModules(result.cookieHeader);
  return (
    <LeadDashboardShell
      actor={result.session}
      enabledModules={enabledModules}
    />
  );
}
