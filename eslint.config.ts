// @ts-check

import * as eslint from "@eslint/js";
import * as tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  globalIgnores(["**/dist/**", "tmp/**", "interchange/**", "temporary/**"]),
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
      // Intentionally off — stylistic only, no bug-catching value; arktype
      // mixes type/interface deliberately. Permanent.
      "@typescript-eslint/consistent-type-definitions": 0,
      "@typescript-eslint/no-empty-function": 0,
      "@typescript-eslint/no-empty-object-type": 0,
      "@typescript-eslint/no-invalid-void-type": 0,
      "@typescript-eslint/no-dynamic-delete": 0,
      "@typescript-eslint/no-inferrable-types": 0,
      "@typescript-eslint/consistent-indexed-object-style": 0,
      // Temporarily off — pre-existing debt newly surfaced by typescript-eslint
      // strict (oxlint never enforced these). These three catch real type-safety
      // smells; re-enable and fix incrementally. Tracked in CL-2353.
      "@typescript-eslint/no-unsafe-type-assertion": 0,
      "@typescript-eslint/no-non-null-assertion": 0,
      "@typescript-eslint/no-explicit-any": 0,
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='useParams'] Property[key.name='strict'][value.value=false]",
          message:
            "Do not use useParams({ strict: false }). Use useParams({ from: '/path/$param' }) for typed route params.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["scripts/**/*.ts", "apps/hub/bin/**/*.ts"],
    rules: { "no-console": 0 },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-require-imports": 0, "prefer-const": 0 },
  },
  {
    files: [
      "apps/web/src/lib/logger.ts",
      "apps/web/server.ts",
      "packages/sentry/src/sentry.ts",
      "packages/openapi-arktype/src/cli.ts",
    ],
    rules: { "no-console": 0 },
  },
);
