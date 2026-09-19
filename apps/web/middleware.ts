// The staff boundary (V-010, Countertop's C-037 shape).
//
// ONE guard, at the routing layer. Every host write is a server action
// rendered on a /host page, and a server action POSTs to the path it was
// rendered on — so matching the route matches the writes too, and a new
// action cannot forget to be protected.
//
// ponytail: route-layer, so an action imported into a page OUTSIDE /host
// would bypass it. Nothing does; host.spec.ts asserts the POST is refused.
// The upgrade is a requireStaff() inside that action, not a second matcher.
import { NextResponse, type NextRequest } from 'next/server';
import { isStaff, STAFF_COOKIE } from '@/lib/staff-auth';

const LOGIN = '/host/login';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
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

// `:path*` also matches /host itself. /api/floor-updates returns a cursor and
// a boolean, never guest data, so it stays outside.
export const config = { matcher: '/host/:path*' };
