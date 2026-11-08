// Flat config: an array of config objects, applied in order (later ones win).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // apps/web gets Next.js's own ESLint rules later. notes/ is private and git-ignored, so CI
    // never sees it
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', 'apps/web/**', 'notes/**'],
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
    // Root config files (this one, commitlint…) and Claude's helper scripts are plain JS in no
    // tsconfig: lint them without types
    files: ['*.js', '.claude/tools/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
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
  {
    // High ceilings that catch a real mess, not targets (docs/code-structure.md). Test code is
    // left out: a test file grows with its cases and is not read the same way
    files: ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts', 'packages/db/src/testing.ts'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 40],
      'max-depth': ['error', 10],
      'max-params': ['error', 10],
    },
  },
  {
    // CLAUDE.md rule 5: the algorithm packages take clocks and seeds as parameters. Imports are
    // checked by dependency-cruiser (.dependency-cruiser.js)
    files: [
      'packages/matching/src/**/*.ts',
      'packages/money/src/**/*.ts',
      'packages/geo/src/**/*.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Take the time as a parameter.' },
        { object: 'Math', property: 'random', message: 'Take a seeded generator as a parameter.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Pure package: no network.' },
        { name: 'process', message: 'Pure package: take settings as parameters.' },
        { name: 'crypto', message: 'Take a seeded generator as a parameter.' },
        { name: 'performance', message: 'Take the time as a parameter.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Take the time as a parameter.',
        },
      ],
    },
  },
  // Last, so it switches off every rule that would fight Prettier's formatting
  prettier,
);
