import { describe, expect, it, vi } from 'vitest';
import { resolvePagesApi } from '../scripts/resolve-pages-api.mjs';
import { configurePagesProxy } from '../scripts/configure-pages-proxy.mjs';

describe('Pages deployment routing', () => {
  it('keeps default browser API requests on the Pages origin', () => {
    expect(resolvePagesApi({ workerUrl: 'https://site.example.workers.dev/' })).toEqual({
      apiBase: '/api/v1',
      apiOrigin: 'https://site.example.workers.dev',
    });
  });
  it('preserves explicit API bases and origins', () => {
    expect(
      resolvePagesApi({
        apiBase: 'https://custom.example/app/api/v1/',
        workerUrl: 'https://worker.example/',
      }),
    ).toEqual({
      apiBase: 'https://custom.example/app/api/v1',
      apiOrigin: 'https://custom.example',
    });
    expect(resolvePagesApi({ apiOrigin: 'https://custom.example/api/v1/' })).toEqual({
      apiBase: 'https://custom.example/api/v1',
      apiOrigin: 'https://custom.example',
    });
    expect(resolvePagesApi({ apiBase: '/api/v1', apiOrigin: 'https://custom.example' })).toEqual({
      apiBase: '/api/v1',
      apiOrigin: 'https://custom.example',
    });
  });
  it('rejects untrusted URL forms and environment-file injection before mutation', () => {
    for (const apiBase of [
      '//other.example/api/v1',
      'https://user:pass@other.example/api/v1',
      'https://other.example/api/v1?x=1',
      '/api/v1\nMALICIOUS=1',
    ])
      expect(() => resolvePagesApi({ apiBase, workerUrl: 'https://worker.example' })).toThrow();
    expect(() => resolvePagesApi({ workerUrl: 'http://public.example' })).toThrow();
    expect(() => resolvePagesApi({})).toThrow();
  });
  const input = {
    accountId: '0'.repeat(32),
    projectName: 'test-site',
    apiOrigin: 'https://worker.example',
    apiBase: '/api/v1',
  };
  it.each([{}, null, undefined])(
    'initializes a missing authentication pin (existing variables %o)',
    async (env_vars) => {
      const putSecret = vi.fn();
      const readProject = vi.fn(async () => ({
        name: 'test-site',
        deployment_configs: { production: { env_vars } },
      }));
      await configurePagesProxy(input, { readProject, putSecret });
      expect(putSecret.mock.calls.map((call) => call.slice(1))).toEqual([
        ['UPTIMER_API_ORIGIN', 'https://worker.example'],
        ['UPTIMER_API_SENSITIVE_ORIGIN', 'https://worker.example'],
      ]);
    },
  );
  it('preserves existing custom authentication pins', async () => {
    const putSecret = vi.fn();
    const readProject = vi.fn(async () => ({
      name: 'test-site',
      deployment_configs: {
        production: {
          env_vars: {
            UPTIMER_API_SENSITIVE_ORIGIN: { type: 'plain_text', value: 'https://private.example' },
          },
        },
      },
    }));
    const result = await configurePagesProxy(input, { readProject, putSecret });
    expect(result.preservedSensitiveOrigin).toBe(true);
    expect(putSecret).toHaveBeenCalledTimes(1);
    expect(putSecret.mock.calls[0]?.[1]).toBe('UPTIMER_API_ORIGIN');
  });
  it('does not mutate another Pages project or an invalid upstream', async () => {
    const putSecret = vi.fn();
    const readProject = vi.fn(async () => ({
      name: 'other-site',
      deployment_configs: { production: {} },
    }));
    await expect(configurePagesProxy(input, { readProject, putSecret })).rejects.toThrow();
    expect(putSecret).not.toHaveBeenCalled();
    await expect(
      configurePagesProxy(
        { ...input, apiOrigin: 'https://worker.example/path' },
        { readProject, putSecret },
      ),
    ).rejects.toThrow();
    expect(putSecret).not.toHaveBeenCalled();
  });
});
