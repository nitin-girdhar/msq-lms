import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import type { SessionUser } from '@crm/types';
import { LMS_RANKS } from '@lms/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import UsersClient from '@/components/users/UsersClient';

export const dynamic = 'force-dynamic';

interface OrgOption {
  id: string;
  name: string;
}

export default async function UsersPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (session.rank < LMS_RANKS.SSE) redirect('/dashboard/leads');

  const [usersRes, orgsRes] = await Promise.all([
    fetch(`${GATEWAY_URL}/users`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/orgs/all`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
  ]);

  let users: SessionUser[] = [];
  if (usersRes.ok) {
    const usersData = await usersRes.json() as { data?: Record<string, unknown>[] };
    const raw = Array.isArray(usersData.data) ? usersData.data : [];
    users = raw.map((u) => ({
      ...u,
      name: (u.full_name ?? u.name ?? '') as string,
      role: (u.role_name ?? u.role ?? '') as SessionUser['role'],
      role_label: (u.role_label ?? '') as string,
      rank: Number(u.rank ?? 0),
      org_id: (u.org_id ?? '') as string,
      org_name: (u.org_name ?? '') as string,
      tenant_id: (u.tenant_id ?? '') as string,
      tenant_name: (u.tenant_name ?? '') as string,
      manager_name: (u.manager_name ?? null) as string | null,
    })) as SessionUser[];
  }

  let orgs: OrgOption[] = [];
  if (orgsRes.ok) {
    const orgsData = await orgsRes.json() as { data?: Array<{ id: string; name: string }> };
    orgs = Array.isArray(orgsData.data) ? orgsData.data.map((o) => ({ id: o.id, name: o.name })) : [];
  }

  return <UsersClient users={users} actor={session} orgs={orgs} />;
}
