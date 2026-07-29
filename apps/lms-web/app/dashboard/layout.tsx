import { redirect } from 'next/navigation';
import { NotificationProvider, productOrigins, authOrigin, usableProducts, landingFor } from '@platform/ui-kit';
import { AppNavbar, AppSidebar, MobileSidebar } from '@platform/ui-kit/shell';
import { requireSession } from '@platform/ui-kit/server';
import { DASHBOARD_NAV } from '@/src/config/navigation';
import NotificationBell from '@/components/layout/NotificationBell';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { session, licensedProducts } = await requireSession('/dashboard');
  const origins = productOrigins();
  const usable = usableProducts(licensedProducts, session);

  // The LMS shell had no product gate, so an unlicensed tenant or an HR-only
  // user who navigated here directly got a rendered dashboard with an empty
  // sidebar and 403-ing data calls. Bounce them to something they can use, the
  // same way HrModuleShell and TaskModuleShell do.
  if (!usable.includes('lms')) {
    const elsewhere = landingFor(
      usable.filter((p) => p !== 'lms'),
      origins,
    );
    if (elsewhere) redirect(elsewhere);
    const auth = authOrigin();
    redirect(auth ? `${auth}/no-access` : '/no-access');
  }

  // NotificationBell is explicitly keyed: an element passed as a prop from a
  // Server Component to a Client Component crosses the RSC wire with key=null
  // and validated=0, so React re-runs list-key validation on the client, cannot
  // tell this is a lone child rather than a list item, and warns about a missing
  // key. The key is inert at runtime — it only satisfies that check.
  return (
    <NotificationProvider>
      <div className="flex min-h-screen w-full flex-col bg-[#F8FAFC] lg:h-full lg:min-h-0 lg:overflow-hidden">
        <AppNavbar
          user={session}
          licensedProducts={licensedProducts}
          productOrigins={origins}
          activeProduct="lms"
          homeHref="/dashboard/leads"
          title="Fitclass - Lead Management System"
          notificationSlot={<NotificationBell key="notification-bell" />}
        />
        <MobileSidebar actor={session} items={DASHBOARD_NAV} />
        <div className="flex w-full flex-1 lg:min-h-0 lg:overflow-hidden">
          <AppSidebar actor={session} items={DASHBOARD_NAV} />
          <main className="flex w-full min-w-0 flex-1 flex-col lg:overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </NotificationProvider>
  );
}
