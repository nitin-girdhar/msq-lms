import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenLeads } from '@lms/authz';
import { getServerSession, getEnabledModules } from '@platform/ui-kit/server';
import { LeadDashboardShell } from '@lms/web';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (!canOpenLeads(result.session)) redirect(fallbackPathForActor(result.session));
  const enabledModules = await getEnabledModules(result.cookieHeader);
  return (
    <LeadDashboardShell
      actor={result.session}
      enabledModules={enabledModules}
    />
  );
}
