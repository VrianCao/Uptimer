import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': new URL('./test/helpers/cloudflare-sockets.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        'src/analytics/latency.ts',
        'src/analytics/uptime.ts',
        'src/middleware/auth.ts',
        'src/middleware/cache-public.ts',
        'src/middleware/errors.ts',
        'src/middleware/rate-limit.ts',
        'src/monitor/http.ts',
        'src/monitor/state-machine.ts',
        'src/monitor/tcp.ts',
        'src/monitor/targets.ts',
        'src/notify/dedupe.ts',
        'src/notify/template.ts',
        'src/scheduler/lock.ts',
        'src/scheduler/retention.ts',
        'src/settings.ts',
        'src/snapshots/public-status.ts',
        'src/snapshots/refresh.ts',
      ],
      thresholds: {
        lines: 92,
        functions: 92,
        statements: 92,
        // Branch threshold is slightly lower because defensive runtime-fallback branches are hard to hit deterministically.
        branches: 86,
      },
    },
  },
});
