module.exports = [
  {
    ignores: ['dist/**', 'shabbat_weekly.rewrite.ts'],
  },
  ...require('gts'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
