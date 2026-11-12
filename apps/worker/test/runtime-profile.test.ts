import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { configureRuntimeProfile } from '../scripts/configure-runtime-profile.mjs';
import { getSiteCoordinator } from '../src/coordinator-binding';
import paidCrons from '../src/scheduler/paid-crons.json';

const canonical = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
describe('explicit runtime profiles', () => {
  it('keeps the Free coordinator and native CPU defaults', () => {
    const config = configureRuntimeProfile(canonical + '\n[limits]\ncpu_ms = 10\n', 'free');
    expect(config).toContain('UPTIMER_RUNTIME_PROFILE = "free"');
    expect(config).toContain('name = "COORDINATOR"');
    expect(config).not.toMatch(/^cpu_ms\s*=/m);
    for (const cron of paidCrons) expect(config).not.toContain(JSON.stringify(cron));
  });
  it('removes the Paid binding, retains migration compatibility and caps CPU at 30s', () => {
    const config = configureRuntimeProfile(canonical, 'paid');
    expect(config).toContain('UPTIMER_RUNTIME_PROFILE = "paid"');
    expect(config).not.toContain('[[durable_objects.bindings]]');
    expect(config).toContain('new_sqlite_classes = ["SiteCoordinator"]');
    expect(config).toContain('cpu_ms = 30000');
    expect(config).toContain('UPTIMER_INTERNAL_SCHEDULED_BATCH_CONCURRENCY = "1"');
    expect(configureRuntimeProfile(config, 'paid')).toBe(config);
    expect(config).toContain('UPTIMER_INTERNAL_SCHEDULED_BATCH_SIZE = "5"');
    for (const cron of paidCrons) expect(config).toContain(JSON.stringify(cron));
    expect(config.match(/^crons\s*=.*$/m)?.[0].match(/"/g)).toHaveLength(12);
  });
  it('preserves unrelated limits and refuses ambiguous profiles or missing sections', () => {
    const source = canonical + '\n[limits]\ncpu_ms = 10\nsubrequests = 1000\n';
    const output = configureRuntimeProfile(source, 'paid');
    expect(output).toContain('subrequests = 1000');
    expect(output.match(/^cpu_ms\s*=/gm)).toHaveLength(1);
    expect(() => configureRuntimeProfile(canonical, 'paidd')).toThrow();
    expect(() => configureRuntimeProfile('', 'paid')).toThrow();
    expect(() =>
      configureRuntimeProfile(canonical.replace('[triggers]', '[other]'), 'paid'),
    ).toThrow();
    expect(() => configureRuntimeProfile(output, 'free')).toThrow();
  });
  it('never touches a coordinator namespace in Paid mode, even if one is still bound', () => {
    const getByName = vi.fn(() => {
      throw new Error('Unexpected DO call');
    });
    expect(
      getSiteCoordinator({ UPTIMER_RUNTIME_PROFILE: 'paid', COORDINATOR: { getByName } as never }),
    ).toBeUndefined();
    expect(getByName).not.toHaveBeenCalled();
    expect(() => getSiteCoordinator({ UPTIMER_RUNTIME_PROFILE: 'paidd' })).toThrow();
  });
  it('uses the same named Free object and keeps unbound local development working', () => {
    const stub = {};
    const getByName = vi.fn(() => stub);
    expect(getSiteCoordinator({ COORDINATOR: { getByName } as never })).toBe(stub);
    expect(getByName).toHaveBeenCalledWith('site');
    expect(getSiteCoordinator({})).toBeUndefined();
  });
});
