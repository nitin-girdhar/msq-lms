import { redirect } from 'next/navigation';
import { getServerSession } from '@platform/ui-kit/server';
import { buildLoginUrl } from '@platform/ui-kit';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  // The first page this actor can open, not a hardcoded /dashboard/leads — now
  // that leads guards itself, sending everyone there would bounce anyone whose
  // role does not hold it.
  redirect(fallbackPathForActor(result.session));
}
