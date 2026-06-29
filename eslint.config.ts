// @ts-check

import * as eslint from "@eslint/js";
import * as tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  // `packages/workflow-host` is a verbatim vendor of `@intx/workflow-host`
  // (WORKBENCH-LOCAL CL-2535 edits aside); lint it as vendored upstream code,
  // same as `interchange/**`, so its own eslint-disable directives don't trip
  // our differing rule set.
  globalIgnores([
    "**/dist/**",
    "tmp/**",
    "interchange/**",
    "temporary/**",
    "packages/workflow-host/**",
  ]),
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
  {
    // Workflow run panels must route screen + stepper state through the shared
    // @workbench/ui run-state helpers (activeDisplayStep / buildRunStepperSteps /
    // displayStepPhase), never a hand-rolled "first step whose phase is not
    // completed" loop. That idiom rewinds the panel to an earlier screen mid-run
    // when an awaitSignal gate's StepCompleted is absent from the synthesized
    // record (projection lag / unresolved output ref). See CL-2506.
    files: ["workflows/**/src/ui.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ForOfStatement IfStatement[test.operator='!=='][test.right.value='completed']",
          message:
            "Don't hand-roll active-step routing by looping the step order and returning the first step whose phase !== 'completed' — it rewinds the panel mid-run when a gate's output is missing. Build a DisplayStep[] and use activeDisplayStep / buildRunStepperSteps from @workbench/ui (CL-2506).",
        },
        {
          selector:
            "CallExpression[callee.property.name='some'] BinaryExpression[operator='!=='][right.value='completed']",
          message:
            "Don't derive the active display group via `.some(id => phaseFor(...) !== 'completed')` — it rewinds the panel mid-run when a gate's output is missing. Build a DisplayStep[] (clustered stepIds) and use activeDisplayStep / buildRunStepperSteps from @workbench/ui (CL-2506).",
        },
        {
          selector:
            "IfStatement[test.operator='!=='][test.right.value='completed'] ReturnStatement[argument.type='Literal']",
          message:
            "Don't hand-roll active-step routing with `if (phaseFor(step) !== 'completed') return '<stepKey>'` — it rewinds the panel mid-run when a gate's output is missing. Build a DisplayStep[] and use activeDisplayStep / buildRunStepperSteps from @workbench/ui (CL-2506).",
        },
      ],
    },
  },
);
