// The trust-boundary validator for a workflow source tree an agent hands
// the authoring registry. The substrate's `workflowKindHandler.validatePush`
// already checks the manifest's shape once bytes are staged; this module
// runs BEFORE any write so a traversal path, a secret-looking filename, an
// oversize tree, or an entry that names a file the tree does not carry is
// rejected without touching git — and with a message the model can act on.
import path from "node:path";
import { type } from "arktype";
import { isContainedEntryPath, PackageJSON } from "@intx/types/package-json";

import { WorkflowAuthorError } from "./errors";

export const MAX_SOURCE_FILE_BYTES = 256 * 1024;
export const MAX_SOURCE_TREE_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_FILE_COUNT = 200;
export const PACKAGE_JSON_PATH = "package.json";

const SECRET_LIKE_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /\.p12$/,
  /\.pfx$/,
  /\.ppk$/,
  /^credentials\.json$/,
  /^service-account.*\.json$/,
  /^\.npmrc$/,
  /^\.netrc$/,
];

const FORBIDDEN_SEGMENTS = new Set([".", "..", ".git"]);

export type ValidatedWorkflowSourceTree = {
  readonly files: Readonly<Record<string, string>>;
  /** The `interchange.workflow` entry, normalized to a repo-relative path
   * (no leading `./`). */
  readonly entry: string;
};

function invalid(message: string): WorkflowAuthorError {
  return new WorkflowAuthorError("invalid", message);
}

/** Normalizes `./workflow.ts` (or `src/../workflow.ts`) to the
 * repo-relative key the tree is addressed by. */
export function normalizeEntryPath(entry: string): string {
  return path.posix.normalize(entry);
}

export function assertRepoRelativePath(path: string): void {
  if (path === "") throw invalid("a file path must not be empty");
  if (path.includes("\\")) {
    throw invalid(`file path ${JSON.stringify(path)} must use "/" separators`);
  }
  if (path.startsWith("/")) {
    throw invalid(`file path ${JSON.stringify(path)} must be repo-relative`);
  }
  if (path.includes("\0")) {
    throw invalid(`file path ${JSON.stringify(path)} contains a NUL byte`);
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw invalid(
        `file path ${JSON.stringify(path)} has an empty segment (trailing or doubled "/")`,
      );
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      throw invalid(
        `file path ${JSON.stringify(path)} may not contain a ${JSON.stringify(segment)} segment`,
      );
    }
  }
  const basename = segments[segments.length - 1] ?? "";
  if (SECRET_LIKE_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))) {
    throw invalid(
      `file ${JSON.stringify(path)} looks like a secret (.env*, *.pem, *.key, id_rsa*, *.p12) and cannot be committed to a workflow asset`,
    );
  }
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function parsePackageJson(raw: string): {
  readonly interchange?: { readonly workflow?: string };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw invalid(
      `${PACKAGE_JSON_PATH} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const manifest = PackageJSON(parsed);
  if (manifest instanceof type.errors) {
    throw invalid(
      `${PACKAGE_JSON_PATH} failed validation: ${manifest.summary}`,
    );
  }
  return manifest;
}

/**
 * Validates a whole source tree and returns it with the resolved entry.
 * Throws `WorkflowAuthorError("invalid", ...)` naming the first violation.
 */
export function validateWorkflowSourceTree(
  files: Readonly<Record<string, string>>,
): ValidatedWorkflowSourceTree {
  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw invalid("a workflow source tree needs at least one file");
  }
  if (paths.length > MAX_SOURCE_FILE_COUNT) {
    throw invalid(
      `a workflow source tree may carry at most ${MAX_SOURCE_FILE_COUNT} files (got ${paths.length})`,
    );
  }

  let totalBytes = 0;
  for (const path of paths) {
    assertRepoRelativePath(path);
    const bytes = utf8ByteLength(files[path] ?? "");
    if (bytes > MAX_SOURCE_FILE_BYTES) {
      throw invalid(
        `file ${JSON.stringify(path)} is ${bytes} bytes; the per-file limit is ${MAX_SOURCE_FILE_BYTES}`,
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_SOURCE_TREE_BYTES) {
    throw invalid(
      `the source tree totals ${totalBytes} bytes; the limit is ${MAX_SOURCE_TREE_BYTES}`,
    );
  }

  const manifestSource = files[PACKAGE_JSON_PATH];
  if (manifestSource === undefined) {
    throw invalid(
      `a workflow source tree must carry a top-level ${PACKAGE_JSON_PATH} declaring "interchange.workflow"`,
    );
  }
  const manifest = parsePackageJson(manifestSource);
  const declaredEntry = manifest.interchange?.workflow;
  if (declaredEntry === undefined || declaredEntry === "") {
    throw invalid(
      `${PACKAGE_JSON_PATH} must declare a non-empty "interchange.workflow" entry`,
    );
  }
  if (!isContainedEntryPath(declaredEntry)) {
    throw invalid(
      `"interchange.workflow" entry ${JSON.stringify(declaredEntry)} must be a package-relative path that does not escape the package`,
    );
  }
  const entry = normalizeEntryPath(declaredEntry);
  if (!(entry in files)) {
    throw invalid(
      `"interchange.workflow" names ${JSON.stringify(declaredEntry)} but the tree has no file at ${JSON.stringify(entry)}`,
    );
  }

  return { files, entry };
}
