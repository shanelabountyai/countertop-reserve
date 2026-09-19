// Staff authentication for /host (V-010), ported from Countertop's C-037.
//
// One shared passcode, no accounts. The floor view shows guests' names and
// can cancel their tables, so it must be unreachable from the internet; a
// tablet at the host stand does not want a per-host login.
//
// The cookie carries no authority of its own — it is a digest of the
// passcode. Rotating STAFF_PASSCODE invalidates every session ever issued:
// no session table, no expiry sweep, no second secret.
//
// `crypto.subtle` rather than `node:crypto`: this module is imported by the
// edge middleware as well as a Node server action, and only Web Crypto is in
// both. Keep anything that needs the database out of it.

export const STAFF_COOKIE = 'cr_host';

/** A service, not a session. A tablet rebooted overnight should come back signed
 *  in; the revocation mechanism is rotating the passcode, not waiting. */
export const STAFF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Unset means LOCKED, never open.
 *
 * A deploy that forgets the variable loses its floor screen and says so on the
 * login page. The alternative — a development default — is the version that
 * ships a passcode everyone already knows to production, which is the failure
 * this item exists to remove.
 */
export const staffPasscode = (): string => process.env.STAFF_PASSCODE ?? '';

/** The cookie's value, and the comparand for a typed passcode. Salted, so the
 *  stored token is not a bare SHA-256 of a six-character word. */
export async function staffToken(passcode: string): Promise<string> {
  const bytes = new TextEncoder().encode(`reserve-host:${passcode}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time. Both arguments are digests of the same fixed length, so an
 *  early return on the first differing character leaks how much of a guess was
 *  right — which is exactly the oracle an offline attacker wants. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The one question the middleware asks. */
export async function isStaff(cookieValue: string | undefined): Promise<boolean> {
  const passcode = staffPasscode();
  if (passcode === '' || cookieValue === undefined) return false;
  return sameToken(cookieValue, await staffToken(passcode));
}

/**
 * Where a login may send someone afterwards.
 *
 * The `next` parameter is a redirect target supplied by whoever crafted the
 * link, which makes it a trust boundary: anything that is not a path under
 * /host falls back to the floor rather than becoming an open redirect.
 */
export function safeNext(next: string | undefined): string {
  return next !== undefined && /^\/host(\/|$|\?)/.test(next) ? next : '/host';
}
