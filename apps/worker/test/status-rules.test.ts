import { describe, expect, it } from 'vitest';

import {
  evaluateHttpStatusCode,
  expectedStatusJsonSchema,
  forbiddenStatusJsonSchema,
  isHttpStatusAccepted,
  matchesStatusCodeRules,
} from '@uptimer/db';

describe('status code rules schema', () => {
  it('accepts legacy exact code arrays', () => {
    expect(expectedStatusJsonSchema.parse([200, 204])).toEqual([200, 204]);
    expect(forbiddenStatusJsonSchema.parse([500])).toEqual([500]);
  });

  it('accepts ranges and mixed rules', () => {
    expect(
      expectedStatusJsonSchema.parse([200, { from: 301, to: 399 }, { from: 200, to: 200 }]),
    ).toEqual([200, { from: 301, to: 399 }, { from: 200, to: 200 }]);
  });

  it('rejects inverted ranges and out-of-bounds codes', () => {
    expect(expectedStatusJsonSchema.safeParse([{ from: 399, to: 301 }]).success).toBe(false);
    expect(expectedStatusJsonSchema.safeParse([99]).success).toBe(false);
    expect(expectedStatusJsonSchema.safeParse([600]).success).toBe(false);
    expect(expectedStatusJsonSchema.safeParse([]).success).toBe(false);
  });
});

describe('status code matching', () => {
  it('matches exact codes and inclusive ranges', () => {
    expect(matchesStatusCodeRules(204, [200, 204])).toBe(true);
    expect(matchesStatusCodeRules(201, [{ from: 200, to: 299 }])).toBe(true);
    expect(matchesStatusCodeRules(300, [{ from: 200, to: 299 }])).toBe(false);
    expect(matchesStatusCodeRules(200, null)).toBe(false);
  });

  it('applies blacklist-first then allowlist then default 2xx', () => {
    expect(
      isHttpStatusAccepted(204, { expected: [{ from: 200, to: 299 }], forbidden: [204] }),
    ).toBe(false);
    expect(
      isHttpStatusAccepted(200, { expected: [{ from: 200, to: 299 }], forbidden: [204] }),
    ).toBe(true);
    expect(isHttpStatusAccepted(200, { forbidden: [500] })).toBe(true);
    expect(isHttpStatusAccepted(500, { forbidden: [500] })).toBe(false);
    expect(isHttpStatusAccepted(404, { forbidden: [500] })).toBe(false);
    expect(isHttpStatusAccepted(302, { expected: [302] })).toBe(true);
    expect(isHttpStatusAccepted(200, {})).toBe(true);
    expect(isHttpStatusAccepted(404, {})).toBe(false);
  });

  it('reports forbidden vs unexpected reasons', () => {
    expect(
      evaluateHttpStatusCode(204, { expected: [{ from: 200, to: 299 }], forbidden: [204] }),
    ).toEqual({ ok: false, reason: 'forbidden' });
    expect(evaluateHttpStatusCode(301, { expected: [{ from: 200, to: 299 }] })).toEqual({
      ok: false,
      reason: 'unexpected',
    });
    expect(evaluateHttpStatusCode(200, {})).toEqual({ ok: true });
  });
});
