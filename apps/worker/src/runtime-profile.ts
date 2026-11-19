import { z } from 'zod';

const runtimeProfileSchema = z.enum(['free', 'paid']).default('free');

// Explicit deployment choice. Never infer billing permissions at request time.
export function runtimeProfile(value: unknown) {
  return runtimeProfileSchema.parse(value);
}
