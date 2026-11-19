import { z } from 'zod';
import { releaseLease } from './lock';

const rowSchema = z.object({
  due_ids_json: z.string(),
  failures_value: z.string().nullable(),
  successes_value: z.string().nullable(),
  has_notifications: z.number().int().min(0).max(1),
});
const idsSchema = z.array(z.number().int().positive());
const thresholdSchema = z.number().int().min(1).max(10).catch(2);
export type ScheduledTickContext = {
  dueIds: Array<{ id: number }>;
  hasNotifications: boolean;
  settings: {
    state_failures_to_down_from_up: number;
    state_successes_to_up_from_down: number;
  };
};

// The lease and the small inputs needed for dispatch come from one D1 round
// trip. RETURNING runs only after a successful claim, so a competing tick
// cannot reuse context without owning the lease. No full monitor config or
// heartbeat JSON crosses the Cron boundary.
export async function claimScheduledTickContext(
  db: D1Database,
  name: string,
  now: number,
  checkedAt: number,
  leaseSeconds: number,
  profile: 'free' | 'paid' = 'free',
): Promise<ScheduledTickContext | null> {
  const expiresAt = now + leaseSeconds;
  const row = await db
    .prepare(
      `
    INSERT INTO locks(name,expires_at)
    SELECT ?1,?2 WHERE EXISTS (
      SELECT 1 FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id=m.id
      WHERE m.is_active=1 AND (s.status IS NULL OR s.status!='paused')
    )
    AND (?5!='paid' OR NOT EXISTS (
      SELECT 1 FROM locks WHERE name='scheduler:tick' AND expires_at>?3
    ))
    AND (?5!='free' OR NOT EXISTS (
      SELECT 1 FROM locks
      WHERE name>='scheduler:paid-lane:' AND name<'scheduler:paid-lane;'
        AND expires_at>?3
    ))
    ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at
    WHERE locks.expires_at<=?3
    RETURNING (
      SELECT json_group_array(id) FROM (
        SELECT m.id FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id=m.id
        WHERE m.is_active=1 AND (s.status IS NULL OR s.status!='paused')
          AND (s.last_checked_at IS NULL OR s.last_checked_at<=?4-m.interval_sec)
        ORDER BY m.id
      )
    ) AS due_ids_json,
    (SELECT value FROM settings WHERE key='state_failures_to_down_from_up') AS failures_value,
    (SELECT value FROM settings WHERE key='state_successes_to_up_from_down') AS successes_value,
    EXISTS(SELECT 1 FROM notification_channels WHERE is_active=1 AND type='webhook') AS has_notifications
  `,
    )
    .bind(name, expiresAt, now, checkedAt, profile)
    .first<unknown>();
  if (!row) return null;
  try {
    const data = rowSchema.parse(row);
    return {
      dueIds: idsSchema.parse(JSON.parse(data.due_ids_json)).map((id) => ({ id })),
      hasNotifications: data.has_notifications === 1,
      settings: {
        state_failures_to_down_from_up: thresholdSchema.parse(
          Number.parseInt(data.failures_value ?? '', 10),
        ),
        state_successes_to_up_from_down: thresholdSchema.parse(
          Number.parseInt(data.successes_value ?? '', 10),
        ),
      },
    };
  } catch (error) {
    await releaseLease(db, name, expiresAt, true);
    throw error;
  }
}
