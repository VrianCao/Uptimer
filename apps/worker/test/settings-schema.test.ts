import { describe, expect, it } from 'vitest';

import { parseSettingsPatch } from '../src/settings';

describe('settings patch schema', () => {
  it.each(['UTC', 'Asia/Shanghai', 'America/New_York', 'Europe/Paris'])(
    'accepts the supported time zone %s',
    (zone) => {
      expect(parseSettingsPatch({ site_timezone: ` ${zone} ` })).toEqual({ site_timezone: zone });
    },
  );
  it.each(['Invalid/Timezone', '', '  ', '<script>', '25:00'])(
    'rejects an invalid time zone %s before writing settings',
    (zone) => {
      expect(() => parseSettingsPatch({ site_timezone: zone })).toThrow();
    },
  );
  it('accepts site_locale updates', () => {
    expect(parseSettingsPatch({ site_locale: 'auto' })).toEqual({ site_locale: 'auto' });
    expect(parseSettingsPatch({ site_locale: 'ja' })).toEqual({ site_locale: 'ja' });
  });

  it('rejects unknown keys', () => {
    expect(() => parseSettingsPatch({ site_locale_x: 'en' })).toThrow(/unrecognized key/i);
  });

  it('rejects empty patches', () => {
    expect(() => parseSettingsPatch({})).toThrow(/At least one field must be provided/);
  });
});
