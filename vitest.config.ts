import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Daemon tests wait on in-memory sockets with `until(..., 15 s)`; the default 5 s test timeout fired first when the
    // machine was busy (one unreproduced 59/60 run during parallel backend tests). Real hangs still fail at 30 s.
    testTimeout: 30_000,
  },
})
