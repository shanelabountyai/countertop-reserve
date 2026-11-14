// Runs once when a server instance boots (Next's instrumentation hook).
// Scorecard K11: a malformed environment stops the server here, naming the
// bad keys, instead of failing on the first request that reads one.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return; // the edge middleware has its own, smaller world
  const { parseEnv } = await import('./lib/env');
  parseEnv(process.env);
}
