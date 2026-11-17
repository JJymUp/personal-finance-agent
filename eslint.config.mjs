// @ts-check
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import vueParser from 'vue-eslint-parser';
import vuePlugin from 'eslint-plugin-vue';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/dist-h5/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
      'scripts/**',
      'e2e/**',
      'vitest.config.ts',
      'playwright.config.ts',
      'apps/web/vite.config.ts',
    ],
  },

  // TypeScript files in all packages
  {
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-debugger': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
    },
  },

  // Vue SFC files in apps/web
  {
    files: ['apps/web/src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      vue: vuePlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-debugger': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'vue/multi-word-component-names': 'off',
    },
  },

  // Module boundary: apps/server MUST NOT import from apps/web
  {
    files: ['apps/server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '../../web/**'],
              message: 'Server code must not import from apps/web. Use @maggot/contracts for shared types.',
            },
          ],
        },
      ],
    },
  },

  // Module boundary: apps/web MUST NOT import from apps/server
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.vue'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/server/**', '../../server/**'],
              message: 'Web code must not import from apps/server. Communicate via /api HTTP + @maggot/contracts.',
            },
          ],
        },
      ],
    },
  },

  // Module boundary: packages/contracts MUST NOT import from apps/*
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/**'],
              message: 'packages/contracts must not import from apps/. Keep it standalone.',
            },
          ],
        },
      ],
    },
  },

  // Test files: relax some rules
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'off',
      'no-restricted-imports': 'off',
    },
  },
];

export default config;
