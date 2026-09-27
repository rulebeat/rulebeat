import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // eslint-plugin-react's version auto-detect calls context.getFilename(), which
    // ESLint 10 removed. Naming the version skips the detect path entirely.
    settings: { react: { version: "19.3" } },
    rules: {
      // A leading underscore is the house convention for "kept for a uniform call
      // signature, intentionally unused" (see lib/notifications/format.ts's per-channel
      // payload builders) — never a mistake worth flagging.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
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
