'use client';

import { useCallback, useEffect, useState } from 'react';
import { createApiClient } from '@platform/ui-kit';

// LMS-local view of the tasks linked to a lead. Post repo-split (Phase5 P-4) LMS
// must not import @task/web, so instead of embedding the task-web `TaskLeadSection`
// component we read the shared gateway's /tasks endpoints directly — a D8-compliant
// cross-product read via API — and render plain labels (no task-web chips). The
// gateway entitlement-gates /tasks by prefix (D6): if the tasks module isn't
// licensed the list 403s and the section hides itself. Visibility scope is left to
// the backend (scope='own'); the tasks-service + RLS enforce real access. (The
// original team-lead "see team tasks on this lead" nicety is dropped deliberately
// to avoid coupling LMS to the task rank scale.)
const { request } = createApiClient('/api');

interface LinkedTask {
  id: string;
  title: string;
  priority_label: string | null;
  status_label: string;
  due_at: string | null;
}

interface Props {
  leadId: string;
}

function formatDueDate(iso: string | null): string {
  if (!iso) return 'No due date';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function LeadTasksSection({ leadId }: Props) {
  const [items, setItems] = useState<LinkedTask[]>([]);
  const [moduleUnavailable, setModuleUnavailable] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({
      related_entity_type: 'lead',
      related_entity_id: leadId,
      scope: 'own',
      include_completed: 'true',
      limit: '50',
    }).toString();
    request<{ data: LinkedTask[] }>(`/tasks?${qs}`)
      .then((res) => setItems(res.data))
      .catch(() => setModuleUnavailable(true));
  }, [leadId]);

  useEffect(() => { load(); }, [load]);

  if (moduleUnavailable) return null;

  const createTask = async () => {
    const trimmed = title.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      await request<{ data: { id: string } }>('/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: trimmed,
          related_entity_type: 'lead',
          related_entity_id: leadId,
          status_name: 'todo',
          priority_name: 'medium',
        }),
      });
      setTitle('');
      setShowCreate(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="px-6 py-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Tasks</p>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="text-xs font-semibold text-[#0b6cbf] hover:underline"
        >
          {showCreate ? 'Cancel' : '+ Add task'}
        </button>
      </div>

      {showCreate && (
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createTask(); }}
            placeholder="New task about this lead…"
            className="w-full rounded-lg border border-[#E2E8F0] px-3 py-2 text-sm text-[#0F172A] focus:border-[#0b6cbf] focus:outline-none focus:ring-2 focus:ring-[#0b6cbf]/20"
          />
          <button
            type="button"
            onClick={() => void createTask()}
            disabled={creating || !title.trim()}
            className="shrink-0 rounded-lg bg-[#0b6cbf] px-3 py-2 text-xs font-semibold text-white hover:bg-[#095699] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {creating ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      {items.length === 0 ? (
        <p className="text-xs text-[#94A3B8]">No tasks linked to this lead yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-lg border border-[#F1F5F9] px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-[#0F172A]">{t.title}</span>
              {t.priority_label && (
                <span className="shrink-0 rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-semibold text-[#475569]">
                  {t.priority_label}
                </span>
              )}
              <span className="shrink-0 rounded-full bg-[#EFF6FF] px-2 py-0.5 text-[10px] font-semibold text-[#0b6cbf]">
                {t.status_label}
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-[#94A3B8]">{formatDueDate(t.due_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
