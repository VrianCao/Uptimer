import { z } from 'zod';

export function publicOutageWindow(now: number, createdAt: number, rawDay?: string) {
  const today = Math.floor(now / 86400) * 86400;
  const dayStartAt = z.coerce
    .number()
    .int()
    .min(today - 89 * 86400)
    .max(today)
    .refine((value) => value % 86400 === 0, 'day_start_at must be a UTC day boundary')
    .optional()
    .parse(rawDay);
  const rangeEnd =
    dayStartAt === undefined ? Math.floor(now / 60) * 60 : Math.min(now, dayStartAt + 86400);
  const rangeStart = Math.min(rangeEnd, Math.max(dayStartAt ?? rangeEnd - 30 * 86400, createdAt));
  return { rangeStart, rangeEnd };
}
