import tseslint from 'typescript-eslint';
import { noTimeAxisRules, noClockReadRules } from './eslint-rules/no-time-axis.mjs';

// Covers packages/**. apps/web has its own eslint.config.mjs (next needs its
// own plugin wiring) — root `npm run lint` runs both.
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'apps/**',
      'packages/db/prisma/migrations/**',
      // Generated Prisma client — not ours to lint, and gitignored.
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    rules: {
      ...noTimeAxisRules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Strictest tier: the domain engine additionally may not read the clock.
    files: ['packages/core/**/*.ts'],
    rules: { ...noClockReadRules },
  },
);
