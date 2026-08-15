import { describe, expect, it } from 'vitest';
import { CAPABILITY } from '@platform/rbac';
import { canAssignToUser } from './assignments.js';
import { LMS_RANKS } from './ranks.js';

const holder = (...caps: string[]) => ({ capabilities: caps });

const ACTOR_ID = 'actor-1';
const OTHER_ID = 'other-1';

describe('canAssignToUser', () => {
  it('allows a peers-scoped actor to assign to themselves', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_PEERS);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.SSE, ACTOR_ID, ACTOR_ID)).toBe(true);
  });

  it('allows a peers-scoped actor to assign to a strictly lower rank', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_PEERS);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.SE, ACTOR_ID, OTHER_ID)).toBe(true);
  });

  it('denies a peers-scoped actor targeting a strictly higher rank', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_PEERS);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.MANAGER, ACTOR_ID, OTHER_ID)).toBe(false);
  });

  // Self-assignment is deliberately outside the ladder: claiming a lead you
  // are already working is not "handing work down", and iam.can_assign_to()
  // has always allowed it on the PATCH /leads/:id path.
  it('allows a reports-only actor targeting themselves', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_REPORTS);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.SSE, ACTOR_ID, ACTOR_ID)).toBe(true);
  });

  it('allows an actor with no assign capability at all to target themselves', () => {
    const actor = holder();
    expect(canAssignToUser(actor, LMS_RANKS.SE, LMS_RANKS.SE, ACTOR_ID, ACTOR_ID)).toBe(true);
  });

  it('allows a reports-only actor targeting a strictly lower rank', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_REPORTS);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.SE, ACTOR_ID, OTHER_ID)).toBe(true);
  });

  it('denies an actor with none of the assign scopes targeting someone else', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN);
    expect(canAssignToUser(actor, LMS_RANKS.SSE, LMS_RANKS.SE, ACTOR_ID, OTHER_ID)).toBe(false);
  });

  it('allows an any-scoped actor to target anyone below admin, including a senior', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_ANY);
    expect(canAssignToUser(actor, LMS_RANKS.MANAGER, LMS_RANKS.SR_MANAGER, ACTOR_ID, OTHER_ID)).toBe(true);
  });

  it('denies any target at or above admin rank, regardless of scope', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_ANY);
    expect(canAssignToUser(actor, LMS_RANKS.ADMIN, LMS_RANKS.ADMIN, ACTOR_ID, OTHER_ID)).toBe(false);
  });

  // The admin-target block outranks the self shortcut: an org_admin is never a
  // lead assignee, not even their own.
  it('denies an admin-rank actor targeting themselves', () => {
    const actor = holder(CAPABILITY.LMS_LEADS_ASSIGN, CAPABILITY.LMS_LEADS_ASSIGN_ANY);
    expect(canAssignToUser(actor, LMS_RANKS.ADMIN, LMS_RANKS.ADMIN, ACTOR_ID, ACTOR_ID)).toBe(false);
  });
});
