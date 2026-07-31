import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenTeam } from '@lms/authz';
import { getServerSession } from '@platform/ui-kit/server';
import { Placeholder } from '@platform/ui-kit';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  if (!canOpenTeam(result.session)) redirect(fallbackPathForActor(result.session));

  return (
    <Placeholder
      title="Team"
      body="Members of your org and their current pipeline load."
    />
  );
}
