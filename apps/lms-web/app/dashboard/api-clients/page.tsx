import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { RANKS } from '@platform/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import type { ApiClientView } from '@/src/lib/api/client';
import ApiClientsClient from '@/components/api-clients/ApiClientsClient';

export const dynamic = 'force-dynamic';

interface OrgOption {
  id: string;
  name: string;
}

export default async function ApiClientsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (session.rank < RANKS.ADMIN) redirect('/dashboard/leads');

  const [clientsRes, orgsRes] = await Promise.all([
    fetch(`${GATEWAY_URL}/api-clients`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/orgs/all`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
  ]);

  let clients: ApiClientView[] = [];
  if (clientsRes.ok) {
    const data = await clientsRes.json() as { data?: ApiClientView[] };
    clients = Array.isArray(data.data) ? data.data : [];
  }

  let orgs: OrgOption[] = [];
  if (orgsRes.ok) {
    const data = await orgsRes.json() as { data?: Array<{ id: string; name: string }> };
    orgs = Array.isArray(data.data) ? data.data.map((o) => ({ id: o.id, name: o.name })) : [];
  }

  return <ApiClientsClient clients={clients} orgs={orgs} actor={session} />;
}
