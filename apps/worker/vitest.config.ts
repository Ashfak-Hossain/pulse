import { defineConfig } from 'vitest/config';

// Unit tests sit next to the code they test (src/**/*.spec.ts) and need no services
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
});
