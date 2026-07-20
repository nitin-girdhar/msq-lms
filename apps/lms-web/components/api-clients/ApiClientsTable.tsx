'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClients as apiClientsApi } from '@/src/lib/api/client';
import type { ApiClientView } from '@/src/lib/api/client';

interface OrgOption {
  id: string;
  name: string;
}

interface Props {
  clients: ApiClientView[];
  orgs: OrgOption[];
  onEdit: (client: ApiClientView) => void;
}

// Pinned locale + timezone so the SSR pass (Node's default locale/timezone)
// and the client hydration pass render identical text — an unpinned
// toLocaleDateString() causes a hydration mismatch when they differ.
function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function branchLabel(client: ApiClientView, orgs: OrgOption[]): string {
  if (client.scope_all_orgs) return 'All branches (tenant-wide)';
  if (client.org_ids.length === 0) return '—';
  const names = client.org_ids.map((id) => orgs.find((o) => o.id === id)?.name ?? id);
  return names.join(', ');
}

function statusLabel(client: ApiClientView): { text: string; className: string } {
  if (client.revoked_at || !client.is_active) return { text: 'Revoked', className: 'bg-slate-100 text-slate-600' };
  if (client.expires_at && new Date(client.expires_at).getTime() <= Date.now()) {
    return { text: 'Expired', className: 'bg-amber-100 text-amber-700' };
  }
  return { text: 'Active', className: 'bg-emerald-100 text-emerald-700' };
}

export default function ApiClientsTable({ clients, orgs, onEdit }: Props) {
  const router = useRouter();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const handleRevoke = async (client: ApiClientView) => {
    if (!window.confirm(`Revoke "${client.name}"? Any integration using this key will stop working immediately.`)) {
      return;
    }
    setRevokingId(client.id);
    try {
      await apiClientsApi.revoke(client.id);
      router.refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to revoke token.');
    } finally {
      setRevokingId(null);
    }
  };

  if (clients.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-[#E2E8F0] bg-white p-8 text-center text-sm text-[#64748B]">
        No API tokens yet. Create one to get started.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-[#E2E8F0] bg-white shadow-sm">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="border-b border-[#E2E8F0] bg-[#F8FAFC] text-xs font-semibold uppercase tracking-wide text-[#64748B]">
          <tr>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Key</th>
            <th className="px-4 py-3">Scopes</th>
            <th className="px-4 py-3">Branches</th>
            <th className="px-4 py-3">Expires</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#E2E8F0]">
          {clients.map((client) => {
            const status = statusLabel(client);
            const revoked = !!client.revoked_at || !client.is_active;
            return (
              <tr key={client.id}>
                <td className="px-4 py-3 font-medium text-[#0F172A]">{client.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-[#64748B]">{client.key_prefix}…</td>
                <td className="px-4 py-3 text-xs text-[#475569]">{client.scopes.join(', ')}</td>
                <td className="px-4 py-3 text-xs text-[#475569]">{branchLabel(client, orgs)}</td>
                <td className="px-4 py-3 text-xs text-[#475569]">
                  {client.expires_at ? formatDate(client.expires_at) : 'Never'}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${status.className}`}>
                    {status.text}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-[#64748B]">
                  {formatDate(client.created_at)}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(client)}
                      disabled={revoked}
                      className="rounded-lg border border-[#E2E8F0] px-3 py-1.5 text-xs font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(client)}
                      disabled={revoked || revokingId === client.id}
                      className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {revokingId === client.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
