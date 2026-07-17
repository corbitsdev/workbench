import fs from "node:fs";
import path from "node:path";
import { type } from "arktype";
import type { ToolCatalog } from "./schema";
import { catalogManagedNames } from "./search";

export const EXPOSURE_STATE_FILE = "tool-exposure.json";

export const PersistedExposureSchema = type({ exposed: "string[]" });
export type PersistedExposure = typeof PersistedExposureSchema.infer;

/**
 * Read the durable exposure set persisted under `dir`. A missing file is the
 * normal first-run case and reads as empty; a present-but-invalid file is a
 * corrupt durable copy and must surface, not be silently discarded.
 */
export async function readPersistedExposure(dir: string): Promise<string[]> {
  const file = path.join(dir, EXPOSURE_STATE_FILE);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Corrupt exposure state in ${file}: not valid JSON (${String(err)})`,
    );
  }
  const validated = PersistedExposureSchema(parsed);
  if (validated instanceof type.errors) {
    throw new Error(`Corrupt exposure state in ${file}: ${validated.summary}`);
  }
  return validated.exposed;
}

/** Atomically persist the exposure set under `dir` (tmp write + rename). */
export async function persistExposure(
  dir: string,
  exposed: ReadonlySet<string>,
): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, EXPOSURE_STATE_FILE);
  const tmp = `${file}.tmp`;
  const payload: PersistedExposure = { exposed: [...exposed].sort() };
  await fs.promises.writeFile(tmp, JSON.stringify(payload));
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
