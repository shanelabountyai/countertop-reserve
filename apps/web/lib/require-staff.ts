// The staff check INSIDE each host page and server action (scorecard K3,
// SEC-07). The middleware already refuses /host without the cookie; this is
// the second layer, so an action reached by any other route — a page outside
// /host importing it, or Next routing a server-action id to another path —
// still refuses. Server-only: it reads cookies(), which only a request has.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isStaff, STAFF_COOKIE } from './staff-auth';

/** Returns only for staff. Anyone else is sent to sign in, and nothing after the call runs. */
export async function requireStaff(): Promise<void> {
  if (!(await isStaff((await cookies()).get(STAFF_COOKIE)?.value))) redirect('/host/login');
}
