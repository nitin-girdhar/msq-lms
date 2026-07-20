import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { LMS_RANKS } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { Placeholder } from '@platform/ui-kit';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (result.session.rank < LMS_RANKS.MANAGER) redirect('/dashboard/leads');

  return (
    <Placeholder
      title="Team"
      body="Members of your org and their current pipeline load."
    />
  );
}
