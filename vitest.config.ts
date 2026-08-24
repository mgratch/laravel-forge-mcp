import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Generated code mirrors the spec and is covered by contract tests;
      // index.ts is process bootstrap (stdio + exit codes), exercised by the
      // build rather than by unit tests.
      exclude: ['src/generated/**', 'src/index.ts', 'src/tools/types.ts'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
