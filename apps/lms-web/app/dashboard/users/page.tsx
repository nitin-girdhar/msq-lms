import { redirect } from 'next/navigation';
import { adminWebOrigin } from '@platform/ui-kit';

export const dynamic = 'force-dynamic';

/**
 * Retired. The people directory is one shared module (@platform/team-web) and is
 * mounted in the admin console, not here — it manages fitness, HR-only and every
 * other kind of user, so living under the CRM was always the wrong home. Its
 * capability moved with it, lms.users -> admin.team.
 *
 * Kept as a redirect rather than deleted: this path is bookmarked and linked to.
 * The target is cross-origin, so no capability check happens here — admin-web's
 * own layout and page guard decide what the visitor may see when they land, and
 * duplicating that decision on this side could only disagree with it.
 */
export default function UsersPage() {
  redirect(`${adminWebOrigin()}/dashboard/team`);
}
