'use client';

import { useState } from 'react';
import type { SessionUser } from '@platform/types';
import { canManageUsers } from '@/src/lib/permissions';
import UsersTable from './UsersTable';
import CreateUserModal from './CreateUserModal';
import EditUserModal from './EditUserModal';

interface OrgOption {
  id: string;
  name: string;
}

interface Props {
  users: SessionUser[];
  actor: SessionUser;
  orgs: OrgOption[];
}

export default function UsersClient({ users, actor, orgs }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SessionUser | null>(null);

  const canCreate = canManageUsers(actor);

  const subtitle =
    actor.rank >= 80
      ? `${users.length} total · admin scope (all users)`
      : canCreate
        ? `${users.length} total · scoped to roles you can manage`
        : `${users.length} total · view-only`;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#0F172A]">Users</h1>
          <p className="mt-1 text-xs text-[#64748B]">{subtitle}</p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#095699]"
          >
            New user
          </button>
        )}
      </div>

      <UsersTable
        users={users}
        currentUserId={actor.id}
        actorRank={actor.rank}
        onEdit={setEditTarget}
      />

      {canCreate && (
        <CreateUserModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          actorRank={actor.rank}
          users={users}
          actor={actor}
        />
      )}

      {editTarget && (
        <EditUserModal
          open={editTarget !== null}
          onClose={() => setEditTarget(null)}
          user={editTarget}
          currentUserId={actor.id}
          actorRank={actor.rank}
          users={users}
          orgs={orgs}
        />
      )}
    </div>
  );
}
