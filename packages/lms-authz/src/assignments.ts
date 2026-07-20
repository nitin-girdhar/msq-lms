import { LMS_RANKS } from './ranks.js';

export function canAssignToUser(
  actor_rank: number,
  target_rank: number,
  actor_id: string,
  target_user_id: string,
): boolean {
  if (target_rank >= LMS_RANKS.ADMIN) return false;
  if (actor_id === target_user_id) return false;
  if (actor_rank < target_rank) return false;
  return true;
}
