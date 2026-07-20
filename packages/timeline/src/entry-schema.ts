import { type } from "arktype";

export const timelineEntryKinds = [
  "session",
  "message",
  "inference_turn",
  "tool_call",
  "workflow_run",
  "artifact",
  "artifact_version",
  "upload",
  "memory",
  "output_feedback",
  "grant",
  "credential",
] as const;

export type TimelineEntryKind = (typeof timelineEntryKinds)[number];

const base = {
  id: "string",
  sourceTable: "string",
  timestamp: "string.date.iso",
  summary: "string | null",
} as const;

// One variant per kind: the UI switches on `kind`; the SQL never invents
// display strings — `summary` is always a raw data projection.
export const TimelineEntrySchema = type({ kind: "'session'", ...base })
  .or({ kind: "'message'", ...base })
  .or({ kind: "'inference_turn'", ...base })
  .or({ kind: "'tool_call'", ...base })
  .or({ kind: "'workflow_run'", ...base })
  .or({ kind: "'artifact'", ...base })
  .or({ kind: "'artifact_version'", ...base })
  .or({ kind: "'upload'", ...base })
  .or({ kind: "'memory'", ...base })
  .or({ kind: "'output_feedback'", ...base })
  .or({ kind: "'grant'", ...base })
  .or({ kind: "'credential'", ...base });

export type TimelineEntry = typeof TimelineEntrySchema.infer;
