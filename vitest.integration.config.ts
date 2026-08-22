import { defineConfig } from 'vitest/config';

// Integration tests: Neo4j testcontainer + full HTTP surface. Requires Docker.
//
// These must run strictly sequentially in one process: every spec DETACH
// DELETEs the shared testcontainer graph, so parallel files wipe each other.
// Vitest 4 removed `poolOptions` (the old `forks: { singleFork: true }`) and
// moved the knobs top-level — and it only *warns*, so a silent regression here
// looks like 100 assertion failures rather than a config error.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    globalSetup: ['tests/integration/setup.ts'],
  },
});
