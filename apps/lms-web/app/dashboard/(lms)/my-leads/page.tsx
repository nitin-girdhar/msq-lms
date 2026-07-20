import { redirect } from 'next/navigation';

export default function MyLeadsRedirect() {
  redirect('/dashboard/leads-history');
}
