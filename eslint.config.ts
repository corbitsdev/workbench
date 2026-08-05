// @ts-check

import * as eslint from "@eslint/js";
import * as tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "coverage/**",
    "tmp/**",
    "vendor/**",
    ".claude/**",
    ".worktrees/**",
    ".agent-state/**",
    "dispatch/**",
    "specs/**",
    "plans/**",
  ]),
  {
    linterOptions: {
      // Zero-suppressions policy: inline disables are not permitted at all.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true },
      ],
      // Stylistic only, no bug-catching value; arktype mixes type/interface
      // deliberately.
      "@typescript-eslint/consistent-type-definitions": 0,
      "@typescript-eslint/no-empty-function": 0,
      "@typescript-eslint/no-empty-object-type": 0,
      "@typescript-eslint/no-invalid-void-type": 0,
      "@typescript-eslint/no-inferrable-types": 0,
      "@typescript-eslint/consistent-indexed-object-style": 0,
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
    files: ["scripts/**/*.ts"],
    rules: { "no-console": 0 },
  },
);
