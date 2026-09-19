'use server';

// Only async function exports live in a 'use server' file.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { safeNext, sameToken, staffPasscode, staffToken, STAFF_COOKIE, STAFF_COOKIE_MAX_AGE } from '@/lib/staff-auth';

export async function signIn(formData: FormData): Promise<void> {
  const passcode = staffPasscode();
  const next = safeNext(formData.get('next')?.toString());
  // Not a wrong passcode — a deployment with none set. Saying so saves an afternoon.
  if (passcode === '') redirect('/host/login?error=unset');

  // Both sides hashed, so `sameToken` compares two fixed-length digests in constant time.
  const token = await staffToken(passcode);
  if (!sameToken(await staffToken(formData.get('passcode')?.toString() ?? ''), token)) {
    redirect(`/host/login?error=wrong&next=${encodeURIComponent(next)}`);
  }
  (await cookies()).set(STAFF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/host',
    maxAge: STAFF_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  redirect(next);
}
