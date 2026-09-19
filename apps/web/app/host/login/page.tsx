// The host sign-in (V-010, Countertop's C-037 shape). A plain form posting to
// a server action, errors in the URL, so it works before hydration.
import { staffPasscode } from '@/lib/staff-auth';
import { signIn } from './actions';

export const metadata = { title: 'Host sign-in — Firebird Kitchen' };

// Its copy depends on whether a passcode is configured, read per request.
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const configured = staffPasscode() !== '';

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-3xl font-semibold">Host sign-in</h1>
      {!configured ? (
        <p className="mt-6 rounded-lg border border-amber-600 bg-amber-50 p-4 text-amber-950">
          This deployment has no <code>STAFF_PASSCODE</code> set, so the host screens are locked. Set it and restart the server.
        </p>
      ) : (
        <form action={signIn} className="mt-6 flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <label className="flex flex-col gap-1">
            <span className="font-medium">Passcode</span>
            <input type="password" name="passcode" autoComplete="current-password" autoFocus required className="min-h-12 rounded-lg border border-neutral-500 px-3 text-lg" />
          </label>
          <button type="submit" className="min-h-12 rounded-lg bg-neutral-900 px-6 text-lg font-semibold text-white">
            Sign in
          </button>
        </form>
      )}
      {error === 'wrong' ? <p role="alert" className="mt-4 text-red-800">That passcode is not right.</p> : null}
      {error === 'unset' ? <p role="alert" className="mt-4 text-red-800">No passcode is configured on this server.</p> : null}
    </main>
  );
}
