import { describe, expect, it } from 'vitest';

import { acquireLease, releaseLease } from '../src/scheduler/lock';
import { createFakeD1Database, type FakeD1QueryHandler } from './helpers/fake-d1';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('scheduler/lock', () => {
  it('reuses a stable lock row without releasing a newer owner', async () => {
    const { db, sqlite } = createSqliteD1();
    expect(await acquireLease(db, 'scheduler:tick', 100, 135)).toBe(true);
    await releaseLease(db, 'scheduler:tick', 235, true);
    expect(await acquireLease(db, 'scheduler:tick', 101, 135)).toBe(true);
    await releaseLease(db, 'scheduler:tick', 235, true);
    expect(
      sqlite.prepare("SELECT expires_at FROM locks WHERE name='scheduler:tick'").get()?.expires_at,
    ).toBe(236);
    expect(await acquireLease(db, 'scheduler:tick', 102, 135)).toBe(false);
    await releaseLease(db, 'scheduler:tick', 236, true);
    expect(
      sqlite.prepare("SELECT expires_at FROM locks WHERE name='scheduler:tick'").get()?.expires_at,
    ).toBe(0);
    expect(await acquireLease(db, 'scheduler:tick', 103, 135)).toBe(true);
    sqlite.close();
  });
  it('returns true when the lease row is inserted or updated', async () => {
    let boundArgs: unknown[] | null = null;
    const handlers: FakeD1QueryHandler[] = [
      {
        match: 'insert into locks',
        run: (args) => {
          boundArgs = args;
          return { meta: { changes: 1 } };
        },
      },
    ];

    const db = createFakeD1Database(handlers);
    const ok = await acquireLease(db, 'scheduler:tick', 100, 55);

    expect(ok).toBe(true);
    expect(boundArgs).toEqual(['scheduler:tick', 155, 100]);
  });

  it('returns false when a lease cannot be claimed', async () => {
    const db = createFakeD1Database([
      {
        match: 'insert into locks',
        run: () => ({ meta: { changes: 0 } }),
      },
    ]);

    await expect(acquireLease(db, 'retention', 200, 600)).resolves.toBe(false);
  });

  it('treats missing changes metadata as a failed lease claim', async () => {
    const db = createFakeD1Database([
      {
        match: 'insert into locks',
        run: () => ({ success: true }),
      },
    ]);

    await expect(acquireLease(db, 'retention', 200, 600)).resolves.toBe(false);
  });

  it('releases only the lease row matching the claimed expiry', async () => {
    let boundArgs: unknown[] | null = null;
    const db = createFakeD1Database([
      {
        match: 'delete from locks',
        run: (args) => {
          boundArgs = args;
          return { meta: { changes: 1 } };
        },
      },
    ]);

    await expect(releaseLease(db, 'scheduler:tick', 155)).resolves.toBeUndefined();
    expect(boundArgs).toEqual(['scheduler:tick', 155]);
  });
});
