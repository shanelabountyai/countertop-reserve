// The response headers next.config.ts declares (scorecard K7 / SEC-05; K6 for
// the manage link). Asserted from the config itself; e2e covers the built app.
import { describe, expect, it } from 'vitest';
import config from './next.config';

type Rule = { source: string; headers: { key: string; value: string }[] };

/** What a path ends up with: Next applies every matching rule in order, later keys winning. */
async function headersFor(path: string): Promise<Record<string, string>> {
  const rules = ((await config.headers?.()) ?? []) as Rule[];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const prefix = rule.source.replace('/:path*', '');
    if (path === prefix || path.startsWith(`${prefix}/`) || prefix === '') {
      for (const h of rule.headers) out[h.key] = h.value;
    }
  }
  return out;
}

describe('security headers', () => {
  it.each(['/', '/book', '/host', '/host/login', '/api/sms/inbound'])('%s carries the global set', async (path) => {
    const h = await headersFor(path);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('does not advertise the framework', () => {
    expect(config.poweredByHeader).toBe(false);
  });
});
