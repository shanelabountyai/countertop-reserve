// The changes-since endpoint (P0-9), Countertop's shape. The client echoes
// the cursor it was last given and learns whether anything happened since —
// no clock reading from the client, and no guest data here (so it sits
// outside the /host passcode gate). `changed: true` means router.refresh():
// one renderer for a row, the server component.
import { floorCursor } from '@reserve/db/floor';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const cursor = await floorCursor();
  const echoed = new URL(request.url).searchParams.get('cursor');
  // No cursor sent: nothing rendered that could be stale, so no spurious refresh.
  return Response.json({ cursor, changed: echoed !== null && echoed !== cursor }, { headers: { 'Cache-Control': 'no-store' } });
}
