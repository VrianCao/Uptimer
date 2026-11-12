import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime } from '../../web/src/utils/datetime';

describe('reused date/time formatters', () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'es']) {
    for (const timeZone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
      it(`preserves ${locale} output in ${timeZone}`, () => {
        for (const timestamp of [1_800_000_000, 1_780_000_000]) {
          const date = new Date(timestamp * 1000);
          expect(formatDate(timestamp, timeZone, locale)).toBe(
            date.toLocaleDateString(locale, { timeZone }),
          );
          expect(formatDateTime(timestamp, timeZone, locale)).toBe(
            date.toLocaleString(locale, { timeZone }),
          );
          for (const hour12 of [undefined, true, false]) {
            expect(
              formatTime(timestamp, {
                timeZone,
                locale,
                ...(hour12 === undefined ? {} : { hour12 }),
              }),
            ).toBe(
              date.toLocaleTimeString(locale, {
                timeZone,
                hour: '2-digit',
                minute: '2-digit',
                hour12,
              }),
            );
          }
        }
      });
    }
  }
  it('preserves invalid dates and invalid timezone fallback', () => {
    expect(formatDate(Number.NaN)).toBe('');
    expect(formatDateTime(Infinity)).toBe('');
    const date = new Date(1_800_000_000_000);
    expect(formatDateTime(1_800_000_000, 'invalid', 'en')).toBe(date.toLocaleString('en'));
  });
});
