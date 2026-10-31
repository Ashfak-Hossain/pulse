// Flat config: an array of config objects, applied in order (later ones win).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // apps/web gets Next.js's own ESLint rules later
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', 'apps/web/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Finds the nearest tsconfig.json for each file, so typed rules know the types
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Root config files (this one, commitlint…) are plain JS in no tsconfig: lint them without types
    files: ['*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The test database helper loads a dev-only dependency: test code may use it, app code never
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', 'packages/db/src/testing.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@pulse/db/testing', message: 'Test code only (test/ or *.spec.ts).' }] },
      ],
    },
  },
  // Last, so it switches off every rule that would fight Prettier's formatting
  prettier,
);
