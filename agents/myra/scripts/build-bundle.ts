// Bundles Myra's workflow entry into one self-contained ESM module.
//
// The sidecar's source deploy evaluates the pushed `workflow.js` as a frozen
// closure with nothing to resolve bare imports against, so every `@intx/*`
// and tool-package import has to be inlined here.
import { mkdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");

export const MYRA_BUNDLE_FILE = "workflow-bundle.js";
export const MYRA_BUNDLE_PATH = path.join(packageRoot, "bundle", MYRA_BUNDLE_FILE);

/** The name the bundle exports, which the rendered entry calls. */
export const MYRA_BUNDLE_BUILD_EXPORT = "buildMyraWorkflow";

export async function buildMyraBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [path.join(packageRoot, "src", "index.ts")],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    throw: true,
  });
  const artifact = built.outputs[0];
  if (artifact === undefined) {
    throw new Error("buildMyraBundle: Bun.build produced no output");
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
      `buildMyraBundle: bundle still carries unresolved imports: ${[...new Set(unresolved)].join(", ")}`,
    );
  }
  return code;
}

export async function writeMyraBundle(): Promise<string> {
  const code = await buildMyraBundle();
  await mkdir(path.dirname(MYRA_BUNDLE_PATH), { recursive: true });
  await writeFile(MYRA_BUNDLE_PATH, code);
  return MYRA_BUNDLE_PATH;
}

if (import.meta.main) {
  const written = await writeMyraBundle();
  console.log(`[myra] bundled workflow entry -> ${written}`);
}
