// Two guards at the routing layer, in order.
//
// 1. The demo gate (V-014): one shared password over the WHOLE site when
//    DEMO_ACCESS_PASSWORD is set, so a public demo URL cannot be filled with
//    junk reservations. Unset locally and in CI, so it is invisible to the
//    suite.
// 2. The staff boundary (V-010, Countertop's C-037 shape): every host write is
//    a server action rendered on a /host page, and a server action POSTs to
//    the path it was rendered on — so matching the route matches the writes
//    too, and a new action cannot forget to be protected.
//
// ponytail: route-layer, so an action imported into a page OUTSIDE /host
// would bypass guard 2. Nothing does; host.spec.ts asserts the POST is
// refused. The upgrade is a requireStaff() inside that action, not a second
// matcher.
import { NextResponse, type NextRequest } from 'next/server';
import { isStaff, STAFF_COOKIE } from '@/lib/staff-auth';
import { demoChallenge } from '@/lib/demo-gate';

const LOGIN = '/host/login';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // 1. The demo gate, before anything else — including before /host/login, so
  //    the sign-in page itself is not public on a hosted demo.
  const challenge = demoChallenge(
    pathname,
    request.headers.get('authorization'),
    process.env.DEMO_ACCESS_PASSWORD,
  );
  if (challenge) {
    return new NextResponse('Demo access required.', {
      status: challenge.status,
      headers: challenge.headers,
    });
  }

  // 2. The staff boundary. Only /host — everything else is guest-facing and
  //    is past the gate by here.
  if (!pathname.startsWith('/host')) return NextResponse.next();
  if (pathname === LOGIN) return NextResponse.next();
  if (await isStaff(request.cookies.get(STAFF_COOKIE)?.value)) return NextResponse.next();

  // A GET is a person who navigated: send them to sign in. Anything else is a
  // server action, and a redirect would make the browser re-POST it at the
  // login page; 401 is the honest answer.
  if (request.method !== 'GET') return new NextResponse('Not signed in.', { status: 401 });
  const login = new URL(LOGIN, request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

// Guard 1 needs every route; guard 2 narrows to /host itself. Static assets
// and the image optimiser are excluded — they carry no guest data, and
// challenging them makes a gated page render without its stylesheet.
// /api/floor-updates returns a cursor and a boolean, never guest data.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
