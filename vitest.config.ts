import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx files are the options-page component tests; they opt into jsdom
    // with a per-file `@vitest-environment` docblock.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
