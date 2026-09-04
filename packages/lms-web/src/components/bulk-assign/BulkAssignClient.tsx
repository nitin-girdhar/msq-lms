'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@platform/types';
import { FilterField, MultiSelect, type SelectOption } from '@platform/ui-kit';
import type { LeadView, StageOption } from '../../types/leads';
import { leads as leadsApi } from '../../lib/api/client';
import { useOrgs } from '../../hooks/useOrgs';
import { MAX_PAGE_SIZE } from '../../hooks/useLeads';
import AssigneeBadge from '../assignments/AssigneeBadge';
import BulkAssignModal from './BulkAssignModal';

interface Props {
  actor: SessionUser;
}

// Sentinel for the "no assignee" bucket in the Assigned To filter. A lead's
// assigned_user_id is a UUID or null, so this cannot collide with a real one.
const UNASSIGNED = 'unassigned';

export default function BulkAssignClient({ actor }: Props) {
  const { orgs, loading: orgsLoading, error: orgsError } = useOrgs();
  const [orgId, setOrgId] = useState('');
  const [leads, setLeads] = useState<LeadView[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [search, setSearch] = useState('');
  // `null` means "every option", so a branch whose leads sit in stages the
  // previous branch never had is not silently filtered down to nothing. An
  // explicit list is stored only once the user picks one — same convention as
  // the Analytics filters.
  const [stagePick, setStagePick] = useState<readonly string[] | null>(null);
  const [assigneePick, setAssigneePick] = useState<readonly string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Retry to re-run the fetch effect without duplicating its body.
  const [reloadKey, setReloadKey] = useState(0);

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
    setLoadError(null);
    setSelected(new Set());
    // Both filters key on this branch's rows, so a pick carried over from the
    // last branch would hide leads the user came here to assign.
    setStagePick(null);
    setAssigneePick(null);
    leadsApi
      .list({ org_ids: orgId, active_only: 'true', page_size: MAX_PAGE_SIZE })
      .then((res) => {
        if (cancelled) return;
        setLeads(res.data ?? []);
        setStages((res.stage_options ?? []) as StageOption[]);
      })
      .catch((err) => {
        // Never swallow this. A failed request used to render exactly like an
        // empty branch, which is how a 500 from the leads query sat unnoticed:
        // the screen calmly reported "No leads in this branch" for a branch
        // holding hundreds of them.
        if (!cancelled) {
          setLeads([]);
          setStages([]);
          setLoadError(err instanceof Error ? err.message : 'Could not load leads for this branch.');
        }
      })
      .finally(() => {
        if (!cancelled) setLeadsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, reloadKey]);

  // Bulk assign only makes sense for leads still in play. The terminal-stage
  // exclusion is applied server-side via active_only (the same predicate Leads
  // History uses), so the page_size cap now bounds OPEN leads rather than
  // trimming the branch first and filtering afterwards.
  const openLeads = leads;

  // Only the stages this branch's open leads are actually in — a stage that can
  // match nothing is a filter that only ever empties the table. Ordered by the
  // lookup's sort_order so the list reads as the pipeline, not alphabetically.
  const stageOptions = useMemo<SelectOption[]>(() => {
    const present = new Set(openLeads.map((l) => l.stage_id));
    return [...stages]
      .filter((s) => present.has(s.id))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((s) => ({ id: s.id, label: s.label }));
  }, [stages, openLeads]);

  // Derived from the rows rather than /users/assignable: that endpoint answers
  // "who may I assign TO", which can omit a lead's current owner (a departed rep,
  // someone outside this actor's assign scope) — and every name in the CURRENTLY
  // ASSIGNED column has to be selectable here. It also gives Unassigned for free.
  const assigneeOptions = useMemo<SelectOption[]>(() => {
    const byId = new Map<string, string>();
    let hasUnassigned = false;
    for (const l of openLeads) {
      if (!l.assigned_user_id) hasUnassigned = true;
      else byId.set(l.assigned_user_id, l.assigned_rep_name || l.assigned_rep_email || 'Unnamed user');
    }
    const named = [...byId.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return hasUnassigned ? [{ id: UNASSIGNED, label: 'Unassigned' }, ...named] : named;
  }, [openLeads]);

  const stageSelected = useMemo(
    () => (stagePick === null ? stageOptions : stageOptions.filter((o) => stagePick.includes(String(o.id)))),
    [stageOptions, stagePick],
  );
  const assigneeSelected = useMemo(
    () => (assigneePick === null ? assigneeOptions : assigneeOptions.filter((o) => assigneePick.includes(String(o.id)))),
    [assigneeOptions, assigneePick],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const stageSet = stagePick === null ? null : new Set(stagePick);
    const assigneeSet = assigneePick === null ? null : new Set(assigneePick);
    return openLeads.filter((l) => {
      if (stageSet && !stageSet.has(l.stage_id)) return false;
      if (assigneeSet && !assigneeSet.has(l.assigned_user_id ?? UNASSIGNED)) return false;
      if (!q) return true;
      const hay = `${l.full_name} ${l.phone ?? ''} ${l.stage_label} ${l.assigned_rep_name ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [openLeads, search, stagePick, assigneePick]);

  const isFiltered = search.trim() !== '' || stagePick !== null || assigneePick !== null;

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

  const refetchLeads = () => setReloadKey((k) => k + 1);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold text-[#0F172A]">Bulk Assign</h1>
        <p className="mt-1 text-xs text-[#64748B]">
          Select open leads (excludes converted/unqualified) and hand them all to one person in a single action.
        </p>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {notice}
        </div>
      )}

      {orgsError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          Could not load the branch list: {orgsError}
        </div>
      )}

      <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
        {/* Narrow first, then assign: the branch and the two lookups come first,
            the free-text box last so it reads as "…and anything else". */}
        <div className="flex flex-wrap items-end gap-3 border-b border-[#F1F5F9] p-3 sm:p-4">
          {/* One branch in reach is the normal case for a branch-scoped role, and a
              greyed-out dropdown reads as a broken control rather than as "this
              is your branch" — so only render a picker when there is a choice. */}
          <FilterField label="Branch">
            {orgs.length > 1 ? (
              <select
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                disabled={orgsLoading}
                aria-label="Branch"
                className="h-[34px] rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20 disabled:cursor-not-allowed disabled:bg-[#F8FAFC]"
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="flex h-[34px] items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm font-semibold text-[#0F172A]">
                {orgsLoading ? 'Loading branch…' : (orgs[0]?.name ?? 'No branch available')}
              </span>
            )}
          </FilterField>

          <div className="w-52">
            <MultiSelect
              label="Stage"
              placeholder={leadsLoading ? 'Loading…' : 'None selected'}
              allLabel="All stages"
              selectAllLabel="Select all"
              maxChips={2}
              loading={leadsLoading}
              disabled={leadsLoading || stageOptions.length === 0}
              options={stageOptions}
              selected={stageSelected}
              onChange={(next) => setStagePick(next.map((o) => String(o.id)))}
            />
          </div>

          <div className="w-52">
            <MultiSelect
              label="Assigned To"
              placeholder={leadsLoading ? 'Loading…' : 'None selected'}
              allLabel="All assignees"
              selectAllLabel="Select all"
              maxChips={2}
              loading={leadsLoading}
              disabled={leadsLoading || assigneeOptions.length === 0}
              options={assigneeOptions}
              selected={assigneeSelected}
              onChange={(next) => setAssigneePick(next.map((o) => String(o.id)))}
            />
          </div>

          <div className="min-w-[240px] flex-1">
            <FilterField label="Search">
              <input
                type="search"
                placeholder="Search name, phone, or stage…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-[34px] w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 text-sm text-[#0F172A] shadow-sm focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
              />
            </FilterField>
          </div>

          <div className="ml-auto flex items-center gap-3 pb-0.5">
            <span className="text-sm text-[#64748B]">
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
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(l.lead_id)}
                      onChange={() => toggleOne(l.lead_id)}
                      aria-label={`Select ${l.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm font-semibold">{l.full_name}</p>
                    {l.phone && <p className="text-xs text-[#64748B]">{l.phone}</p>}
                  </td>
                  <td className="px-4 py-3 text-[#475569]">{l.stage_label}</td>
                  <td className="px-4 py-3">
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
              {!leadsLoading && loadError && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-xs">
                    <p role="alert" className="font-semibold text-red-700">Could not load leads for this branch.</p>
                    <p className="mt-1 text-[#64748B]">{loadError}</p>
                    <button
                      type="button"
                      onClick={() => setReloadKey((k) => k + 1)}
                      className="mt-3 rounded-lg border border-[#E2E8F0] bg-white px-3 py-1.5 font-semibold text-[#0b6cbf] shadow-sm hover:bg-[#F8FAFC]"
                    >
                      Retry
                    </button>
                  </td>
                </tr>
              )}
              {!leadsLoading && !loadError && filtered.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-xs text-[#64748B]">
                    {isFiltered
                      ? 'No leads match these filters.'
                      : orgs.length > 1
                        ? 'No open leads in this branch. Try another branch from the dropdown above.'
                        : 'No open leads in this branch.'}
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
          orgName={orgs.find((o) => o.id === orgId)?.name ?? ''}
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
