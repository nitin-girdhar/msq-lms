import { redirect } from 'next/navigation';
import { buildLoginUrl } from '@platform/ui-kit';
import type { SessionUser } from '@platform/types';
import { canOpenUsers } from '@lms/authz';
import { getServerSession, GATEWAY_URL } from '@platform/ui-kit/server';
import UsersClient from '@/components/users/UsersClient';
import { fallbackPathForActor } from '@/src/config/navigation';

export const dynamic = 'force-dynamic';

interface OrgOption {
  id: string;
  name: string;
}

export default async function UsersPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());
  const { session, cookieHeader } = result;
  if (!canOpenUsers(session)) redirect(fallbackPathForActor(session));

  // Two branch lists, because "which branches exist" and "which branches are
  // mine" are different questions: /orgs/all is the whole tenant and only a
  // tenant-wide actor may assign into it, while /auth/my-orgs is this actor's
  // own iam.user_org_mapping rows — the branches a multi-branch admin may
  // actually create users in.
  const [usersRes, orgsRes, myOrgsRes] = await Promise.all([
    fetch(`${GATEWAY_URL}/users`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/orgs/all`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
    fetch(`${GATEWAY_URL}/auth/my-orgs`, { headers: { cookie: cookieHeader }, cache: 'no-store' }),
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

  // A failed branch fetch is not fatal — the form falls back to the actor's own
  // branch — but it is not silent either. Swallowing it left the picker showing
  // a nameless chip with no hint that anything had gone wrong.
  let orgs: OrgOption[] = [];
  if (orgsRes.ok) {
    const orgsData = await orgsRes.json() as { data?: Array<{ id: string; name: string }> };
    orgs = Array.isArray(orgsData.data) ? orgsData.data.map((o) => ({ id: o.id, name: o.name })) : [];
  } else {
    console.error(`[users] GET ${GATEWAY_URL}/orgs/all failed: ${orgsRes.status} ${orgsRes.statusText}`);
  }

  let myOrgs: OrgOption[] = [];
  if (myOrgsRes.ok) {
    const myOrgsData = await myOrgsRes.json() as { data?: { orgs?: Array<{ org_id: string; org_name: string }> } };
    const raw = Array.isArray(myOrgsData.data?.orgs) ? myOrgsData.data.orgs : [];
    myOrgs = raw.map((o) => ({ id: o.org_id, name: o.org_name }));
  } else {
    console.error(`[users] GET ${GATEWAY_URL}/auth/my-orgs failed: ${myOrgsRes.status} ${myOrgsRes.statusText}`);
  }

  const branchesFailed = !orgsRes.ok || !myOrgsRes.ok;

  return <UsersClient users={users} actor={session} orgs={orgs} myOrgs={myOrgs} branchesFailed={branchesFailed} />;
}
