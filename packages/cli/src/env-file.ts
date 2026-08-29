// Upsert a KEY=value assignment in a dotenv file. `workbench setup`
// uses this to persist OPERATOR_TENANT_ID into the repository `.env`
// after it creates the org tenant, so first-login provision can parent
// personal benches under it.

import { readFile, writeFile } from "node:fs/promises";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace or append `key=value` in dotenv `contents`. */
export function upsertEnvAssignment(
  contents: string,
  key: string,
  value: string,
): string {
  const line = `${key}=${value}`;
  const escaped = escapeRegExp(key);
  const uncommented = new RegExp(`^[ \\t]*${escaped}=.*$`, "m");
  if (uncommented.test(contents)) {
    return contents.replace(uncommented, line);
  }
  const commented = new RegExp(`^#[ \\t]*${escaped}=.*$`, "m");
  if (commented.test(contents)) {
    return contents.replace(commented, line);
  }
  if (contents === "") return `${line}\n`;
  const prefix = contents.endsWith("\n") ? contents : `${contents}\n`;
  return `${prefix}${line}\n`;
}

/** Read `envPath` (or start empty if missing), upsert, and write back. */
export async function persistEnvVar(
  envPath: string,
  key: string,
  value: string,
): Promise<void> {
  let contents = "";
  try {
    contents = await readFile(envPath, "utf8");
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      throw cause;
    }
  }
  const next = upsertEnvAssignment(contents, key, value);
  if (next === contents) return;
  await writeFile(envPath, next, "utf8");
}
