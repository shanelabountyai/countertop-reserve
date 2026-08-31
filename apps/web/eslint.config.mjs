import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { noTimeAxisRules } from "../../eslint-rules/no-time-axis.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // CLAUDE.md "Time rules": banned repo-wide, UI included. The restaurant's
  // timezone is a config value; the browser's is not the restaurant's.
  { rules: { ...noTimeAxisRules } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
