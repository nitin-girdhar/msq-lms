'use client';

import { useState } from 'react';
import type { SessionUser } from '@crm/types';
import { RANKS } from '@platform/authz';
import type { ApiClientView } from '@/src/lib/api/client';
import ApiClientsTable from './ApiClientsTable';
import CreateApiClientModal from './CreateApiClientModal';
import EditApiClientModal from './EditApiClientModal';

interface OrgOption {
  id: string;
  name: string;
}

interface Props {
  clients: ApiClientView[];
  orgs: OrgOption[];
  actor: SessionUser;
}

export default function ApiClientsClient({ clients, orgs, actor }: Props) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiClientView | null>(null);
  const isOrgAdmin = actor.rank < RANKS.TENANT_ADMIN;

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[#0F172A]">API Tokens</h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Manage credentials for the public API. Keys are shown once at creation — they cannot be retrieved again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699]"
        >
          New token
        </button>
      </div>

      <ApiClientsTable clients={clients} orgs={orgs} onEdit={setEditTarget} />

      <CreateApiClientModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        orgs={orgs}
        isOrgAdmin={isOrgAdmin}
        actorOrgId={actor.org_id}
      />

      {editTarget && (
        <EditApiClientModal
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          client={editTarget}
          orgs={orgs}
          isOrgAdmin={isOrgAdmin}
        />
      )}
    </div>
  );
}
