'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@platform/types';
import type { LeadView } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';
import { useOrgs } from '../../hooks/useOrgs';
import AssigneeBadge from '../assignments/AssigneeBadge';
import BulkAssignModal from './BulkAssignModal';

interface Props {
  actor: SessionUser;
}

export default function BulkAssignClient({ actor }: Props) {
  const { orgs, loading: orgsLoading } = useOrgs();
  const [orgId, setOrgId] = useState('');
  const [leads, setLeads] = useState<LeadView[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Roles that can't browse other branches only ever have their own org in
  // the list — mirrors the walk-in-lead org picker in AssignLeadModal.
  useEffect(() => {
    if (!orgId && orgs.length > 0) {
      setOrgId(orgs.find((o) => o.id === actor.org_id)?.id ?? orgs[0].id);
    }
  }, [orgs, orgId, actor.org_id]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLeadsLoading(true);
    setSelected(new Set());
    leadsApi
      .list({ org_ids: orgId, page_size: 5000 })
      .then((res) => {
        if (!cancelled) setLeads(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setLeads([]);
      })
      .finally(() => {
        if (!cancelled) setLeadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) => {
      const hay = `${l.full_name} ${l.phone ?? ''} ${l.stage_label} ${l.assigned_rep_name ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [leads, search]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.lead_id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Set(prev);
        filtered.forEach((l) => next.delete(l.lead_id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((l) => next.add(l.lead_id));
      return next;
    });
  };

  const toggleOne = (leadId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  };

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const refetchLeads = () => {
    if (!orgId) return;
    leadsApi.list({ org_ids: orgId, page_size: 5000 }).then((res) => setLeads(res.data ?? []));
  };

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0F172A]">Bulk Assign</h1>
        <p className="mt-1 text-xs text-[#64748B]">
          Select leads and hand them all to one person in a single action.
        </p>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {notice}
        </div>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-[#F1F5F9] p-3 sm:p-4">
          <select
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            disabled={orgsLoading || orgs.length <= 1}
            className="rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search name, phone, or stage…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[200px] flex-1 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
          />
          <span className="text-xs text-[#64748B]">
            {selected.size} selected of {filtered.length}
          </span>
          <button
            type="button"
            onClick={() => setAssignOpen(true)}
            disabled={selected.size === 0}
            className="rounded-xl bg-[#0b6cbf] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Assign selected
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[#F8FAFC] text-left text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">
              <tr>
                <th className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleAll}
                    disabled={filtered.length === 0}
                    aria-label="Select all"
                  />
                </th>
                <th className="px-4 py-2.5">Lead</th>
                <th className="px-4 py-2.5">Stage</th>
                <th className="px-4 py-2.5">Currently assigned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1F5F9]">
              {filtered.map((l) => (
                <tr key={l.lead_id} className="text-[#0F172A]">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(l.lead_id)}
                      onChange={() => toggleOne(l.lead_id)}
                      aria-label={`Select ${l.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="text-sm font-semibold">{l.full_name}</p>
                    {l.phone && <p className="text-[11px] text-[#64748B]">{l.phone}</p>}
                  </td>
                  <td className="px-4 py-2.5 text-[#475569]">{l.stage_label}</td>
                  <td className="px-4 py-2.5">
                    <AssigneeBadge
                      user={
                        l.assigned_rep_name || l.assigned_rep_email
                          ? { name: l.assigned_rep_name, email: l.assigned_rep_email ?? '' }
                          : null
                      }
                    />
                  </td>
                </tr>
              ))}
              {!leadsLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-xs text-[#64748B]">
                    No leads match.
                  </td>
                </tr>
              )}
              {leadsLoading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-xs text-[#64748B]">
                    Loading leads…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {assignOpen && orgId && (
        <BulkAssignModal
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          orgId={orgId}
          leadIds={selectedIds}
          onAssigned={(result) => {
            setAssignOpen(false);
            setSelected(new Set());
            setNotice(
              `${result.updated} lead${result.updated === 1 ? '' : 's'} assigned` +
                (result.skipped.length ? ` (${result.skipped.length} already on that assignee)` : '.'),
            );
            refetchLeads();
          }}
        />
      )}
    </div>
  );
}
