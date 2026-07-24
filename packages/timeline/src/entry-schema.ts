import { type } from "arktype";

export const timelineEntryKinds = [
  "session",
  "message",
  "inference_turn",
  "tool_call",
  "compaction",
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
export const TimelineEntrySchema = type.or(
  { kind: "'session'", ...base },
  { kind: "'message'", ...base },
  { kind: "'inference_turn'", ...base },
  { kind: "'tool_call'", ...base },
  { kind: "'compaction'", ...base },
  { kind: "'workflow_run'", ...base },
  { kind: "'artifact'", ...base },
  { kind: "'artifact_version'", ...base },
  { kind: "'upload'", ...base },
  { kind: "'memory'", ...base },
  { kind: "'output_feedback'", ...base },
  { kind: "'grant'", ...base },
  { kind: "'credential'", ...base },
);

export type TimelineEntry = typeof TimelineEntrySchema.infer;
