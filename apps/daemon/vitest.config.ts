import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // A ceiling for a loaded machine, not a target: these tests take ~2s each
    // when the box is idle, but `quality:check` runs every workspace package's
    // suite at once and they slow down several-fold under that contention.
    // 15s sat close enough to the worst case to fail intermittently.
    testTimeout: 60000,
    // Each server test boots a real Fastify instance. Run the files one at a
    // time so they are not also competing with each other for CPU.
    fileParallelism: false,
  },
})
