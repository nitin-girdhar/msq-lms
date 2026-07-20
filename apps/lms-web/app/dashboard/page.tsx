import { redirect } from 'next/navigation';
import { getServerSession } from '@platform/ui-kit/server';
import { buildLoginUrl } from '@platform/ui-kit';

export const dynamic = 'force-dynamic';

export default async function DashboardHome() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  redirect('/dashboard/leads');
}
