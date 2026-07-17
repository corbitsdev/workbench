import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import type { ToolCatalog } from "./schema";
import { catalogManagedNames } from "./search";

export const EXPOSURE_STATE_FILE = "tool-exposure.json";

export const PersistedExposureSchema = type({ exposed: "string[]" });
export type PersistedExposure = typeof PersistedExposureSchema.infer;

export type PersistedExposureRead = {
  exposed: string[];
  /** Human-readable reason when a present file could not be parsed/validated. */
  corrupt?: string;
};

/**
 * Read the durable exposure set persisted under `dir`. A missing file is the
 * normal first-run case and reads as empty. A present-but-invalid file also
 * reads as empty, with `corrupt` set for the caller to report: exposure is
 * advisory advertisement state — losing it costs the model one load_tools
 * call, whereas throwing here would permanently fail every subsequent harness
 * build for the agent (unlike conversation-state, where corrupt-loss is a
 * correctness failure).
 */
export async function readPersistedExposure(
  dir: string,
): Promise<PersistedExposureRead> {
  const file = path.join(dir, EXPOSURE_STATE_FILE);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exposed: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      exposed: [],
      corrupt: `Corrupt exposure state in ${file}: not valid JSON (${String(err)})`,
    };
  }
  const validated = PersistedExposureSchema(parsed);
  if (validated instanceof type.errors) {
    return {
      exposed: [],
      corrupt: `Corrupt exposure state in ${file}: ${validated.summary}`,
    };
  }
  return { exposed: validated.exposed };
}

let tmpCounter = 0;

/**
 * Atomically persist the exposure set under `dir`: unique tmp write, fsync,
 * rename. The fsync before rename prevents a power loss from leaving a
 * zero-length file behind the rename; the unique tmp name prevents two
 * fire-and-forget persists from racing writeFile/rename on the same path.
 */
export async function persistExposure(
  dir: string,
  exposed: ReadonlySet<string>,
): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, EXPOSURE_STATE_FILE);
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  const payload: PersistedExposure = { exposed: [...exposed].sort() };
  const handle = await fs.promises.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify(payload));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmp, file);
}

/**
 * Narrow persisted names to those the current catalog still manages, so a
 * retired or since-degranted tool is never rehydrated into the advertised set.
 */
export function filterExposureToCatalog(
  names: readonly string[],
  catalog: ToolCatalog,
): string[] {
  const managed = catalogManagedNames(catalog);
  return names.filter((name) => managed.has(name));
}
