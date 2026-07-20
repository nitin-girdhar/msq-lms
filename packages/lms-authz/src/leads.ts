import { LMS_RANKS } from './ranks.js';

export function canViewAllLeads(rank: number): boolean {
  return rank >= LMS_RANKS.SSE;
}

export function canEditLead(rank: number): boolean {
  return rank >= LMS_RANKS.SE;
}

export function canDeleteLead(rank: number): boolean {
  return rank >= LMS_RANKS.ADMIN;
}

export function canAssignLead(rank: number): boolean {
  return rank >= LMS_RANKS.SSE;
}
