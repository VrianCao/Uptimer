import { describe, expect, it } from 'vitest';
import { claimScheduledTickContext } from '../src/scheduler/tick-context';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('atomic scheduler lease and dispatch context', () => {
  it('returns only due runnable IDs and fresh validated settings to the lease owner', async () => {
    const f = createSqliteD1();
    const now = 1_800_000_120;
    try {
      for (let id = 1; id <= 4; id++) {
        f.sqlite
          .prepare(
            "INSERT INTO monitors(id,name,type,target,interval_sec,is_active) VALUES (?,?,'http','https://example.com',60,?)",
          )
          .run(id, `API ${id}`, id === 4 ? 0 : 1);
      }
      f.sqlite
        .prepare(
          "INSERT INTO monitor_state(monitor_id,status,last_checked_at) VALUES (2,'up',?),(3,'paused',?)",
        )
        .run(now - 30, now - 60);
      f.sqlite.exec(
        "INSERT INTO settings(key,value) VALUES ('state_failures_to_down_from_up','4') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      const first = await claimScheduledTickContext(f.db, 'scheduler:tick', now, now, 135);
      expect(first).toEqual({
        dueIds: [{ id: 1 }],
        hasNotifications: false,
        settings: { state_failures_to_down_from_up: 4, state_successes_to_up_from_down: 2 },
      });
      expect(f.calls).toHaveLength(1);
      expect(f.writes.reduce((n, w) => n + w.changes, 0)).toBe(1);
      expect(await claimScheduledTickContext(f.db, 'scheduler:tick', now, now, 135)).toBeNull();
      f.sqlite.exec("UPDATE settings SET value='10' WHERE key='state_failures_to_down_from_up'");
      const next = await claimScheduledTickContext(
        f.db,
        'scheduler:tick',
        now + 135,
        now + 120,
        135,
      );
      expect(next?.dueIds).toEqual([{ id: 1 }, { id: 2 }]);
      expect(next?.settings.state_failures_to_down_from_up).toBe(10);
    } finally {
      f.sqlite.close();
    }
  });
  it('keeps empty and paused-only installations free of scheduler lock writes', async () => {
    const f = createSqliteD1();
    try {
      expect(await claimScheduledTickContext(f.db, 'scheduler:tick', 120, 120, 135)).toBeNull();
      f.sqlite.exec(
        "INSERT INTO monitors(id,name,type,target) VALUES (1,'API','http','https://example.com'); INSERT INTO monitor_state(monitor_id,status) VALUES (1,'paused')",
      );
      expect(await claimScheduledTickContext(f.db, 'scheduler:tick', 120, 120, 135)).toBeNull();
      expect(f.writes).toHaveLength(0);
    } finally {
      f.sqlite.close();
    }
  });
  it('preserves default thresholds for invalid stored settings and detects active channels', async () => {
    const f = createSqliteD1();
    try {
      f.sqlite.exec(
        "INSERT INTO monitors(id,name,type,target) VALUES (1,'API','http','https://example.com'); INSERT INTO notification_channels(name,type,config_json) VALUES ('test','webhook','{}'); UPDATE settings SET value='999' WHERE key='state_failures_to_down_from_up'",
      );
      const result = await claimScheduledTickContext(f.db, 'scheduler:tick', 120, 120, 135);
      expect(result?.hasNotifications).toBe(true);
      expect(result?.settings.state_failures_to_down_from_up).toBe(2);
    } finally {
      f.sqlite.close();
    }
  });
  it('releases the claimed lease if dispatch data fails runtime validation', async () => {
    const f = createSqliteD1();
    try {
      f.sqlite.exec(
        "INSERT INTO monitors(id,name,type,target) VALUES (0,'Invalid','http','https://example.com')",
      );
      await expect(
        claimScheduledTickContext(f.db, 'scheduler:tick', 120, 120, 135),
      ).rejects.toThrow();
      expect(
        f.sqlite.prepare("SELECT expires_at FROM locks WHERE name='scheduler:tick'").get(),
      ).toEqual({ expires_at: 0 });
    } finally {
      f.sqlite.close();
    }
  });
});
