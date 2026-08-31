import { describe, expect, it } from 'vitest';

// V-001 has no domain logic to test. This file exists so the two CI passes
// (TZ=UTC and TZ=Pacific/Kiritimati) run a real suite rather than reporting
// green on zero tests — a gate that passes vacuously is the one that gets
// trusted right up until it matters.
describe('scaffold', () => {
  it('runs the unit suite under whatever TZ the process was given', () => {
    expect(typeof Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('string');
  });
});
