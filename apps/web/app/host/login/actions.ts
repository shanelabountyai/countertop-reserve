'use server';

// Only async function exports live in a 'use server' file.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { decideStaffSignIn } from '@/lib/staff-signin';
import { clientIp } from '@/lib/rate';
import { safeNext, STAFF_COOKIE, STAFF_COOKIE_MAX_AGE } from '@/lib/staff-auth';

export async function signIn(formData: FormData): Promise<void> {
  const next = safeNext(formData.get('next')?.toString());
  // Wrong passcodes are counted per client in Postgres (K5 / SEC-01); see staff-signin.ts.
  const decision = await decideStaffSignIn(formData.get('passcode')?.toString() ?? '', await clientIp(), new Date());
  if (!decision.ok) {
    if (decision.reason === 'unset') redirect('/host/login?error=unset');
    redirect(`/host/login?error=${decision.reason}&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(STAFF_COOKIE, decision.token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/host',
    maxAge: STAFF_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  redirect(next);
}
