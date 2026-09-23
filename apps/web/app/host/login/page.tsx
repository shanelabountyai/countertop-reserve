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
    <main className="mx-auto mt-12 max-w-sm border-[3px] border-ink bg-surface p-8 text-lg text-stone-900">
      <p className="text-xs font-bold tracking-[0.18em] text-stone-600 uppercase">Firebird · Reserve</p>
      <h1 className="mt-2 font-display text-4xl font-bold">Host sign-in</h1>
      {!configured ? (
        <p className="mt-6 border-2 border-amber-500 bg-amber-50 p-4 text-amber-900">
          This deployment has no <code>STAFF_PASSCODE</code> set, so the host screens are locked. Set it and restart the server.
        </p>
      ) : (
        <form action={signIn} className="mt-6 flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-extrabold tracking-widest text-stone-600 uppercase">Passcode</span>
            <input type="password" name="passcode" autoComplete="current-password" autoFocus required className="min-h-12 border-2 border-stone-900 bg-white px-3 text-lg" />
          </label>
          <button type="submit" className="min-h-12 bg-ink px-6 text-lg font-extrabold text-white">
            Sign in
          </button>
        </form>
      )}
      {error === 'wrong' ? <p role="alert" className="mt-4 font-bold text-red-700">That passcode is not right.</p> : null}
      {error === 'unset' ? <p role="alert" className="mt-4 font-bold text-red-700">No passcode is configured on this server.</p> : null}
    </main>
  );
}
