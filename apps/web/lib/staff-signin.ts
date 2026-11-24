// The staff sign-in decision (V-010 + scorecard K5 / SEC-01), kept out of the
// 'use server' file so it can be tested without a request.
//
// Wrong passcodes are counted per hashed client address in Postgres. Past the
// limit, every attempt from that address is refused for the rest of the
// window — the right passcode included, or the lockout would only tell a
// guesser which guess was right. Right passcodes are never counted, so the
// host-stand tablet signing in each morning is never throttled.
import { clientKey, hit, LIMITS, spent } from '@reserve/db/rate-limit';
import { sameToken, staffPasscode, staffToken } from './staff-auth';

export type SignInDecision = { ok: true; token: string } | { ok: false; reason: 'unset' | 'throttled' | 'wrong' };

export async function decideStaffSignIn(typed: string, ip: string, now: Date): Promise<SignInDecision> {
  const passcode = staffPasscode();
  // Not a wrong passcode — a deployment with none set. Saying so saves an afternoon.
  if (passcode === '') return { ok: false, reason: 'unset' };

  const key = clientKey('staff-signin', ip);
  if (await spent(key, LIMITS.staffSignInPerIp, now)) return { ok: false, reason: 'throttled' };

  // Both sides hashed, so `sameToken` compares two fixed-length digests in constant time.
  const token = await staffToken(passcode);
  if (sameToken(await staffToken(typed), token)) return { ok: true, token };
  await hit(key, LIMITS.staffSignInPerIp, now);
  return { ok: false, reason: 'wrong' };
}
