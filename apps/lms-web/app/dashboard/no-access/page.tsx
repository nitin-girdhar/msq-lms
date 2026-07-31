import { redirect } from 'next/navigation';
import { buildLoginUrl, Placeholder } from '@platform/ui-kit';
import { getServerSession } from '@platform/ui-kit/server';

export const dynamic = 'force-dynamic';

/**
 * Terminal landing for a signed-in user with no openable CRM page.
 *
 * Deliberately gated on the SESSION ONLY. Every other page here redirects to
 * fallbackPathForActor(), which lands on this route when the actor's nav comes
 * back empty — so if this page had a capability gate of its own it could bounce
 * too, and the whole set would loop. The dashboard layout has already confirmed
 * the actor can use the LMS product at all; someone reaching this has the tool
 * but no page beneath it, which is a grant to fix, not an error to report.
 */
export default async function NoAccessPage() {
  const result = await getServerSession();
  if (!result) redirect(buildLoginUrl());

  return (
    <Placeholder
      title="No CRM access"
      body="Your role does not currently grant access to any CRM screen. Ask an administrator to review your capabilities."
    />
  );
}
