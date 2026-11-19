import { describe, expect, it } from 'vitest';
import { claimScheduledTickContext } from '../src/scheduler/tick-context';
import { releaseLease } from '../src/scheduler/lock';
import { createSqliteD1 } from './helpers/sqlite-d1';

describe('runtime profile scheduler handoff', () => {
  it.each(['free', 'paid'] as const)(
    'waits for an in-flight %s round before the other profile probes',
    async (first) => {
      const f = createSqliteD1();
      const now = 1793784600;
      f.sqlite.exec(
        "INSERT INTO monitors(id,name,type,target,created_at,updated_at)VALUES(1,'Test','http','https://example.com',1,1)",
      );
      const firstName = first === 'free' ? 'scheduler:tick' : 'scheduler:paid-lane:0';
      const second = first === 'free' ? 'paid' : 'free';
      const secondName = second === 'free' ? 'scheduler:tick' : 'scheduler:paid-lane:1';
      try {
        expect(
          await claimScheduledTickContext(f.db, firstName, now, now, 135, first),
        ).not.toBeNull();
        expect(await claimScheduledTickContext(f.db, secondName, now, now, 135, second)).toBeNull();
        await releaseLease(f.db, firstName, now + 135, true);
        expect(
          await claimScheduledTickContext(f.db, secondName, now, now, 135, second),
        ).not.toBeNull();
      } finally {
        f.sqlite.close();
      }
    },
  );
  it('allows independent Paid lanes together while rejecting a duplicate lane', async () => {
    const f = createSqliteD1();
    const now = 1793784600;
    f.sqlite.exec(
      "INSERT INTO monitors(id,name,type,target,created_at,updated_at)VALUES(1,'Test','http','https://example.com',1,1)",
    );
    const claim = (name: string) => claimScheduledTickContext(f.db, name, now, now, 135, 'paid');
    try {
      expect(await claim('scheduler:paid-lane:0')).not.toBeNull();
      expect(await claim('scheduler:paid-lane:1')).not.toBeNull();
      expect(await claim('scheduler:paid-lane:1')).toBeNull();
    } finally {
      f.sqlite.close();
    }
  });
});
