import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  EmbeddedWorkflowDefSchema,
  embeddedWorkflowDefsDir,
} from "./workflow-defs-embedded";

let cached: Promise<Map<string, string>> | undefined;

export async function loadWorkflowKindLabels(): Promise<Map<string, string>> {
  if (cached === undefined) {
    cached = readWorkflowKindLabels();
  }
  return cached;
}

async function readWorkflowKindLabels(): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const dir = embeddedWorkflowDefsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return labels;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, file), "utf8"));
      const parsed = EmbeddedWorkflowDefSchema(raw);
      if (parsed instanceof type.errors) continue;
      const label =
        parsed.label !== undefined && parsed.label.trim() !== ""
          ? parsed.label.trim()
          : parsed.kind;
      labels.set(parsed.kind, label);
    } catch {
      // skip malformed def
    }
  }
  return labels;
}