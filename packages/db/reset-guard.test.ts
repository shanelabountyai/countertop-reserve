// The guard that stops a seed wiping a database it was never meant to touch.
// Pure — no database, no clock.
import { describe, expect, it } from 'vitest';
import { resetPermitted } from './testing/index';

const NEON = 'ep-demo-12345.us-west-2.aws.neon.tech';

describe('resetPermitted', () => {
  it('permits every local host with no opt-in', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(resetPermitted(host, undefined)).toBe(true);
    }
  });

  it('refuses a remote host with no opt-in', () => {
    expect(resetPermitted(NEON, undefined)).toBe(false);
  });

  it('refuses an unparseable host', () => {
    expect(resetPermitted('<unparseable>', undefined)).toBe(false);
  });

  it('permits a remote host the opt-in names exactly', () => {
    expect(resetPermitted(NEON, NEON)).toBe(true);
  });

  // The whole point of "exactly". Each of these is a way the gate could open
  // by accident if the check were sloppier than an equality test.
  it.each([
    ['a different host', 'ep-other-99999.us-west-2.aws.neon.tech'],
    ['a wildcard', '*'],
    ['an empty string', ''],
    ['a prefix of the host', 'ep-demo-12345'],
    ['a suffix of the host', 'neon.tech'],
    ['the host with whitespace', ` ${NEON} `],
    ['a truthy but unrelated value', 'true'],
    ['a different case', NEON.toUpperCase()],
  ])('refuses a remote host when the opt-in is %s', (_label, allowHost) => {
    expect(resetPermitted(NEON, allowHost)).toBe(false);
  });

  it('does not let the opt-in matter for a local host either way', () => {
    expect(resetPermitted('localhost', NEON)).toBe(true);
  });
});
