import { defineConfig } from 'vitest/config';

// Integration tests: Neo4j testcontainer + full HTTP surface. Requires Docker.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ['tests/integration/setup.ts'],
  },
});
