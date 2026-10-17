import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'dist/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, chrome: 'readonly' },
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      // Text from Reddit must never be parsed as HTML. Build DOM nodes and use textContent.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent or DOM methods; Reddit content is untrusted.' },
        { property: 'outerHTML', message: 'Use textContent or DOM methods; Reddit content is untrusted.' },
        { property: 'insertAdjacentHTML', message: 'Use DOM methods; Reddit content is untrusted.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='write'][callee.object.name='document']", message: 'document.write is not allowed.' },
      ],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },
];
