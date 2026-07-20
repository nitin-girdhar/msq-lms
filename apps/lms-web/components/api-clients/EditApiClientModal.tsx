'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_SCOPES } from '@platform/auth-constants';
import { apiClients as apiClientsApi } from '@/src/lib/api/client';
import type { ApiClientView } from '@/src/lib/api/client';
import { Modal } from '@platform/ui-kit';

interface OrgOption {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  client: ApiClientView;
  orgs: OrgOption[];
  isOrgAdmin: boolean;
}

export default function EditApiClientModal({ open, onClose, client, orgs, isOrgAdmin }: Props) {
  const router = useRouter();
  const [name, setName] = useState(client.name);
  const [scopes, setScopes] = useState<string[]>(client.scopes);
  const [orgIds, setOrgIds] = useState<string[]>(client.org_ids);
  const [scopeAllOrgs, setScopeAllOrgs] = useState(client.scope_all_orgs);
  const [expiresAt, setExpiresAt] = useState(client.expires_at ? client.expires_at.slice(0, 10) : '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (pending) return;
    onClose();
  };

  const toggleScope = (scope: string) => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  };

  const toggleOrg = (id: string) => {
    setOrgIds((prev) => (prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (scopes.length === 0) {
      setError('Select at least one permission.');
      return;
    }
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      setError('Expiry must be in the future.');
      return;
    }

    setPending(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        scopes,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      };
      if (!isOrgAdmin) {
        body.scope_all_orgs = scopeAllOrgs;
        if (!scopeAllOrgs) body.org_ids = orgIds;
      }

      await apiClientsApi.update(client.id, body);
      onClose();
      router.refresh();
    } catch (err: unknown) {
      const body = (err as { body?: { details?: Record<string, string[]> } }).body;
      const detail = body?.details ? Object.values(body.details).flat().join('; ') : undefined;
      setError(detail || (err instanceof Error ? err.message : 'Network error.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title={`Edit "${client.name}"`} locked={pending}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <p className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 text-xs text-[#475569]">
          Key: <span className="font-mono">{client.key_prefix}…</span> — the key itself cannot be viewed or changed here. Use Rotate to issue a new one.
        </p>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ec-name" className="text-xs font-semibold text-[#0F172A]">Name *</label>
          <input
            id="ec-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={pending}
            className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[#0F172A]">Permissions *</span>
          <div className="flex flex-col gap-1.5 rounded-xl border border-[#E2E8F0] p-3">
            {API_SCOPES.map((scope) => (
              <label key={scope} className="flex cursor-pointer items-center gap-2 text-xs text-[#0F172A]">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-[#E2E8F0] text-[#0b6cbf] focus:ring-[#0b6cbf]/20"
                />
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[#0F172A]">Branches</span>
          {isOrgAdmin ? (
            <p className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2.5 text-xs text-[#475569]">
              Scoped to your branch only.
            </p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-[#0F172A]">
                <input
                  type="checkbox"
                  checked={scopeAllOrgs}
                  onChange={(e) => setScopeAllOrgs(e.target.checked)}
                  disabled={pending}
                  className="h-4 w-4 rounded border-[#E2E8F0] text-[#0b6cbf] focus:ring-[#0b6cbf]/20"
                />
                <span>All branches (tenant-wide)</span>
              </label>
              {!scopeAllOrgs && (
                <div className="mt-1 flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-xl border border-[#E2E8F0] p-3">
                  {orgs.length === 0 && <span className="text-xs text-[#94A3B8]">No branches found.</span>}
                  {orgs.map((org) => (
                    <label key={org.id} className="flex cursor-pointer items-center gap-2 text-xs text-[#0F172A]">
                      <input
                        type="checkbox"
                        checked={orgIds.includes(org.id)}
                        onChange={() => toggleOrg(org.id)}
                        disabled={pending}
                        className="h-4 w-4 rounded border-[#E2E8F0] text-[#0b6cbf] focus:ring-[#0b6cbf]/20"
                      />
                      <span>{org.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ec-expires" className="text-xs font-semibold text-[#0F172A]">Expires on</label>
          <input
            id="ec-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            disabled={pending}
            min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
            className="rounded-xl border border-[#E2E8F0] bg-white px-3 py-2.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
          />
          <span className="text-[11px] text-[#94A3B8]">Leave blank to clear the expiry (never expires).</span>
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={handleClose} disabled={pending}
            className="rounded-xl border border-[#E2E8F0] bg-white px-4 py-2 text-sm font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60">
            Cancel
          </button>
          <button type="submit" disabled={pending} aria-busy={pending}
            className="inline-flex items-center gap-2 rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-70">
            {pending && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden />
            )}
            {pending ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
