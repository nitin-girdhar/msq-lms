import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import { canOpenApiClients, checkManageApiClientsAccess } from '@lms/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import type { ApiClientView } from '@/src/lib/api/client';
import ApiClientsClient from '@/components/api-clients/ApiClientsClient';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

interface OrgOption {
  id: string;
  name: string;
}

export default async function ApiClientsPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (!canOpenApiClients(session)) redirect(fallbackPathForActor(session));

  const [clientsRes, orgsRes] = await Promise.all([
    fetch(`${GATEWAY_URL}/api-clients`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/orgs/all`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
  ]);

  // A 403 here is not an empty list — it is the service saying this role may not
  // read API clients at all, which canOpenApiClients() let through because
  // holdsUsableNode() is satisfied by `lms.apiclients.manage` alone. Swallowing
  // it rendered an empty table that looked like "no tokens yet". Bounce instead,
  // the same way the page guard above does.
  if (clientsRes.status === 403) redirect(fallbackPathForActor(session));

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

  return (
    <ApiClientsClient
      clients={clients}
      orgs={orgs}
      actor={session}
      canManage={checkManageApiClientsAccess(session)}
    />
  );
}
