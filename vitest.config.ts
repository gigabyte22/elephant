import { defineConfig } from 'vitest/config';

// Default: unit tests only (no Docker).
// `pnpm test:integration` switches to vitest.integration.config.ts which adds
// the Neo4j testcontainer setup and includes tests/integration/.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    pool: 'forks',
  },
});
