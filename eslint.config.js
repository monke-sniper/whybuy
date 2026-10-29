import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.wxt/**',
      '.output/**',
      'coverage/**',
      'public/**',
      'scripts/fixtures/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      // console.log goes through lib/utils/log.ts so every extension log is
      // prefixed and can be silenced in one place.
      'no-console': ['warn', { allow: ['warn', 'error', 'info', 'debug'] }],
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      'no-var': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    files: ['lib/utils/log.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // Puppeteer harnesses: they page-evaluate against a real Chrome, so the
    // extension globals are only present at runtime and `console` is the test
    // output channel.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.webextensions, __whybuyCart: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    files: ['**/*.cjs', '*.config.ts'],
    rules: { 'no-console': 'off' },
  },
)
