import { expect, test } from "bun:test";

import { WorkflowAuthorError } from "./errors";
import {
  MAX_SOURCE_FILE_BYTES,
  MAX_SOURCE_TREE_BYTES,
  validateWorkflowSourceTree,
} from "./source-tree";

const MANIFEST = JSON.stringify({
  name: "daily-digest",
  version: "0.0.1",
  type: "module",
  interchange: { workflow: "./workflow.ts" },
});

const ENTRY =
  'import { defineWorkflow } from "@intx/workflow";\nexport default defineWorkflow({});\n';

function validTree(): Record<string, string> {
  return { "package.json": MANIFEST, "workflow.ts": ENTRY };
}

function rejection(files: Record<string, string>): WorkflowAuthorError {
  try {
    validateWorkflowSourceTree(files);
  } catch (err) {
    if (err instanceof WorkflowAuthorError) return err;
    throw err;
  }
  throw new Error("expected validateWorkflowSourceTree to reject");
}

test("accepts a minimal package and resolves the normalized entry", () => {
  const result = validateWorkflowSourceTree(validTree());
  expect(result.entry).toBe("workflow.ts");
});

test.each([
  ["../escape.ts", /\.\./],
  ["src/../../escape.ts", /\.\./],
  ["/abs.ts", /repo-relative/],
  ["src\\win.ts", /separators/],
  [".git/config", /\.git/],
  ["nested/.git/HEAD", /\.git/],
  ["", /empty/],
  ["src//double.ts", /empty segment/],
  ["trailing/", /empty segment/],
])("rejects the path %p", (path, message) => {
  const err = rejection({ ...validTree(), [path]: "x" });
  expect(err.reason).toBe("invalid");
  expect(err.message).toMatch(message);
});

test.each([
  ".env",
  ".env.local",
  "config/.env.production",
  "certs/server.pem",
  "keys/private.key",
  "id_rsa",
  ".ssh/id_rsa.pub",
  "bundle.p12",
])("rejects the secret-like file %p", (path) => {
  const err = rejection({ ...validTree(), [path]: "shh" });
  expect(err.message).toMatch(/looks like a secret/);
});

test("rejects a tree without package.json", () => {
  expect(rejection({ "workflow.ts": ENTRY }).message).toMatch(/package\.json/);
});

test("rejects a package.json that does not parse", () => {
  const err = rejection({ ...validTree(), "package.json": "{ nope" });
  expect(err.message).toMatch(/not valid JSON/);
});

test("rejects a package.json with no interchange.workflow entry", () => {
  const err = rejection({
    ...validTree(),
    "package.json": JSON.stringify({ name: "x", version: "0.0.1" }),
  });
  expect(err.message).toMatch(/interchange\.workflow/);
});

test("rejects an entry that escapes the package", () => {
  const err = rejection({
    ...validTree(),
    "package.json": JSON.stringify({
      name: "x",
      version: "0.0.1",
      interchange: { workflow: "../outside.ts" },
    }),
  });
  expect(err.message).toMatch(/escape/);
});

test("rejects an entry the tree does not carry", () => {
  const err = rejection({ "package.json": MANIFEST, "other.ts": ENTRY });
  expect(err.message).toMatch(/no file at "workflow\.ts"/);
});

test("rejects a single file over the per-file cap", () => {
  const err = rejection({
    ...validTree(),
    "big.ts": "x".repeat(MAX_SOURCE_FILE_BYTES + 1),
  });
  expect(err.message).toMatch(/per-file limit/);
});

test("rejects a tree whose total exceeds the tree cap even when every file is under the per-file cap", () => {
  const files = validTree();
  const chunk = "x".repeat(MAX_SOURCE_FILE_BYTES);
  for (let i = 0; i * MAX_SOURCE_FILE_BYTES <= MAX_SOURCE_TREE_BYTES; i++) {
    files[`chunk-${i}.ts`] = chunk;
  }
  expect(rejection(files).message).toMatch(/source tree totals/);
});
