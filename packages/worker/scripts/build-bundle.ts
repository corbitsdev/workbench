// Bundles The worker's workflow entry, and the directors entry beside it, into
// self-contained ESM modules.
//
// The sidecar's source deploy evaluates the pushed `workflow.js` and
// `directors.js` as frozen closures with nothing to resolve bare imports
// against, so every `@intx/*`, `@corbits/*` and tool-package import has to be
// inlined here.
import { mkdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");

export const WORKER_BUNDLE_FILE = "workflow-bundle.js";
export const WORKER_BUNDLE_PATH = path.join(packageRoot, "bundle", WORKER_BUNDLE_FILE);
export const WORKER_DIRECTORS_BUNDLE_FILE = "directors-bundle.js";
export const WORKER_DIRECTORS_BUNDLE_PATH = path.join(
  packageRoot,
  "bundle",
  WORKER_DIRECTORS_BUNDLE_FILE,
);

/** The name the bundle exports, which the rendered entry calls. */
export const WORKER_BUNDLE_BUILD_EXPORT = "buildWorkerWorkflow";

async function bundleEntry(entry: string): Promise<string> {
  const built = await Bun.build({
    entrypoints: [path.join(packageRoot, "src", entry)],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    throw: true,
  });
  const artifact = built.outputs[0];
  if (artifact === undefined) {
    throw new Error(`buildWorkerBundle: Bun.build produced no output for ${entry}`);
  }
  const code = await artifact.text();
  // A package specifier left in the bundle is a silent runtime failure inside
  // the sidecar's closure, so it fails here instead. Node builtins stay
  // external on purpose: the closure is evaluated by bun, which resolves them.
  const unresolved = [...code.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s*"([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => !specifier.startsWith(".") && !isBuiltin(specifier));
  if (unresolved.length > 0) {
    throw new Error(
      `buildWorkerBundle: ${entry} bundle still carries unresolved imports: ${[...new Set(unresolved)].join(", ")}`,
    );
  }
  return code;
}

export async function buildWorkerBundle(): Promise<string> {
  return bundleEntry("index.ts");
}

export async function buildWorkerDirectorsBundle(): Promise<string> {
  return bundleEntry("directors.ts");
}

export async function writeWorkerBundle(): Promise<string[]> {
  const [workflow, directors] = await Promise.all([
    buildWorkerBundle(),
    buildWorkerDirectorsBundle(),
  ]);
  await mkdir(path.dirname(WORKER_BUNDLE_PATH), { recursive: true });
  await writeFile(WORKER_BUNDLE_PATH, workflow);
  await writeFile(WORKER_DIRECTORS_BUNDLE_PATH, directors);
  return [WORKER_BUNDLE_PATH, WORKER_DIRECTORS_BUNDLE_PATH];
}

if (import.meta.main) {
  const written = await writeWorkerBundle();
  console.log(`[worker] bundled entries -> ${written.join(", ")}`);
}
