import { defineConfig } from 'vitest/config';

// All tests run in a plain Node environment. `test/unit/**` covers the pure
// shared-core modules (public/lib/*) and the geocode helpers; `test/worker/**`
// drives the Hono worker (src/index.ts) directly with stubbed env/ctx/caches —
// enough to assert routing/geocoding HTTP behaviour without the Workers runtime.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.{js,ts}', 'test/worker/**/*.test.ts'],
  },
});
