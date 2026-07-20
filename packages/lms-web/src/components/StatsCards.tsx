'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SessionUser } from '@platform/types';
import type { LeadView } from '../types/leads';
import type { CardFilter } from './dashboard/LeadDashboardShell';
import { LMS_RANKS as RANKS } from '@lms/authz';

function useRelativeTime(date: Date | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!date) { setLabel(''); return; }
    const update = () => {
      const secs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (secs < 10)  return setLabel('just now');
      if (secs < 60)  return setLabel(`${secs}s ago`);
      const mins = Math.floor(secs / 60);
      if (mins < 60)  return setLabel(`${mins}m ago`);
      setLabel(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    update();
    const id = setInterval(update, 15_000);
    return () => clearInterval(id);
  }, [date]);
  return label;
}

function IconPeople() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6 5.87a4 4 0 100-8 4 4 0 000 8zm6-12a4 4 0 11-8 0 4 4 0 018 0zm-12 0a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}
function IconPersonPlus() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-6-3a4 4 0 100 8 4 4 0 000-8zm-6 8s-1 0-1-1 1-4 7-4 7 3 7 4-1 1-1 1H3z" />
    </svg>
  );
}
function IconPhone() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498A1 1 0 0121 17.72V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
    </svg>
  );
}
function IconXCircle() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}
function IconCalendarCheck() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 14l2 2 4-4" />
    </svg>
  );
}
function IconUserSlash() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 3l18 18" />
    </svg>
  );
}
function IconBell() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
        d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" />
    </svg>
  );
}

interface CardProps {
  label: string;
  count: number;
  total: number;
  iconBg: string;
  iconColor: string;
  icon: React.ReactNode;
  isHero?: boolean;
  timeLabel?: string;
  filterId: CardFilter;
  activeFilter: CardFilter;
  onFilterChange: (f: CardFilter) => void;
}

function StatCard({ label, count, total, iconBg, iconColor, icon, isHero, timeLabel, filterId, activeFilter, onFilterChange }: CardProps) {
  const pct      = total > 0 ? Math.round((count / total) * 100) : 0;
  const isActive = activeFilter === filterId;

  return (
    <button
      onClick={() => onFilterChange(filterId)}
      className={[
        'text-left flex flex-col gap-1 rounded-xl px-3 py-2.5 flex-1 min-w-[110px]',
        'border shadow-sm transition-all duration-150 cursor-pointer',
        isActive
          ? 'bg-[#0b6cbf] border-[#0b6cbf] shadow-md ring-2 ring-[#0b6cbf]/20'
          : 'bg-white border-[#E2E8F0] hover:shadow-md hover:border-[#93C5FD]',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-1.5">
        <span className={`text-[9px] font-semibold uppercase tracking-widest leading-tight ${isActive ? 'text-blue-100' : 'text-[#64748B]'}`}>
          {label}
        </span>
        <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${isActive ? 'bg-white/20 text-white' : `${iconBg} ${iconColor}`}`}>
          <span className="[&>svg]:w-3.5 [&>svg]:h-3.5">{icon}</span>
        </div>
      </div>

      <div className="flex items-end gap-1.5">
        <span className={`font-bold tabular-nums ${isHero ? 'text-xl' : 'text-lg'} ${isActive ? 'text-white' : 'text-[#0F172A]'}`}>
          {count}
        </span>
        {!isHero && (
          <span className={`text-[11px] font-semibold mb-px ${isActive ? 'text-blue-100' : ''}`}
            style={!isActive ? { color: pct > 0 ? '#16A34A' : '#94A3B8' } : undefined}>
            {pct}%
          </span>
        )}
      </div>

      {isHero ? (
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${isActive ? 'bg-green-300' : 'bg-[#16A34A]'}`} />
          <span className={`text-[9px] ${isActive ? 'text-blue-100' : 'text-[#64748B]'}`}>
            {timeLabel ? `Updated ${timeLabel}` : 'Loading…'}
          </span>
        </div>
      ) : (
        <p className={`text-[9px] ${isActive ? 'text-blue-100' : 'text-[#94A3B8]'}`}>of total leads</p>
      )}
    </button>
  );
}

interface Props {
  stats: { total: number; lastUpdated: Date | null; serverTotal: number };
  leads: LeadView[];
  actor: SessionUser;
  activeFilter: CardFilter;
  onFilterChange: (f: CardFilter) => void;
  hideUnassigned?: boolean;
}

export default function StatsCards({ stats, leads, actor, activeFilter, onFilterChange, hideUnassigned }: Props) {
  const timeLabel = useRelativeTime(stats.lastUpdated);

  const counts = useMemo(() => {
    const isSalesTier  = actor.rank < RANKS.SSE;
    return {
      new:            leads.filter(l => l.stage === 'new').length,
      callAttempted:  leads.filter(l => l.stage === 'contacting').length,
      unqualified:    leads.filter(l => l.stage === 'unqualified').length,
      visitScheduled: leads.filter(l => l.stage === 'qualified').length,
      converted:      leads.filter(l => l.stage === 'converted').length,
      // Sourced from marketing_leads → lead_stage.followup_required (per lead's current stage),
      // not a separately-fetched stage-name list.
      followUp: leads.filter(l =>
        l.followup_required &&
        (!isSalesTier || l.assigned_user_id === actor.id)
      ).length,
      unassigned: leads.filter(l => !l.assigned_user_id).length,
    };
  }, [leads, actor]);

  const total = stats.serverTotal;

  return (
    <div className="px-4 sm:px-5 py-1.5">
      <div className="flex flex-wrap gap-1.5">
        <StatCard label="TOTAL LEADS" count={total} total={total} iconBg="bg-[#EFF6FF]" iconColor="text-[#0A6BA8]"
          icon={<IconPeople />} isHero timeLabel={timeLabel} filterId="all" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="NEW LEADS" count={counts.new} total={total} iconBg="bg-blue-50" iconColor="text-[#0A6BA8]"
          icon={<IconPersonPlus />} filterId="new" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="FOLLOW-UP REQUIRED" count={counts.followUp} total={total} iconBg="bg-orange-50" iconColor="text-orange-500"
          icon={<IconBell />} filterId="followUp" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="CONTACTING" count={counts.callAttempted} total={total} iconBg="bg-amber-50" iconColor="text-amber-600"
          icon={<IconPhone />} filterId="callAttempted" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="VISIT SCHEDULED" count={counts.visitScheduled} total={total} iconBg="bg-teal-50" iconColor="text-teal-600"
          icon={<IconCalendarCheck />} filterId="visitScheduled" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="CONVERTED" count={counts.converted} total={total} iconBg="bg-purple-50" iconColor="text-purple-600"
          icon={<IconTrophy />} filterId="converted" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        <StatCard label="UNQUALIFIED LEADS" count={counts.unqualified} total={total} iconBg="bg-red-50" iconColor="text-red-500"
          icon={<IconXCircle />} filterId="unqualified" activeFilter={activeFilter} onFilterChange={onFilterChange} />

        {!hideUnassigned && (
          <StatCard label="UNASSIGNED" count={counts.unassigned} total={total} iconBg="bg-slate-50" iconColor="text-slate-500"
            icon={<IconUserSlash />} filterId="unassigned" activeFilter={activeFilter} onFilterChange={onFilterChange} />
        )}
      </div>
    </div>
  );
}
