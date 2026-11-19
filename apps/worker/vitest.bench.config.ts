import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': new URL('./test/helpers/cloudflare-sockets.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ['test/**/*.bench.ts'],
    environment: 'node',
  },
});
