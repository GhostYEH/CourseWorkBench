import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import js from '@eslint/js';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/.next*/**',
      '.task-cache/**',
      'apps/desktop/src/preload.cjs',
    ],
  },
  {
    files: ['apps/desktop/src/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: Object.fromEntries(
        [
          'require',
          'module',
          'exports',
          '__dirname',
          '__filename',
          'process',
          'console',
          'Buffer',
          'URL',
          'URLSearchParams',
          'AbortController',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'setImmediate',
          'clearImmediate',
          'fetch',
          'structuredClone',
          'global',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/preload.template.cjs'],
    languageOptions: { globals: { __IPC_CHANNELS__: 'readonly' } },
  },
  {
    files: [
      'scripts/quality/**/*.mjs',
      'scripts/format.mjs',
      'scripts/check-code-quality.mjs',
      'scripts/check-public-boundaries.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: js.configs.recommended.rules,
  },
  {
    files: [
      'apps/learning/{app,components,lib}/**/*.{ts,tsx}',
      'apps/collab-service/src/**/*.ts',
      'packages/**/src/**/*.ts',
    ],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ['apps/learning/{app,components,lib}/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
