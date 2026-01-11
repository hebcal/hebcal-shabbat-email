let customConfig = [
  {
    ignores: ['dist/**', 'shabbat_weekly.rewrite.ts'],
  },
];
let hasIgnoresFile = false;
try {
  require.resolve('./eslint.ignores.js');
  hasIgnoresFile = true;
} catch {
  // eslint.ignores.js doesn't exist
}

if (hasIgnoresFile) {
  const ignores = require('./eslint.ignores.js');
  customConfig.push({ignores});
}

const tseslint = require('typescript-eslint');

module.exports = [
  ...customConfig,
  ...require('gts'),
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
